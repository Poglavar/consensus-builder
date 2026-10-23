// A road has two edit actions, Edit geometry (node handles) and Edit cross-section, and both save
// directly through road-drawing.js updateLocalCorridorGeometry: one's own local road in place (same
// id), a published or minted road as a counterproposal, and a refused save is rolled back and its
// reason shown in the still-open editor. There is no hand-off to the drawing tool any more (the
// cross-section editor used to reopen the road "as a drawing" when the direct edit failed).
// runLocalCorridorGeometryUpdate is the real one of the loaded road-drawing.js
// (helpers/road-drawing-env.js) with the real proposals/lineage.js; corridorEditorSave is lifted
// from the classic corridor-editor.js and run against stubs of its collaborators.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import { loadRoadDrawing, at } from './helpers/road-drawing-env.js';

const require = createRequire(import.meta.url);
const lineage = require('../../frontend/js/proposals/lineage.js');
const Cid = require('../../frontend/js/cid.js');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const editorSource = read('../../frontend/js/corridor-editor.js');
const clone = value => JSON.parse(JSON.stringify(value));

function extracted(source, name) {
    const ast = parse(source, { sourceType: 'script', errorRecovery: true });
    const declaration = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === name);
    expect(declaration, `${name} declaration exists`).toBeTruthy();
    return source.slice(declaration.start, declaration.end);
}

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

describe('runLocalCorridorGeometryUpdate: in place for a local road, a counterproposal for a published one', () => {
    const road = (id, extra = {}) => ({
        proposalId: id,
        title: 'Main street',
        applied: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        roadProposal: { definition: { points: [[at(0, 0), at(100, 0)]], segmentIds: ['s1'], width: 7.5 } },
        ...extra
    });
    // The edit: the road now runs on to 150 m east.
    const extend = definition => { definition.points[0][1] = at(150, 0); };
    const endOf = record => record.roadProposal.definition.points[0][1];

    // Where a road was published (DesignSync): its CID at one index, which ProposalLineage.isPublished
    // takes as immutable.
    const PUBLISHED = { cid: Cid.cidOfObject({ schema: 'design/v1', title: 'Main street' }), publishedAt: '2026-10-21T12:00:00.000Z', apiBase: 'https://api.example.test' };

    // The loaded tool over a store holding `source`, and the parcel mutation it runs inside.
    function harness(source) {
        env = loadRoadDrawing({ proposals: [source], globals: { ProposalLineage: lineage } });
        source.roadProposal.definition.profile = globalThis.corridorProfileFromLegacy(7.5, 1, false);
        const afterCommit = [];
        const mutation = { proposals: env.store, afterCommit: fn => afterCommit.push(fn) };
        const run = (id, mutate) => env.api.runLocalCorridorGeometryUpdate(id, mutate, { _parcelMutation: mutation });
        return { run, mutation, store: env.store, ProposalManager: globalThis.ProposalManager, afterCommit };
    }

    it('edits one\'s own local road in place: same id, no counterproposal', async () => {
        const source = road('own-road');
        const h = harness(source);

        const result = await h.run('own-road', extend);

        expect(result).toBe('own-road');
        expect(h.ProposalManager.createCorridorProposalAtomically.calls).toHaveLength(0);
        expect(endOf(source).lng).toBeCloseTo(at(150, 0).lng, 12);
        expect(source.roadProposal.definition.polygon.type).toMatch(/Polygon/);
        expect([...h.store.proposals.keys()]).toEqual(['own-road']);
    });

    it('saves an edit of a published road as a counterproposal and leaves the published road as it was', async () => {
        const source = road('published-road', { published: PUBLISHED });
        const h = harness(source);
        globalThis.ProposalSelection.is = key => key === 'published-road';
        const before = clone(source);

        const result = await h.run('published-road', extend);

        expect(result).toBe('fork-1');
        expect(source).toEqual(before);
        expect(h.ProposalManager.createCorridorProposalAtomically.calls).toHaveLength(1);
        const [fork, options] = h.ProposalManager.createCorridorProposalAtomically.calls[0];
        // The fork links the published design by its CID, in the typed relation too, and is not
        // itself published.
        expect(fork.origin).toEqual({ cid: PUBLISHED.cid });
        expect(fork.published).toBeUndefined();
        expect(fork.proposalOrigin).toEqual({ relation: 'revision', source: { kind: 'design', cid: PUBLISHED.cid }, title: 'Main street' });
        expect(endOf(fork).lng).toBeCloseTo(at(150, 0).lng, 12);
        expect(options).toEqual({ _parcelMutation: h.mutation });
        // The counterproposal is selected, so the next edit lands on it.
        h.afterCommit.forEach(fn => fn());
        expect(globalThis.selectAndHighlightProposal.calls.map(call => call[0])).toEqual(['fork-1']);
        expect([...h.store.proposals.keys()]).toEqual(['published-road']);
    });

    it('refuses a road this city does not hold with a reason the editor can show', async () => {
        const h = harness(road('own-road'));
        await expect(h.run('elsewhere', extend))
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
            selectAndHighlightProposal: vi.fn(),
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
        h.context.selectAndHighlightProposal.mockImplementation(() => {
            expect(h.context.corridorEditorState).toBeNull();
        });
        await h.save();
        expect(h.context.__closeSpy).toHaveBeenCalledOnce();
        expect(h.context.selectAndHighlightProposal).toHaveBeenCalledWith(
            'road-1', null, false, true, false, { presentation: 'details' }
        );
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
        expect(h.context.selectAndHighlightProposal).not.toHaveBeenCalled();
    });

    it('closes the editor when a published road\'s edit was saved as a counterproposal', async () => {
        const h = harness(async () => 'fork-1');
        await h.save();
        expect(h.context.__closeSpy).toHaveBeenCalledOnce();
        expect(h.context.selectAndHighlightProposal).toHaveBeenCalledWith(
            'fork-1', null, false, true, false, { presentation: 'details' }
        );
        expect(h.context.updateStatus).not.toHaveBeenCalledWith('Cross-section updated.');
    });
});
