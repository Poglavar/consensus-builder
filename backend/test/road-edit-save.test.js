// A road has two edit actions, Edit geometry (node handles) and Edit cross-section, and both save
// directly through road-drawing.js updateLocalCorridorGeometry: one's own local road in place (same
// id), a published or minted road as a counterproposal, and a refused save is rolled back and its
// reason shown in the still-open editor. There is no hand-off to the drawing tool any more (the
// cross-section editor used to reopen the road "as a drawing" when the direct edit failed).
// The real functions are lifted from the classic scripts and run against stubs of their collaborators.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const lineage = require('../../frontend/js/proposals/lineage.js');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const drawingSource = read('../../frontend/js/road-drawing.js');
const editorSource = read('../../frontend/js/corridor-editor.js');
const clone = value => JSON.parse(JSON.stringify(value));

function extracted(source, name) {
    const ast = parse(source, { sourceType: 'script', errorRecovery: true });
    const declaration = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === name);
    expect(declaration, `${name} declaration exists`).toBeTruthy();
    return source.slice(declaration.start, declaration.end);
}

function loadFunction(source, name, globals) {
    const context = vm.createContext({ ...globals, JSON, Object, Array, Set, Map, String, Error, Promise, console });
    vm.runInContext(`${extracted(source, name)}\nthis.__fn = ${name};`, context);
    return context.__fn;
}

describe('runLocalCorridorGeometryUpdate: in place for a local road, a counterproposal for a published one', () => {
    const road = (id, extra = {}) => ({
        proposalId: id,
        title: 'Main street',
        applied: true,
        roadProposal: { definition: { segments: [[{ lat: 0, lng: 0 }, { lat: 0, lng: 10 }]], segmentIds: ['s1'], polygon: { type: 'Polygon' } } },
        ...extra
    });
    // The edit: the road now runs to lng 12.
    const extend = definition => { definition.segments = [[{ lat: 0, lng: 0 }, { lat: 0, lng: 12 }]]; };

    function harness(source) {
        const records = new Map([[source.proposalId, source]]);
        const afterCommit = [];
        const store = {
            getProposal: id => records.get(String(id)) || null,
            findProposalByIdOrHash: id => records.get(String(id)) || null,
            addProposal: vi.fn(),
            _indexProposal: vi.fn(),
            save: vi.fn()
        };
        const mutation = { proposals: store, afterCommit: fn => afterCommit.push(fn) };
        const ProposalManager = {
            createCorridorProposalAtomically: vi.fn(async () => ({ ok: true, proposalId: 'fork-1' })),
            rematerializeCorridorScope: vi.fn(async () => ({ ok: true })),
            _refreshUIAfterProposalChange: vi.fn()
        };
        const writeRoadDefinition = vi.fn((record, definition) => { record.roadProposal.definition = clone(definition); });
        const run = loadFunction(drawingSource, 'runLocalCorridorGeometryUpdate', {
            window: { ProposalLineage: lineage, ProposalSelection: { is: () => true }, __formationEdit: null },
            ProposalManager,
            proposalStorage: store,
            cloneRoadValue: clone,
            getProposalKey: record => record.proposalId,
            isProposalApplied: record => record.applied === true,
            setProposalApplied: (record, applied) => { record.applied = applied; },
            corridorCenterlineOf: definition => definition.segments || [],
            rekeyMovedTunnelRecords: (_before, _after, tunnels) => tunnels || [],
            retainLiveCorridorTunnelRecords: (_segments, tunnels) => tunnels,
            retainLiveGradeSeparations: (_segments, separations) => separations,
            normalizeCorridorGraph: () => {},
            corridorProtectedEdgeKeySet: () => new Set(),
            rebuildRoadDefinitionFootprint: definition => { definition.polygon = { type: 'Polygon' }; return definition.polygon; },
            makeFreshRoadSnapshot: (record, definition, options) => {
                const fork = clone(record);
                ['proposalId', 'serverProposalId', 'lifecycleStatus'].forEach(key => delete fork[key]);
                fork.sourceProposalId = options.sourceProposalId;
                fork.roadProposal = { definition: clone(definition) };
                fork.applied = false;
                return fork;
            },
            writeRoadDefinition,
            declareParcelsUnderRoadLand: vi.fn(),
            translateRoadText: (_key, fallback) => fallback,
            updateStatus: vi.fn(),
            selectAndHighlightProposal: vi.fn(),
            clearProposalHighlights: vi.fn()
        });
        return { run, mutation, records, store, ProposalManager, writeRoadDefinition, afterCommit };
    }

    it('edits one\'s own local road in place: same id, no counterproposal', async () => {
        const source = road('own-road');
        const h = harness(source);

        const result = await h.run('own-road', extend, { _parcelMutation: h.mutation });

        expect(result).toBe('own-road');
        expect(h.ProposalManager.createCorridorProposalAtomically).not.toHaveBeenCalled();
        expect(source.roadProposal.definition.segments[0][1].lng).toBe(12);
        expect([...h.records.keys()]).toEqual(['own-road']);
    });

    it('saves an edit of a published road as a counterproposal and leaves the published road as it was', async () => {
        const source = road('published-road', { serverProposalId: '741' });
        const before = clone(source);
        const h = harness(source);

        const result = await h.run('published-road', extend, { _parcelMutation: h.mutation });

        expect(result).toBe('fork-1');
        expect(h.writeRoadDefinition).not.toHaveBeenCalled();
        expect(source).toEqual(before);
        expect(h.ProposalManager.createCorridorProposalAtomically).toHaveBeenCalledOnce();
        const [fork, options] = h.ProposalManager.createCorridorProposalAtomically.mock.calls[0];
        expect(fork.sourceProposalId).toBe('published-road');
        expect(fork.serverProposalId).toBeUndefined();
        expect(fork.roadProposal.definition.segments[0][1].lng).toBe(12);
        expect(options).toEqual({ _parcelMutation: h.mutation });
        // The counterproposal is selected, so the next edit lands on it.
        h.afterCommit.forEach(fn => fn());
    });

    it('refuses a road this city does not hold with a reason the editor can show', async () => {
        const h = harness(road('own-road'));
        await expect(h.run('elsewhere', extend, { _parcelMutation: h.mutation }))
            .rejects.toMatchObject({ userMessage: expect.stringContaining('Switch to the city it was created in') });
    });
});

describe('corridorEditorSave: the cross-section is saved from the open editor, never handed to another tool', () => {
    function harness(update) {
        const state = { mode: 'proposal', source: { proposalId: 'road-1', title: 'Main street' }, profile: { strips: [] }, saving: false };
        const context = {
            corridorEditorState: state,
            corridorEditorObstacleTimer: null,
            corridorEditorRunObstacleCheck: vi.fn(),
            corridorEditorProfileMutator: () => () => {},
            corridorEditorSaveRequest: () => ({}),
            corridorEditorTakeDisclosure: () => null,
            corridorEditorTakeMessage: () => '',
            __closeSpy: vi.fn(),
            corridorEditorRender: vi.fn(),
            corridorEditorI18n: (_key, fallback) => fallback,
            corridorProfileWidth: () => 6,
            getProposalKey: record => record.proposalId,
            updateStatus: vi.fn(),
            // The removed detour: reopening the road as a drawing must never be reached.
            copyCorridorIntoNewProposal: vi.fn(async () => true),
            reopenCorridorAsDrawing: vi.fn(async () => true),
            showProposalAlertMessage: vi.fn(),
            document: { querySelector: () => null },
            window: { updateLocalCorridorGeometry: vi.fn(update), showStyledConfirm: vi.fn() }
        };
        const ctx = vm.createContext({ ...context, console: { warn: vi.fn(), error: console.error } });
        vm.runInContext(`var corridorEditorState = this.corridorEditorState;
            function corridorEditorClose() { this.__closeSpy(); corridorEditorState = null; }
            ${extracted(editorSource, 'corridorEditorSave')}\nthis.__save = corridorEditorSave;`, ctx);
        return { save: ctx.__save, state, context: ctx };
    }

    it('closes the editor once a local road is saved in place', async () => {
        const h = harness(async () => 'road-1');
        await h.save();
        expect(h.context.__closeSpy).toHaveBeenCalledOnce();
        expect(h.context.updateStatus).toHaveBeenCalledWith('Cross-section updated.');
    });

    it('keeps the editor open with the reason and the user\'s changes when the save is refused', async () => {
        const h = harness(async (_key, _mutator, options) => {
            options.onFailure('The edited road scope could not be rematerialised from the cadastre.');
            return false;
        });
        await h.save();
        expect(h.context.__closeSpy).not.toHaveBeenCalled();
        expect(h.state.notice).toBe('The edited road scope could not be rematerialised from the cadastre.');
        expect(h.context.corridorEditorRender).toHaveBeenCalled();
        expect(h.context.copyCorridorIntoNewProposal).not.toHaveBeenCalled();
        expect(h.context.reopenCorridorAsDrawing).not.toHaveBeenCalled();
        expect(h.context.showProposalAlertMessage).not.toHaveBeenCalled();
    });

    it('closes the editor when a published road\'s edit was saved as a counterproposal', async () => {
        const h = harness(async () => 'fork-1');
        await h.save();
        expect(h.context.__closeSpy).toHaveBeenCalledOnce();
        expect(h.context.updateStatus).not.toHaveBeenCalledWith('Cross-section updated.');
    });
});
