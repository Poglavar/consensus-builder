// Unit tests for proposal-to-draft editor adapters and exact geometry round trips.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);

// The corridor adapter reaches for `global.corridorIsTrack`, which in the browser is put there by
// corridor-profile.js loading as a classic script. Under node nothing does that, so seed the corridor
// helpers onto globalThis before requiring the adapters — otherwise draftFromProposal throws.
Object.assign(globalThis, require('../../frontend/js/corridor-profile.js'));
globalThis.turf = require('@turf/turf');
const turf = globalThis.turf;
const listUiSource = readFileSync(new URL('../../frontend/js/proposals/list-ui.js', import.meta.url), 'utf8');
const proposalEditorShellSource = readFileSync(new URL('../../frontend/js/proposal-editor-shell.js', import.meta.url), 'utf8');
const proposalEditorAdaptersSource = readFileSync(new URL('../../frontend/js/proposal-editor-adapters.js', import.meta.url), 'utf8');
const { isPublishedProposalRecord } = require('../../frontend/js/proposal-supersession.js');

const {
    CREATABLE_PROPOSAL_GOALS,
    registry,
    corridorAdapter,
    buildBuildingAdapter,
    reparcellizationAdapter,
    buildStructureAdapter,
    freePlacementPatch,
    markFreePlacementBound
} = require('../../frontend/js/proposal-editor-adapters.js');

function loadListUiFunction(name, values) {
    const ast = parse(listUiSource, { sourceType: 'script' });
    const declaration = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
    expect(declaration, `${name} declaration exists`).toBeTruthy();
    const context = vm.createContext(values);
    vm.runInContext(`${listUiSource.slice(declaration.start, declaration.end)}\nthis.launcher = ${name};`, context);
    return context.launcher;
}

function loadProposalEditorShellFunction(name, values, prefix = '') {
    const ast = parse(proposalEditorShellSource, { sourceType: 'script' });
    let declaration = null;
    (function find(node) {
        if (!node || typeof node !== 'object' || declaration) return;
        if (node.type === 'FunctionDeclaration' && node.id?.name === name) {
            declaration = node;
            return;
        }
        Object.keys(node).forEach(key => {
            if (['loc', 'start', 'end'].includes(key)) return;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(find); else find(value);
        });
    })(ast);
    expect(declaration, `${name} declaration exists`).toBeTruthy();
    const context = vm.createContext(values);
    vm.runInContext(`${prefix}\n${proposalEditorShellSource.slice(declaration.start, declaration.end)}\nthis.fn = ${name};`, context);
    context.fn.context = context;
    return context.fn;
}

function loadProposalEditorAdaptersFunction(name, values) {
    const ast = parse(proposalEditorAdaptersSource, { sourceType: 'script' });
    let declaration = null;
    (function find(node) {
        if (!node || typeof node !== 'object' || declaration) return;
        if (node.type === 'FunctionDeclaration' && node.id?.name === name) {
            declaration = node;
            return;
        }
        Object.keys(node).forEach(key => {
            if (['loc', 'start', 'end'].includes(key)) return;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(find); else find(value);
        });
    })(ast);
    expect(declaration, `${name} declaration exists`).toBeTruthy();
    const context = vm.createContext(values);
    vm.runInContext(`${proposalEditorAdaptersSource.slice(declaration.start, declaration.end)}\nthis.fn = ${name};`, context);
    return context.fn;
}

describe('fresh building editor launch results', () => {
    it.each([
        ['launchSingleBuildingToolForSelection', 'openSingleBuildingForParcels'],
        ['launchRowHouseToolForSelection', 'openRowHouseForParcels'],
        ['launchParcelBasedToolForSelection', 'openParcelBasedForParcels']
    ])('waits for %s and reports a cancelled editor open as false', async (launcherName, openName) => {
        let openStarted;
        const started = new Promise(resolve => { openStarted = resolve; });
        let resolveOpen;
        const pendingOpen = new Promise(resolve => { resolveOpen = resolve; });
        const launcher = loadListUiFunction(launcherName, {
            getCurrentParcelSelectionContext: () => ({ ids: ['p1'] }),
            shouldStopFreshProposalForWholeBlock: async () => false,
            formatParcelSelectionLabel: () => 'Block A',
            getPendingBuildingSeedFor: () => null,
            [openName]: () => { openStarted(); return pendingOpen; }
        });

        const opening = launcher();
        await started;
        let settled = false;
        opening.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        resolveOpen(false);
        await expect(opening).resolves.toBe(false);
    });
});

function draftFor(adapter, proposal, overrides = {}) {
    // Editor inputs are authored records. Keep fixtures on the same side of the persistence
    // boundary as production: an immutable flat cadastral declaration is always present.
    if (!Array.isArray(proposal.cadastreParcelIds)) {
        throw new Error('Test proposal must declare cadastreParcelIds.');
    }
    const source = proposal;
    const seeded = adapter.draftFromProposal(source);
    return {
        id: 'draft-1',
        cityId: source.city || 'zagreb',
        goal: seeded.adapterKey || source.goal,
        adapterKey: seeded.adapterKey,
        sourceProposalId: source.proposalId,
        sourceSnapshot: source,
        fields: seeded.fields,
        editorPayload: seeded.editorPayload,
        ...overrides
    };
}

describe('editor cadastral scope boundary', () => {
    it('preserves an untouched authored scope without consulting the live map', () => {
        const adapter = registry.get('as-is');
        const source = {
            proposalId: 'scope-1', goal: 'as-is', title: 'Keep scope',
            cadastreParcelIds: ['HR-1-100']
        };
        const replacement = adapter.serializeProposal(draftFor(adapter, source));

        expect(replacement.cadastreParcelIds).toEqual(['HR-1-100']);
    });

    it('projects only a changed selection through LiveParcelFabric', () => {
        const adapter = registry.get('as-is');
        const source = {
            proposalId: 'scope-2', goal: 'as-is', title: 'Move scope',
            cadastreParcelIds: ['cadastre-old']
        };
        const draft = draftFor(adapter, source);
        draft.fields.selectedParcelIds = ['live-new'];
        const previousFabric = globalThis.LiveParcelFabric;
        globalThis.LiveParcelFabric = {
            cadastreIdsForParcelIds: ids => ids.map(id => id === 'live-new' ? 'cadastre-new' : id)
        };
        try {
            expect(adapter.serializeProposal(draft).cadastreParcelIds).toEqual(['cadastre-new']);
        } finally {
            if (previousFabric === undefined) delete globalThis.LiveParcelFabric;
            else globalThis.LiveParcelFabric = previousFabric;
        }
    });
});

describe('proposal editor adapter registry', () => {
    it('registers every creatable proposal goal', () => {
        expect(registry.completeness(CREATABLE_PROPOSAL_GOALS)).toEqual({ complete: true, missing: [] });
        expect(CREATABLE_PROPOSAL_GOALS).not.toContain('decide-later');
    });

    it('keeps stored Decide Later proposals readable but not editable into new proposals', () => {
        const capability = registry.canEdit({ goal: 'decide-later', decideLaterProposal: {} });
        expect(capability.editable).toBe(false);
        expect(capability.reason).toContain('no longer');
    });

    it('normalizes aliases to the same adapter', () => {
        expect(registry.get('road')).toBe(registry.get('road-track'));
        expect(registry.get('parcel-based')).toBe(registry.get('parcelBased'));
        expect(registry.get('ownership-transfer-from-me')).toBe(registry.get('ownership-transfer'));
    });
});

describe('structure proposal adapters', () => {
    const geometry = {
        type: 'Polygon',
        coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.81], [15.9, 45.8]]]
    };

    it.each([
        ['park', { trees: [[15.905, 45.805]], flowerbeds: [], ponds: [], paths: [], version: 3 }],
        ['square', { fountains: [[15.905, 45.805]], trees: [], benches: [{ coordinate: [15.906, 45.806], bearing: 75 }], version: 2 }],
        ['lake', { fish: [[15.905, 45.805]], reeds: [], version: 1 }]
    ])('round-trips %s geometry, decorations, and demolition records', (kind, decorations) => {
        const adapter = buildStructureAdapter(kind);
        const demolishedBuildings = [{ id: '61075', geometry }];
        const proposal = {
            proposalId: `${kind}-1`,
            city: 'zagreb',
            goal: kind,
            title: `Test ${kind}`,
            cadastreParcelIds: ['p1'],
            structureProposal: { kind, geometry, decorations, demolishedBuildings }
        };
        const draft = draftFor(adapter, proposal);
        const replacement = adapter.serializeProposal(draft);

        expect(adapter.sections).toContain('design');
        expect(replacement.structureProposal.geometry).toEqual(geometry);
        expect(replacement.structureProposal.decorations).toEqual(decorations);
        expect(replacement.structureProposal.demolishedBuildings).toBeUndefined();
        expect(adapter.validate(draft).valid).toBe(true);
    });
});

describe('transit station proposal adapter', () => {
    const geometry = {
        type: 'Polygon',
        coordinates: [[[15.9, 45.8], [15.9002, 45.8], [15.9002, 45.8005], [15.9, 45.8005], [15.9, 45.8]]]
    };

    it('round-trips the station type, placement frame, footprint, and model version', () => {
        const adapter = registry.get('station');
        const proposal = {
            proposalId: 'station-1',
            city: 'zagreb',
            goal: 'station',
            title: 'Central metro',
            cadastreParcelIds: ['p1', 'p2'],
            structureProposal: {
                kind: 'station',
                stationType: 'underground',
                center: [15.9001, 45.80025],
                bearing: 72,
                modelVersion: 1,
                geometry
            }
        };

        const draft = draftFor(adapter, proposal);
        const replacement = adapter.serializeProposal(draft);

        expect(adapter.hasDesign).toBe(true);
        expect(adapter.sections).toContain('design');
        expect(adapter.validate(draft).valid).toBe(true);
        expect(replacement.goal).toBe('station');
        expect(replacement.structureProposal).toMatchObject({
            kind: 'station',
            stationType: 'underground',
            center: [15.9001, 45.80025],
            bearing: 72,
            modelVersion: 1
        });
        expect(replacement.cadastreParcelIds).toEqual(['p1', 'p2']);
        expect(replacement.structureProposal.parentParcelIds).toBeUndefined();
        expect(replacement.geometry.stationGraphics).toEqual(geometry);
    });

    it('rejects a missing station placement frame', () => {
        const adapter = registry.get('station');
        const draft = {
            fields: { selectedParcelIds: ['p1'] },
            editorPayload: {
                structureProposal: { kind: 'station', stationType: 'tram', geometry }
            }
        };

        expect(adapter.validate(draft)).toMatchObject({
            valid: false,
            errors: expect.arrayContaining([expect.objectContaining({ code: 'invalid-station-centre' })])
        });
    });

    it('accepts bus stations and bounds elevated platform height', () => {
        const adapter = registry.get('station');
        const bus = draftFor(adapter, {
            proposalId: 'bus-1', city: 'zagreb', goal: 'station', title: 'Roadside stop',
            cadastreParcelIds: ['p1'],
            structureProposal: {
                kind: 'station', stationType: 'bus', center: [15.9, 45.8], bearing: 0, geometry
            }
        });
        expect(adapter.validate(bus).valid).toBe(true);

        const elevated = structuredClone(bus);
        elevated.editorPayload.structureProposal.stationType = 'elevated';
        elevated.editorPayload.structureProposal.platformHeightM = 41;
        expect(adapter.validate(elevated)).toMatchObject({
            valid: false,
            errors: expect.arrayContaining([expect.objectContaining({ code: 'invalid-station-platform-height' })])
        });
    });
});

describe('corridor proposal adapter', () => {
    const proposal = {
        proposalId: 'road-1',
        city: 'zagreb',
        goal: 'road-track',
        primaryType: 'Road',
        title: 'Green street',
        description: 'A calmer street',
        cadastreParcelIds: ['1', '2'],
        roadProposal: {
            definition: {
                points: [[{ lat: 45.8, lng: 15.9 }, { lat: 45.81, lng: 15.91 }]],
                segmentIds: ['segment-a'],
                width: 12,
                sidewalkWidth: 2,
                profile: { strips: [{ type: 'sidewalk', width: 2 }, { type: 'driving', width: 8 }, { type: 'sidewalk', width: 2 }] },
                tunnels: [{ id: 'tunnel-1', buildingIds: ['b1'] }],
                polygon: { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.91, 45.81], [15.9, 45.8]]] },
                metadata: { isCorridor: true, isRoad: true, isTrack: false }
            }
        }
    };

    it('round-trips canonical centerline, profile, tunnels, and width exactly', () => {
        expect(corridorAdapter.canEdit(proposal)).toBe(true);
        const draft = draftFor(corridorAdapter, proposal);
        const replacement = corridorAdapter.serializeProposal(draft);

        expect(replacement.roadProposal.definition).toEqual(proposal.roadProposal.definition);
        expect(replacement.sourceProposalId).toBeUndefined();
        expect(replacement.proposalId).toBeUndefined();
    });

    it('reports a precise read-only reason for invalid corridors without centerlines', () => {
        expect(corridorAdapter.canEdit({ roadProposal: { definition: { width: 9 } } })).toEqual({
            editable: false,
            reason: 'This corridor does not contain a valid centerline.'
        });
    });

    it('summarizes width and cross-section changes', () => {
        const draft = draftFor(corridorAdapter, proposal);
        draft.editorPayload.definition.width = 15;
        draft.editorPayload.definition.profile.strips[1].width = 11;
        const summary = corridorAdapter.summarizeChanges(proposal, draft);

        expect(summary.geometry).toMatchObject({ widthChange: 3, profileChanged: true });
        expect(summary.unchanged).toBe(false);
    });
});

describe('building proposal adapters', () => {
    const manualRing = [[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.81], [15.9, 45.8]];
    const feature = {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [manualRing] },
        properties: { manual: true, height: 18 }
    };
    const proposal = {
        proposalId: 'building-1',
        city: 'zagreb',
        goal: 'buildings',
        typologyType: 'block',
        title: 'Courtyard block',
        cadastreParcelIds: ['p1'],
        geometry: { buildings: [feature] },
        buildingProposal: {
            blockName: 'Block A',
            parameters: {
                mode: 'manual',
                manualOuterRing: manualRing.slice(0, -1),
                gaps: [{ edge: 1, ratio: 0.4 }],
                wings: [{ edge: 2, depth: 8 }],
                setback: 4,
                height: 18
            }
        }
    };

    it.each([
        ['single', 'openSingleBuildingForParcels'],
        ['row', 'openRowHouseForParcels'],
        ['parcelBased', 'openParcelBasedForParcels'],
        ['block', 'openUrbanRuleForParcels']
    ])('waits for the %s editor and propagates a cancelled open', async (typology, openName) => {
        const adapter = buildBuildingAdapter(typology === 'block' ? 'buildings' : typology);
        const source = {
            ...proposal,
            proposalId: `building-open-${typology}`,
            goal: typology === 'single' ? 'single' : 'buildings',
            typologyType: typology,
            site: {
                type: 'Feature', properties: { authored: true },
                geometry: { type: 'MultiPolygon', coordinates: [[manualRing], [[[15.92, 45.8], [15.93, 45.8], [15.93, 45.81], [15.92, 45.81], [15.92, 45.8]]] ] }
            },
            buildingProposal: {
                ...proposal.buildingProposal,
                typologyType: typology,
                parameters: { typology }
            }
        };
        const draft = draftFor(adapter, source);
        // Opening a saved design uses its exact live parcel IDs. Avoid footprint rebasing here so
        // the test isolates the async editor result contract.
        draft.previewGeometry = null;

        const names = [
            'LiveParcelFabric', 'ParcelPresenter', 'multiParcelSelection',
            'pendingBuildingProposalContext', openName
        ];
        const prior = new Map(names.map(name => [name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name]
        }]));
        let openStarted;
        const started = new Promise(resolve => { openStarted = resolve; });
        let resolveOpen;
        const pendingOpen = new Promise(resolve => { resolveOpen = resolve; });
        let openOptions = null;
        try {
            globalThis.LiveParcelFabric = { get: id => id === 'p1' ? feature : null };
            globalThis.ParcelPresenter = { getLayer: id => id === 'p1' ? { id } : null };
            globalThis.multiParcelSelection = null;
            globalThis[openName] = options => { openOptions = options; openStarted(); return pendingOpen; };

            const opening = adapter.openDesignEditor(draft);
            await started;
            let settled = false;
            opening.then(() => { settled = true; });
            await Promise.resolve();
            expect(settled).toBe(false);
            expect(openOptions.site).toEqual(source.site);

            resolveOpen(false);
            await expect(opening).resolves.toBe(false);
        } finally {
            prior.forEach((saved, name) => {
                if (saved.existed) globalThis[name] = saved.value;
                else delete globalThis[name];
            });
        }
    });

    it.each(['single', 'row', 'parcelBased', 'block'])('refuses a saved %s geometry edit when its authored site boundary is missing', async typology => {
        const adapter = buildBuildingAdapter(typology === 'block' ? 'buildings' : typology);
        const source = {
            ...proposal,
            proposalId: `building-open-${typology}-without-site`,
            goal: typology === 'single' ? 'single' : 'buildings', typologyType: typology,
            buildingProposal: { ...proposal.buildingProposal, typologyType: typology, parameters: { typology } }
        };
        const draft = draftFor(adapter, source);
        draft.previewGeometry = null;

        await expect(adapter.openDesignEditor(draft)).rejects.toThrow(/no valid authored site boundary/);
    });

    it.each(['single', 'row', 'parcelBased', 'block'])('keeps the authored MultiPolygon site and cadastral anchors for saved %s edits', typology => {
        const adapter = buildBuildingAdapter(typology === 'block' ? 'buildings' : typology);
        const site = {
            type: 'Feature', properties: { authored: true },
            geometry: { type: 'MultiPolygon', coordinates: [[manualRing], [[[15.92, 45.8], [15.93, 45.8], [15.93, 45.81], [15.92, 45.81], [15.92, 45.8]]] ] }
        };
        const source = {
            ...proposal, proposalId: `building-site-roundtrip-${typology}`,
            goal: typology === 'single' ? 'single' : 'buildings', typologyType: typology,
            cadastreParcelIds: ['cadastre-a', 'cadastre-b'], site,
            buildingProposal: { ...proposal.buildingProposal, typologyType: typology, parameters: { typology } }
        };
        const draft = draftFor(adapter, source);
        draft.editorPayload.context.buildings[0].geometry.coordinates[0][0][0] += 0.001;

        const replacement = adapter.serializeProposal(draft);
        expect(replacement.site).toEqual(site.geometry);
        expect(replacement.cadastreParcelIds).toEqual(['cadastre-a', 'cadastre-b']);
    });

    it('preserves manual footprints and every editor parameter', () => {
        const adapter = buildBuildingAdapter('buildings');
        const draft = draftFor(adapter, proposal);
        const replacement = adapter.serializeProposal(draft);

        expect(replacement.geometry.buildings).toEqual([feature]);
        expect(replacement.buildingProposal.parameters).toEqual(proposal.buildingProposal.parameters);
        expect(replacement.buildingProposal.buildingFeature).toBeUndefined();
        expect(replacement.buildingProposal.buildings).toBeUndefined();
    });

    it.each([
        ['row', { length: 22, width: 8, height: 12, offsetX: 3, offsetY: -2, rotation: 17, typology: 'row' }],
        ['parcelBased', { maxFloors: 5, minDistance: 6, typology: 'parcelBased' }],
        ['single', { width: 14, length: 18, height: 21, chamfer: 2, rotation: 33, typology: 'single' }]
    ])('round-trips %s geometry and parameters exactly', (typology, parameters) => {
        const source = {
            ...proposal,
            proposalId: `building-${typology}`,
            goal: typology === 'single' ? 'single' : 'buildings',
            typologyType: typology,
            buildingProposal: {
                ...proposal.buildingProposal,
                typologyType: typology,
                parameters
            }
        };
        const adapter = buildBuildingAdapter(typology);
        const draft = draftFor(adapter, source);
        const replacement = adapter.serializeProposal(draft);

        expect(draft.adapterKey).toBe(typology);
        expect(replacement.buildingProposal.parameters).toEqual(parameters);
        expect(replacement.geometry.buildings).toEqual([feature]);
        expect(replacement.buildingProposal.buildings).toBeUndefined();
        expect(replacement.typologyType).toBe(typology);
    });

    // The paved/green surround of a freeform proposal (building-ground.js) has to survive an edit
    // that never reopens the design editor, and must not follow the design into another typology.
    describe('freeform surroundings', () => {
        const groundSurface = {
            treatment: 'paved',
            polygon: { type: 'Polygon', coordinates: [manualRing] }
        };
        const freeform = {
            ...proposal,
            proposalId: 'building-single',
            goal: 'single',
            typologyType: 'single',
            geometry: { buildings: [feature], groundSurface },
            buildingProposal: {
                ...proposal.buildingProposal,
                typologyType: 'single',
                parameters: { typology: 'single', height: 21 }
            }
        };

        it('round-trips the surround through an untouched draft', () => {
            const adapter = buildBuildingAdapter('single');
            const draft = draftFor(adapter, freeform);
            expect(draft.editorPayload.context.groundSurface).toEqual(groundSurface);
            expect(adapter.serializeProposal(draft).geometry.groundSurface).toEqual(groundSurface);
        });

        it('drops the surround when the design moves to another typology', () => {
            const adapter = buildBuildingAdapter('single');
            const draft = draftFor(adapter, freeform);
            draft.editorPayload = { ...draft.editorPayload, typology: 'row' };
            expect(adapter.serializeProposal(draft).geometry.groundSurface).toBeUndefined();
        });

        it('leaves a proposal without a surround alone', () => {
            const adapter = buildBuildingAdapter('single');
            const draft = draftFor(adapter, { ...freeform, geometry: { buildings: [feature] } });
            expect(draft.editorPayload.context.groundSurface).toBeNull();
            expect(adapter.serializeProposal(draft).geometry.groundSurface).toBeUndefined();
        });

        it('reports a changed treatment as a real change', () => {
            const adapter = buildBuildingAdapter('single');
            const draft = draftFor(adapter, freeform);
            draft.editorPayload.context.groundSurface = { ...groundSurface, treatment: 'green' };
            const summary = adapter.summarizeChanges(freeform, draft);
            expect(summary.groundTreatment).toMatchObject({ before: 'paved', after: 'green', changed: true });
            expect(summary.unchanged).toBe(false);
        });

        it('persists switching a saved whole-parcel building back to footprint parcels', () => {
            const adapter = buildBuildingAdapter('single');
            const source = {
                ...freeform,
                buildingProposal: { ...freeform.buildingProposal, takeWholeParcels: true }
            };
            const draft = draftFor(adapter, source);

            expect(draft.editorPayload.context.takeWholeParcels).toBe(true);
            draft.editorPayload.context.takeWholeParcels = false;

            expect(adapter.serializeProposal(draft).buildingProposal.takeWholeParcels).toBe(false);
        });
    });

    it('classifies invalid building data as read-only', () => {
        const adapter = buildBuildingAdapter('single');
        expect(adapter.canEdit({ goal: 'single', buildingProposal: { parameters: { height: 10 } } })).toEqual({
            editable: false,
            reason: 'This building proposal does not contain valid footprint geometry.'
        });
    });
});

describe('saved single-building geometry edits', () => {
    it('normalizes the generic buildings adapter key to block when saving a block design', () => {
        const draft = {
            id: 'saved-block-edit', sourceProposalId: 'proposal-block', adapterKey: 'buildings', goal: 'buildings',
            editorPayload: { typology: 'buildings', context: {} }, fields: { selectedParcelIds: [] }
        };
        let savedPatch = null;
        const store = {
            updateDraft: (_id, patch) => { savedPatch = typeof patch === 'function' ? patch(draft) : patch; return draft; },
            validateDraft: () => draft
        };
        const sync = loadProposalEditorShellFunction('syncActiveProposalDraftFromEditor', {
            global: { proposalDraftStore: store },
            getActiveProposalDesignDraft: () => draft,
            ensureShell: () => ({ classList: { contains: () => false } }),
            editorState: {}, renderProposalDraftComparison() {}
        });

        sync('building', {
            parameters: { mode: 'manual', manualOuterRing: [[0, 0], [1, 0], [1, 1]] },
            buildingFeature: { type: 'Feature', properties: { manual: true }, geometry: { type: 'Polygon', coordinates: [] } },
            buildings: []
        });

        expect(savedPatch.editorPayload.typology).toBe('block');
    });

    it('switches generated and existing-building snapshots without retaining the other placement mode', () => {
        const siteApi = require('../../frontend/js/proposals/site-draft.js');
        const site = turf.polygon([[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]);
        const footprint = turf.polygon([[[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]]]);
        const draft = {
            id: 'mode-switch', adapterKey: 'buildings', goal: 'buildings',
            fields: { site: siteApi.toMultiPolygon(footprint), selectedParcelIds: [], cadastreParcelIds: ['old-binding'], binding: { coverage: 'complete' } },
            editorPayload: { typology: 'block', context: { parameters: { mode: 'parametric' } }, placement: { free: true, site: footprint } }
        };
        const store = {
            updateDraft: (_id, updater) => Object.assign(draft, updater(draft)),
            validateDraft: () => draft
        };
        const sync = loadProposalEditorShellFunction('syncActiveProposalDraftFromEditor', {
            global: { proposalDraftStore: store, __siteDraft: siteApi, proposalDraftPlacement: { freePlacementPatch } },
            getActiveProposalDesignDraft: () => draft,
            ensureShell: () => ({ classList: { contains: () => false } }),
            editorState: {}, renderProposalDraftComparison() {}
        });

        sync('building', {
            parcelIds: ['source-parcel'], parameters: { mode: 'existing', typology: 'block' },
            buildings: [footprint], placement: { free: false, site }
        });
        expect(draft.editorPayload.context.parameters.mode).toBe('existing');
        expect(draft.editorPayload.placement).toBeNull();
        expect(draft.fields.site).toEqual(siteApi.toMultiPolygon(site));
        expect(draft.fields.selectedParcelIds).toEqual(['source-parcel']);
        expect(draft.fields.cadastreParcelIds).toEqual([]);
        expect(draft.fields.binding).toBeNull();

        // Validation must use the incoming generated snapshot, not the outgoing existing mode.
        sync('building', {
            parcelIds: ['source-parcel'], parameters: { mode: 'parametric', typology: 'block' },
            buildings: [footprint], placement: { free: true, site: footprint }
        });
        expect(draft.editorPayload.context.parameters.mode).toBe('parametric');
        expect(draft.editorPayload.placement).toMatchObject({ free: true, bindingStatus: 'pending' });
        expect(draft.fields.site).toEqual(siteApi.toMultiPolygon(footprint));
        expect(draft.fields.selectedParcelIds).toEqual([]);
    });

    it('does not replace source selection anchors with transient live child parcels', () => {
        const draft = {
            id: 'saved-single-edit', sourceProposalId: 'proposal-1', adapterKey: 'single', goal: 'single',
            editorPayload: { typology: 'single', context: {} }, fields: { selectedParcelIds: ['cadastre-a', 'cadastre-b'] }
        };
        let savedPatch = null;
        const store = {
            updateDraft: (_id, patch) => { savedPatch = typeof patch === 'function' ? patch(draft) : patch; return draft; },
            validateDraft: () => draft
        };
        const sync = loadProposalEditorShellFunction('syncActiveProposalDraftFromEditor', {
            global: { proposalDraftStore: store },
            getActiveProposalDesignDraft: () => draft,
            ensureShell: () => ({ classList: { contains: () => false } }),
            editorState: {}, renderProposalDraftComparison() {}
        });

        sync('building', {
            parcelIds: ['rebased-live-child-1', 'rebased-live-child-2'],
            parameters: { typology: 'single' },
            buildings: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } }]
        });

        expect(savedPatch.fields.selectedParcelIds).toEqual(['cadastre-a', 'cadastre-b']);
        expect(savedPatch.editorPayload.context.parcelIds).toEqual(['rebased-live-child-1', 'rebased-live-child-2']);
    });

    it('replaces the complete building editor context so removed feature flags do not survive autosave', () => {
        const oldFeature = { type: 'Feature', properties: { manual: true, block: 'A' }, geometry: { type: 'Polygon', coordinates: [] } };
        const adapter = buildBuildingAdapter('buildings');
        const draft = draftFor(adapter, {
            proposalId: 'parametric-after-undo', goal: 'buildings', title: 'Block', cadastreParcelIds: ['parcel-a'],
            geometry: { buildings: [oldFeature], blockMassing: oldFeature },
            buildingProposal: { typologyType: 'block', parameters: { mode: 'manual', typology: 'block', manualOuterRing: [[0, 0], [1, 0], [1, 1]] } }
        });
        draft.id = 'parametric-after-undo-draft';
        const store = {
            updateDraft: (_id, updater) => Object.assign(draft, updater(draft)),
            validateDraft: () => draft
        };
        const sync = loadProposalEditorShellFunction('syncActiveProposalDraftFromEditor', {
            global: { proposalDraftStore: store },
            getActiveProposalDesignDraft: () => draft,
            ensureShell: () => ({ classList: { contains: () => false } }),
            editorState: {}, renderProposalDraftComparison() {}
        });
        const parametricFeature = {
            type: 'Feature', properties: { block: 'A' },
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] }
        };
        sync('building', {
            parameters: { mode: 'parametric', typology: 'block', width: 12 },
            buildingFeature: parametricFeature,
            buildings: [parametricFeature]
        });

        expect(draft.editorPayload.context.parameters).toEqual({ mode: 'parametric', typology: 'block', width: 12 });
        expect(draft.editorPayload.context.buildingFeature.properties).not.toHaveProperty('manual');
        expect(draft.editorPayload.context.buildings[0].properties).not.toHaveProperty('manual');
        const saved = adapter.serializeProposal(draft);
        expect(saved.buildingProposal.parameters.mode).toBe('parametric');
        expect(saved.geometry.buildings[0].properties).not.toHaveProperty('manual');
    });
});

describe('saved lake geometry edits', () => {
    it('syncs the edited lake boundary and regenerated graphics into its active proposal draft', () => {
        const geometry = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]] };
        const graphics = { geometry, shore: { type: 'Polygon', coordinates: [] }, water: { type: 'Polygon', coordinates: [] } };
        const draft = {
            id: 'saved-lake-edit', sourceProposalId: 'lake-1', adapterKey: 'lake', goal: 'lake',
            editorPayload: { structureProposal: { kind: 'lake', geometry, lakeGraphics: { version: 'stale' } } }
        };
        let savedPatch = null;
        const store = {
            updateDraft: (_id, patch) => { savedPatch = patch; return draft; },
            validateDraft: () => draft
        };
        const sync = loadProposalEditorShellFunction('syncActiveProposalDraftFromEditor', {
            global: { proposalDraftStore: store },
            getActiveProposalDesignDraft: () => draft,
            ensureShell: () => ({ classList: { contains: () => false } }),
            editorState: {}, renderProposalDraftComparison() {}
        });

        const result = sync('structure', { structureProposal: { kind: 'lake', geometry, lakeGraphics: graphics } });

        expect(result).toBe(draft);
        expect(savedPatch.editorPayload.structureProposal).toMatchObject({ kind: 'lake', geometry, lakeGraphics: graphics });
        expect(savedPatch.previewGeometry).toEqual(geometry);
    });
});

describe('geometry draft starters respect an incumbent map editor', () => {
    it.each([
        ['startInstantSiteDesign', (start, site) => start('single', site, ['parcel-1'])],
        ['startSiteSubdivision', (start, site) => start(site)]
    ])('%s refuses without replacing the active draft or its commit context', async (name, invoke) => {
        const activeDraft = { id: 'incumbent-draft', sourceProposalId: 'proposal-1' };
        const createDraft = vi.fn(() => ({ id: 'unexpected-new-draft' }));
        const openProposalDraftDesign = vi.fn();
        const global = {
            OnMapEditor: { isActive: () => true },
            proposalDraftStore: { activeDraft, createDraft },
            openProposalDraftDesign,
            showEphemeralMessage: vi.fn(),
            updateStatus: vi.fn()
        };
        const prefix = `let geometryEditCommitDraftId='incumbent-draft'; this.getCommitDraftId=()=>geometryEditCommitDraftId;`;
        const start = loadProposalEditorShellFunction(name, { global, reportSiteDesignStartIssue: vi.fn(() => false) }, prefix);
        const site = { site: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } } };

        expect(await invoke(start, site)).toBe(false);
        expect(global.proposalDraftStore.activeDraft).toBe(activeDraft);
        expect(createDraft).not.toHaveBeenCalled();
        expect(openProposalDraftDesign).not.toHaveBeenCalled();
        expect(start.context.reportSiteDesignStartIssue).toHaveBeenCalledOnce();
        expect(start.context.getCommitDraftId()).toBe('incumbent-draft');
    });

    it('keeps the newly authored site draft when its design editor cannot open', async () => {
        const draft = { id: 'site-draft' };
        const store = { createDraft: vi.fn(() => draft), deleteDraft: vi.fn() };
        const report = vi.fn(() => false);
        const start = loadProposalEditorShellFunction('startInstantSiteDesign', {
            global: {
                OnMapEditor: { isActive: () => false },
                proposalDraftStore: store,
                openProposalDraftDesign: vi.fn(async () => false)
            },
            reportSiteDesignStartIssue: report,
            currentCityId: () => 'zagreb',
            proposalLabel: () => 'Building',
            siteDraftFields: () => ({ selectedParcelIds: ['parcel-1'] })
        }, `let geometryEditCommitDraftId=null; this.getCommitDraftId=()=>geometryEditCommitDraftId;`);

        expect(await start('single', { site: { type: 'Feature' } }, ['parcel-1'])).toBe(false);
        expect(store.createDraft).toHaveBeenCalledOnce();
        expect(store.deleteDraft).not.toHaveBeenCalled();
        expect(start.context.getCommitDraftId()).toBeNull();
        expect(report).toHaveBeenCalledWith('handoffFailed', 'The design editor could not open. Your site is unchanged, and the design draft was preserved locally.');
    });

    it('refuses direct draft-design opens before resuming or activating their draft', async () => {
        const incumbentDraft = { id: 'incumbent-draft' };
        const getDraft = vi.fn(() => ({ id: 'second-draft', adapterKey: 'single' }));
        const openDesignEditor = vi.fn();
        const beginSession = vi.fn();
        const finishSession = vi.fn();
        const registry = { get: vi.fn(() => ({ openDesignEditor })) };
        const global = {
            OnMapEditor: { isActive: () => true },
            proposalDraftStore: { getDraft, activeDraft: incumbentDraft },
            beginProposalDraftDesignSession: beginSession,
            finishProposalDraftDesignSession: finishSession
        };
        const open = loadProposalEditorAdaptersFunction('openProposalDraftDesign', { global, registry });

        expect(await open('second-draft')).toBe(false);
        expect(global.proposalDraftStore.activeDraft).toBe(incumbentDraft);
        expect(getDraft).not.toHaveBeenCalled();
        expect(registry.get).not.toHaveBeenCalled();
        expect(beginSession).not.toHaveBeenCalled();
        expect(finishSession).not.toHaveBeenCalled();
        expect(openDesignEditor).not.toHaveBeenCalled();
    });
});

describe('reparcellization adapter', () => {
    const polygon = coordinates => ({
        geometry: { type: 'Polygon', coordinates: [coordinates] },
        ownerKey: 'owner-a',
        owners: [{ ownerKey: 'owner-a', share: 1 }],
        source: 'manual'
    });
    const polygons = [
        polygon([[15.9, 45.8], [15.905, 45.8], [15.905, 45.81], [15.9, 45.81], [15.9, 45.8]]),
        polygon([[15.905, 45.8], [15.91, 45.8], [15.91, 45.81], [15.905, 45.81], [15.905, 45.8]])
    ];
    const proposal = {
        proposalId: 'reparcel-1',
        city: 'zagreb',
        goal: 'reparcellization',
        title: 'Readjust block',
        cadastreParcelIds: ['p1', 'p2'],
        reparcellization: {
            algorithm: 'manual',
            ownershipMode: 'multiple',
            polygons
        }
    };

    it('reopens and serializes saved manual polygons without rerunning an algorithm', () => {
        const draft = draftFor(reparcellizationAdapter, proposal);
        const replacement = reparcellizationAdapter.serializeProposal(draft);

        expect(replacement.reparcellization.polygons).toEqual(polygons);
        expect(replacement.reparcellization.algorithm).toBe('manual');
    });

    it('rejects one readjustment record made of disconnected islands', () => {
        const draft = draftFor(reparcellizationAdapter, proposal);
        draft.editorPayload.plan.polygons = [
            polygons[0],
            polygon([[16.0, 45.8], [16.005, 45.8], [16.005, 45.81], [16.0, 45.81], [16.0, 45.8]])
        ];

        expect(reparcellizationAdapter.validate(draft)).toMatchObject({
            valid: false,
            errors: expect.arrayContaining([expect.objectContaining({ code: 'disconnected-readjustment' })])
        });
    });

    it('round-trips the saved partial-parcel pool geometry', () => {
        const withPool = structuredClone(proposal);
        withPool.reparcellization.poolGeometry = {
            type: 'Polygon',
            coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.81], [15.9, 45.8]]]
        };
        const draft = draftFor(reparcellizationAdapter, withPool);
        const replacement = reparcellizationAdapter.serializeProposal(draft);

        expect(replacement.reparcellization.poolGeometry).toEqual(withPool.reparcellization.poolGeometry);
        expect(reparcellizationAdapter.validate(draft).valid).toBe(true);
    });

    it('rejects malformed replacement polygons', () => {
        const draft = draftFor(reparcellizationAdapter, proposal);
        draft.editorPayload.plan.polygons.push({ geometry: { type: 'Polygon', coordinates: [[]] } });

        expect(reparcellizationAdapter.validate(draft)).toMatchObject({
            valid: false,
            errors: expect.arrayContaining([expect.objectContaining({ code: 'invalid-polygon' })])
        });
    });

    it('rejects gaps against a declared take even when stale area metadata would suggest coverage', () => {
        const draft = draftFor(reparcellizationAdapter, proposal);
        draft.editorPayload.plan.poolGeometry = {
            type: 'Polygon',
            coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.81], [15.9, 45.8]]]
        };
        draft.editorPayload.plan.totalArea = 1;
        draft.editorPayload.plan.polygons = [
            { ...polygons[0], area: 999999 }
        ];
        expect(reparcellizationAdapter.validate(draft)).toMatchObject({
            valid: false,
            errors: expect.arrayContaining([
                expect.objectContaining({ code: 'coverage-gap' })
            ])
        });
    });

    it('allows an abstract output owner when input rights have not been resolved', () => {
        const draft = draftFor(reparcellizationAdapter, proposal);
        draft.fields.approvalConfig = {
            schema: 'proposal-approval/v1', rights: null, policy: { type: 'unanimous' }
        };

        expect(reparcellizationAdapter.validate(draft)).toMatchObject({
            valid: true,
            warnings: expect.arrayContaining([expect.objectContaining({ code: 'ownership-unresolved' })])
        });
    });
});

// A subdivision (PARCEL-OPTIONAL.md phase 4) is a readjustment whose pool is its SITE: the bound
// parcels' part and the open ground. Its plots must tile the site, whatever pool the plan carries,
// and its editor opens on the site with the binding's parcels, never on a live selection.
describe('subdivision (readjustment pooled from a site)', () => {
    const sitePlots = require('../../frontend/js/proposals/site-plots.js');
    const rect = (x0, y0, x1, y1) => ({
        type: 'Polygon',
        coordinates: [[[15.876 + x0 * 1e-4, 43.7537 + y0 * 1e-4], [15.876 + x1 * 1e-4, 43.7537 + y0 * 1e-4],
            [15.876 + x1 * 1e-4, 43.7537 + y1 * 1e-4], [15.876 + x0 * 1e-4, 43.7537 + y1 * 1e-4], [15.876 + x0 * 1e-4, 43.7537 + y0 * 1e-4]]]
    });
    const site = rect(0, 0, 12, 6);
    const plot = geometry => ({ geometry, ownerKey: 'open-ground', owners: [{ ownerKey: 'open-ground', share: 1 }], source: 'sweep-line' });
    const plots = sitePlots.cutPlots(site, { plotWidthM: 20, turf: globalThis.turf }).map(feature => feature.geometry);
    const record = (polygons, poolGeometry = site) => ({
        proposalId: 'sub-1',
        city: 'sibenik',
        goal: 'reparcellization',
        title: 'Subdivide the hole',
        cadastreParcelIds: ['HR-330264-1'],
        site: { type: 'MultiPolygon', coordinates: [site.coordinates] },
        binding: { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'partial', source: 'server' },
        reparcellization: { algorithm: 'sweep-line', poolSource: 'site', poolGeometry, polygons }
    });

    it('accepts plots that tile the site exactly', () => {
        const draft = draftFor(reparcellizationAdapter, record(plots.map(plot)));
        expect(reparcellizationAdapter.validate(draft)).toMatchObject({ valid: true, errors: [] });
    });

    it('refuses plots that leave the open part of the site uncovered, even when the plan\'s pool agrees with them', () => {
        // Only the plots over the parcel half: the plan's own pool is that half, the site is not.
        const parcelHalf = rect(0, 0, 6, 6);
        const halfPlots = plots
            .map(geometry => turf.intersect(turf.feature(geometry), turf.feature(parcelHalf)))
            .filter(Boolean).map(feature => plot(feature.geometry));
        const draft = draftFor(reparcellizationAdapter, record(halfPlots, parcelHalf));
        const result = reparcellizationAdapter.validate(draft);
        expect(result.valid).toBe(false);
        expect(result.errors.map(error => error.code)).toContain('coverage-gap');
    });

    it('opens the editor on the site with the binding\'s parcels as the owned pool', async () => {
        const calls = [];
        globalThis.openReparcellizationModal = async options => { calls.push(options); return true; };
        try {
            const draft = draftFor(reparcellizationAdapter, record(plots.map(plot)));
            draft.fields.binding = { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'partial' };
            await expect(reparcellizationAdapter.openDesignEditor(draft)).resolves.toBe(true);
            expect(calls).toHaveLength(1);
            expect(calls[0].sitePool.boundParcelIds).toEqual(['HR-330264-1']);
            expect(calls[0].sitePool.site).toEqual({ type: 'MultiPolygon', coordinates: [site.coordinates] });
            expect(calls[0].algorithm).toBe('sweep-line');
            expect(globalThis.pendingReparcellizationPlan.poolGeometry).toEqual(calls[0].sitePool.site);
        } finally {
            delete globalThis.openReparcellizationModal;
            delete globalThis.pendingReparcellizationPlan;
        }
    });
});

// A readjustment's inputs are the parcels it says it pooled. The editor opens on that record, and
// what the map happens to have loaded or selected must never redefine it — when it did, an applied
// plan handed the editor its own CHILD parcels as inputs, the pool became the outline of the
// outputs, and the boundary that is supposed to contain the plan was defined by the plan.
describe('reparcellization inputs survive the trip into the design editor', () => {
    const POOLED = ['HR-335550-1791/25', 'HR-335550-1791/30', 'HR-335550-1791/31'];
    // What the applied plan minted — these are outputs, and must never be mistaken for inputs.
    const CHILDREN = POOLED.map((id, i) => `${id}#p-plan-${i + 1}`);

    function proposal(planOverrides = {}) {
        return {
            proposalId: 'p-plan',
            city: 'zagreb',
            goal: 'reparcellization',
            cadastreParcelIds: POOLED.slice(),
            reparcellization: {
                totalArea: 1000,
                polygons: [
                    { ownerKey: 'a', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }
                ],
                ...planOverrides
            }
        };
    }

    // Stand in for the browser globals openDesignEditor reaches for.
    async function openWith(draft, selectionIds) {
        const saved = {
            prepare: globalThis.prepareProposalDraftParcelSelection,
            open: globalThis.openReparcellizationModal,
            pending: globalThis.pendingReparcellizationPlan
        };
        globalThis.prepareProposalDraftParcelSelection = async () => ({
            ids: selectionIds.slice(),
            layers: selectionIds.map(id => ({ feature: { properties: { parcel_id: id } } }))
        });
        globalThis.openReparcellizationModal = async () => true;
        try {
            await reparcellizationAdapter.openDesignEditor(draft);
            return globalThis.pendingReparcellizationPlan;
        } finally {
            globalThis.prepareProposalDraftParcelSelection = saved.prepare;
            globalThis.openReparcellizationModal = saved.open;
            globalThis.pendingReparcellizationPlan = saved.pending;
        }
    }

    it('keeps the pooled parcels the plan recorded, not the ones the map resolves', async () => {
        const draft = draftFor(reparcellizationAdapter, proposal());
        const plan = await openWith(draft, CHILDREN);
        expect(plan.parcelIds).toEqual(POOLED);
        expect(plan.parcelIds.some(id => id.includes('#'))).toBe(false);
    });

    it('falls back to the proposal parents when a plan has no record of its inputs', async () => {
        const draft = draftFor(reparcellizationAdapter, proposal({ parcelIds: [] }));
        const plan = await openWith(draft, CHILDREN);
        expect(plan.parcelIds).toEqual(POOLED);
    });

    // The remaining branch — no record, no parents, so the live selection IS the input — is not
    // reachable from here: prepareProposalDraftParcelSelection is module-local, so it cannot be
    // stubbed and under node it resolves to nothing. Covered by the browser instead.

    it('reopens a saved plan even when none of its parcels are on the map', async () => {
        const draft = draftFor(reparcellizationAdapter, proposal());
        const plan = await openWith(draft, []);
        expect(plan.parcelIds).toEqual(POOLED);
    });

    it('still refuses a plan that has neither polygons nor parcels to work from', async () => {
        const draft = draftFor(reparcellizationAdapter, proposal({ polygons: [] }));
        await expect(openWith(draft, [])).rejects.toThrow(/not available/i);
    });
});

// Site-first drafts (PARCEL-OPTIONAL.md, phase 2): the draft carries the site; with no live
// selection the declaration is the site's binding (possibly empty on bare ground), synthetic design
// parcels of a site never reach it, and material goals need a site where parcel acts need parcels.
describe('site-first drafts', () => {
    const SITE = {
        type: 'MultiPolygon',
        coordinates: [[[[15.97, 45.8], [15.9705, 45.8], [15.9705, 45.8004], [15.97, 45.8004], [15.97, 45.8]]]]
    };
    const POLYGON = { type: 'Polygon', coordinates: SITE.coordinates[0] };
    const siteDraft = (adapter, fields, editorPayload) => ({
        id: 'draft-site', cityId: 'zagreb', goal: adapter.key, adapterKey: adapter.key,
        sourceSnapshot: null,
        fields: { name: 'Pocket park', description: 'x', selectedParcelIds: [], ...fields },
        editorPayload
    });

    it('serializes a park on bare ground with its site and an empty declaration', () => {
        const adapter = buildStructureAdapter('park');
        const draft = siteDraft(adapter, { site: SITE }, { structureProposal: { kind: 'park', geometry: POLYGON } });
        expect(adapter.validate(draft)).toMatchObject({ valid: true });
        const record = adapter.serializeProposal(draft);
        expect(record.site).toEqual(SITE);
        expect(record.cadastreParcelIds).toEqual([]);
        expect(record).not.toHaveProperty('toleranceM');
    });

    it('declares the preview binding of a site over parcels, and carries the tolerance', () => {
        const adapter = buildStructureAdapter('square');
        const binding = { parcels: [{ parcelId: 'HR-1-2' }, { parcelId: 'HR-1-1' }], coverage: 'complete', source: 'client-preview' };
        const record = adapter.serializeProposal(siteDraft(adapter, { site: SITE, binding, toleranceM: 0.05 },
            { structureProposal: { kind: 'square', geometry: POLYGON } }));
        expect(record.cadastreParcelIds).toEqual(['HR-1-1', 'HR-1-2']);
        expect(record.toleranceM).toBe(0.05);
        expect(record.binding.source).toBe('client-preview');
    });

    it('keeps a site\'s synthetic design parcels out of the declaration', () => {
        const adapter = registry.get('parcelBased');
        const plot = { type: 'Feature', properties: {}, geometry: POLYGON };
        const draft = siteDraft(adapter, { site: SITE, selectedParcelIds: ['site-plot:abc:1', 'site-plot:abc:2'] },
            { typology: 'parcelBased', context: { buildings: [plot], parameters: {} } });
        const previousFabric = globalThis.LiveParcelFabric;
        globalThis.LiveParcelFabric = { cadastreIdsForParcelIds: () => { throw new Error('synthetic ids reached the fabric'); } };
        try {
            const record = adapter.serializeProposal(draft);
            expect(record.cadastreParcelIds).toEqual([]);
            expect(record.site).toEqual(SITE);
        } finally {
            if (previousFabric === undefined) delete globalThis.LiveParcelFabric;
            else globalThis.LiveParcelFabric = previousFabric;
        }
    });

    it('asks a material draft for a site and a parcel act for parcels', () => {
        const park = buildStructureAdapter('park');
        const noGround = park.validate(siteDraft(park, {}, {}));
        expect(noGround.errors.map(error => error.code)).toEqual(expect.arrayContaining(['missing-site']));
        const transfer = registry.get('ownership-transfer');
        const act = transfer.validate({ ...siteDraft(transfer, { site: SITE }, {}), goal: 'ownership-transfer' });
        expect(act.errors.map(error => error.code)).toContain('missing-parcels');
    });

    it('moves physical structures to a new site and stamps only fresh authoritative binding parcels', () => {
        const adapter = buildStructureAdapter('park');
        const source = {
            proposalId: 'park-source', goal: 'park', title: 'Old park',
            site: SITE, cadastreParcelIds: ['old-parcel'],
            serverProposalId: 41, isMinted: true, onchainData: { tokenId: 'old-token' },
            chainId: 'old-chain', lifecycleStatus: 'published', effectiveStatus: 'Published',
            preparation: { id: 'stale-preparation' }, effectHash: 'old-effect',
            acceptedParcelIds: ['old-parcel'], ownerAcceptances: { 'old-parcel': true },
            structureProposal: { kind: 'park', geometry: POLYGON, decorations: { trees: [{ id: 'old-tree' }] } }
        };
        const draft = draftFor(adapter, source);
        const relocated = {
            type: 'MultiPolygon',
            coordinates: [[[[16.1, 45.9], [16.101, 45.9], [16.101, 45.901], [16.1, 45.901], [16.1, 45.9]]]]
        };
        const patch = freePlacementPatch(draft, { free: true, site: relocated });
        Object.assign(draft, {
            fields: { ...draft.fields, ...patch.fields, binding: {
                source: 'server:live-cadastre', coverage: 'partial',
                parcels: [{ parcelId: 'new-parcel' }]
            } },
            editorPayload: { ...draft.editorPayload, placement: { ...patch.placement, bindingStatus: 'bound' } }
        });

        const moved = adapter.serializeProposal(draft);
        expect(moved.site).toEqual(relocated);
        expect(moved.cadastreParcelIds).toEqual(['new-parcel']);
        expect(moved.structureProposal.decorations).toEqual({ trees: [{ id: 'old-tree' }] });
        expect(moved).not.toHaveProperty('preparation');
        expect(moved).not.toHaveProperty('effectHash');
        expect(moved).not.toHaveProperty('acceptedParcelIds');
        expect(moved).not.toHaveProperty('ownerAcceptances');
        expect(moved).not.toHaveProperty('serverProposalId');
        expect(moved).not.toHaveProperty('isMinted');
        expect(moved).not.toHaveProperty('onchainData');
        expect(moved).not.toHaveProperty('chainId');
        expect(moved).not.toHaveProperty('lifecycleStatus');
        expect(source.site).toEqual(SITE);
        expect(source.cadastreParcelIds).toEqual(['old-parcel']);
    });

    it('accepts a fresh known empty server binding and rejects pending, unknown, or client-only binding', () => {
        const adapter = buildStructureAdapter('square');
        const draft = siteDraft(adapter, { site: SITE, selectedParcelIds: ['source-live'] }, {
            structureProposal: { kind: 'square', geometry: POLYGON, selectedParcelIds: ['source-live'] }
        });
        draft.sourceSnapshot = { goal: 'square', site: SITE, cadastreParcelIds: ['source-parcel'] };
        draft.editorPayload.placement = { free: true, site: SITE, bindingStatus: 'pending' };
        draft.fields.binding = null;
        expect(adapter.validate(draft).errors.map(error => error.code)).toContain('placement-binding-pending');
        const bound = markFreePlacementBound(draft, { source: 'server:live-cadastre', coverage: 'none', parcels: [] });
        draft.fields = { ...draft.fields, ...bound.fields };
        draft.editorPayload = { ...draft.editorPayload, ...bound.editorPayload };
        expect(adapter.validate(draft).valid).toBe(true);
        const moved = adapter.serializeProposal(draft);
        expect(moved.cadastreParcelIds).toEqual([]);
        expect(moved.fields).toBeUndefined();
        const unknown = { source: 'server:live-cadastre', coverage: 'unknown', parcels: [] };
        expect(() => markFreePlacementBound(draft, unknown)).toThrow(/cannot verify this site/i);
        expect(() => markFreePlacementBound(draft, { source: 'server:live-cadastre', parcels: [] }))
            .toThrow(/did not confirm its cadastral coverage/i);
        draft.fields.binding = unknown;
        draft.editorPayload.placement.bindingStatus = 'bound';
        expect(adapter.validate(draft).errors.map(error => error.code)).toContain('placement-binding-unknown');
        expect(() => markFreePlacementBound(draft, { source: 'client-preview', parcels: [] }))
            .toThrow(/authoritative/i);
    });

    it('restores an unknown server binding as pending rather than verified', () => {
        const adapter = buildStructureAdapter('park');
        const seed = adapter.draftFromProposal({
            proposalId: 'unknown-site', goal: 'park', title: 'Unverified site', freePlacement: true,
            site: SITE, cadastreParcelIds: [], binding: { source: 'server:live-cadastre', coverage: 'unknown', parcels: [] },
            structureProposal: { kind: 'park', geometry: POLYGON }
        });
        expect(seed.editorPayload.placement.bindingStatus).toBe('pending');
        expect(adapter.validate({ ...seed, adapterKey: 'park', goal: 'park' }).errors.map(error => error.code))
            .toContain('placement-binding-unknown');
    });

    it('does not reject whole-parcel single-building movement', () => {
        const adapter = buildBuildingAdapter('single');
        const draft = draftFor(adapter, {
            proposalId: 'whole-source', goal: 'single', title: 'Whole building',
            site: SITE, cadastreParcelIds: ['old-parcel'],
            buildingProposal: { typologyType: 'single', takeWholeParcels: true },
            geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: POLYGON }] }
        });
        expect(freePlacementPatch(draft, { free: true, site: SITE })).toMatchObject({
            fields: { selectedParcelIds: [], cadastreParcelIds: [] }
        });
    });

    it('keeps source-aware existing buildings and parcel-only designs out of free placement', () => {
        const buildingAdapter = buildBuildingAdapter('single');
        const existing = draftFor(buildingAdapter, {
            proposalId: 'existing-source', goal: 'single', title: 'Existing building',
            site: SITE, cadastreParcelIds: ['source-parcel'],
            buildingProposal: { typologyType: 'single', parameters: { mode: 'existing' } },
            geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: POLYGON }] }
        });
        expect(() => freePlacementPatch(existing, { free: true, site: SITE }))
            .toThrow(/existing-building proposals/i);

        const parcelBased = draftFor(registry.get('parcelBased'), {
            proposalId: 'parcel-source', goal: 'parcelBased', title: 'Parcel design',
            site: SITE, cadastreParcelIds: ['source-parcel'],
            buildingProposal: { typologyType: 'parcelBased' },
            geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: POLYGON }] }
        });
        expect(() => freePlacementPatch(parcelBased, { free: true, site: SITE }))
            .toThrow(/fixed site/i);
    });

    it('round-trips a moved single-building site and ground boundary through save and reopen without source parcels', async () => {
        const adapter = buildBuildingAdapter('single');
        const source = {
            proposalId: 'single-source', goal: 'single', title: 'Source building',
            site: SITE, cadastreParcelIds: ['source-parcel'],
            geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: POLYGON }] },
            buildingProposal: { typologyType: 'single', takeWholeParcels: true, parameters: { typology: 'single' } }
        };
        const draft = draftFor(adapter, source);
        const placement = freePlacementPatch(draft, { free: true, site: SITE });
        draft.fields = { ...draft.fields, ...placement.fields, binding: {
            source: 'server:live-cadastre', coverage: 'none', parcels: []
        } };
        draft.editorPayload = {
            ...draft.editorPayload,
            placement: { ...placement.placement, bindingStatus: 'bound' },
            context: {
                ...draft.editorPayload.context,
                groundBoundary: { type: 'Feature', properties: { role: 'ground-boundary' }, geometry: POLYGON },
                groundSurface: { treatment: 'green', polygon: POLYGON },
                takeWholeParcels: true
            }
        };
        const saved = adapter.serializeProposal(draft);
        saved.proposalId = 'moved-single';
        expect(saved.freePlacement).toBe(true);
        expect(saved.site).toEqual(SITE);
        expect(saved.cadastreParcelIds).toEqual([]);
        expect(saved.geometry.groundBoundary).toEqual(draft.editorPayload.context.groundBoundary);
        expect(saved.buildingProposal.takeWholeParcels).toBe(true);

        const reopenedSeed = adapter.draftFromProposal(saved);
        expect(reopenedSeed.editorPayload.placement).toEqual({ free: true, site: SITE, bindingStatus: 'bound' });
        expect(reopenedSeed.fields.binding).toEqual(saved.binding);
        expect(reopenedSeed.fields.selectedParcelIds).toEqual([]);
        const reopened = {
            id: 'reopened-single', sourceProposalId: 'moved-single', sourceSnapshot: saved,
            cityId: 'zagreb', adapterKey: 'single', goal: 'single', ...reopenedSeed
        };
        const previous = {
            open: globalThis.openSingleBuildingForParcels,
            pending: globalThis.pendingBuildingProposalContext
        };
        const open = vi.fn(async () => true);
        globalThis.openSingleBuildingForParcels = open;
        try {
            await expect(adapter.openDesignEditor(reopened)).resolves.toBe(true);
            expect(open).toHaveBeenCalledWith(expect.objectContaining({
                parcelIds: [], site: SITE, initialBuildings: saved.geometry.buildings,
                placement: { free: true, site: SITE },
                initialGroundBoundary: saved.geometry.groundBoundary,
                initialGroundTreatment: 'green', initialTakeWholeParcels: true
            }));
        } finally {
            if (previous.open === undefined) delete globalThis.openSingleBuildingForParcels;
            else globalThis.openSingleBuildingForParcels = previous.open;
            if (previous.pending === undefined) delete globalThis.pendingBuildingProposalContext;
            else globalThis.pendingBuildingProposalContext = previous.pending;
        }
    });

    it('round-trips a relocated block massing Feature with its properties', async () => {
        const adapter = buildBuildingAdapter('buildings');
        const blockMassing = {
            type: 'Feature',
            properties: { manual: true, sourceShape: 'courtyard-block', height: 18 },
            geometry: POLYGON
        };
        const source = {
            proposalId: 'block-source', goal: 'buildings', typologyType: 'block', title: 'Block',
            site: SITE, cadastreParcelIds: ['source-parcel'],
            geometry: { buildings: [blockMassing], blockMassing },
            buildingProposal: { typologyType: 'block', parameters: { mode: 'manual' } }
        };
        const draft = draftFor(adapter, source);
        const placement = freePlacementPatch(draft, { free: true, site: SITE });
        draft.fields = { ...draft.fields, ...placement.fields, binding: { source: 'server:live-cadastre', coverage: 'none', parcels: [] } };
        draft.editorPayload = { ...draft.editorPayload, placement: { ...placement.placement, bindingStatus: 'bound' } };
        const saved = adapter.serializeProposal(draft);
        expect(saved.freePlacement).toBe(true);
        expect(saved.geometry.blockMassing).toEqual(blockMassing);
        expect(saved.geometry.buildings[0].properties).toEqual(blockMassing.properties);

        const reopenedSeed = adapter.draftFromProposal(saved);
        const reopened = {
            id: 'reopened-block', sourceProposalId: saved.proposalId, sourceSnapshot: saved,
            cityId: 'zagreb', adapterKey: 'buildings', goal: 'buildings', ...reopenedSeed
        };
        const previous = { open: globalThis.openUrbanRuleForParcels, seed: globalThis.buildBlockifySeed };
        const open = vi.fn(async () => true);
        globalThis.buildBlockifySeed = context => ({
            mode: 'manual',
            manualOuterRing: context.buildingFeature.geometry.coordinates[0].slice(0, -1),
            blockMassingFeature: context.buildingFeature
        });
        globalThis.openUrbanRuleForParcels = open;
        try {
            await expect(adapter.openDesignEditor(reopened)).resolves.toBe(true);
            expect(open).toHaveBeenCalledWith(expect.objectContaining({ parcelIds: [], placement: { free: true, site: SITE } }));
            expect(open.mock.calls[0][0].initialState.blockMassingFeature).toEqual(blockMassing);
            expect(open.mock.calls[0][0].initialState.blockMassing).toEqual(blockMassing);
        } finally {
            if (previous.open === undefined) delete globalThis.openUrbanRuleForParcels;
            else globalThis.openUrbanRuleForParcels = previous.open;
            if (previous.seed === undefined) delete globalThis.buildBlockifySeed;
            else globalThis.buildBlockifySeed = previous.seed;
        }
    });

    it('reopens a relocated row with the saved row feature rather than replacing it with its site', async () => {
        const adapter = buildBuildingAdapter('row');
        const row = {
            type: 'Feature',
            properties: { manual: true, rowShape: 'stepped' },
            geometry: POLYGON
        };
        const source = {
            proposalId: 'row-source', goal: 'buildings', typologyType: 'row', title: 'Row',
            site: SITE, cadastreParcelIds: ['source-parcel'], geometry: { buildings: [row] },
            buildingProposal: { typologyType: 'row', parameters: { floors: 2 } }
        };
        const draft = draftFor(adapter, source);
        const placement = freePlacementPatch(draft, { free: true, site: SITE });
        draft.fields = { ...draft.fields, ...placement.fields, binding: { source: 'server:live-cadastre', coverage: 'none', parcels: [] } };
        draft.editorPayload = { ...draft.editorPayload, placement: { ...placement.placement, bindingStatus: 'bound' } };
        const saved = adapter.serializeProposal(draft);
        const reopenedSeed = adapter.draftFromProposal(saved);
        const reopened = {
            id: 'reopened-row', sourceProposalId: saved.proposalId, sourceSnapshot: saved,
            cityId: 'zagreb', adapterKey: 'row', goal: 'row', ...reopenedSeed
        };
        const previous = globalThis.openRowHouseForParcels;
        const open = vi.fn(async () => true);
        globalThis.openRowHouseForParcels = open;
        try {
            await expect(adapter.openDesignEditor(reopened)).resolves.toBe(true);
            expect(open).toHaveBeenCalledWith(expect.objectContaining({
                parcelIds: [], site: expect.objectContaining({ type: 'Feature', geometry: SITE }),
                initialFeature: row, placement: { free: true, site: SITE }
            }));
            expect(saved.geometry.buildings).toEqual([row]);
        } finally {
            if (previous === undefined) delete globalThis.openRowHouseForParcels;
            else globalThis.openRowHouseForParcels = previous;
        }
    });

    it('fails instead of silently dropping authored surroundings outside the moved site', () => {
        const adapter = buildBuildingAdapter('single');
        const source = {
            proposalId: 'single-ground-source', goal: 'single', title: 'Building',
            site: SITE, cadastreParcelIds: ['source-parcel'],
            geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: POLYGON }] },
            buildingProposal: { typologyType: 'single' }
        };
        const draft = draftFor(adapter, source);
        const outside = { type: 'Polygon', coordinates: [[
            [16.2, 45.9], [16.201, 45.9], [16.201, 45.901], [16.2, 45.901], [16.2, 45.9]
        ]] };
        draft.editorPayload.placement = { free: true, site: SITE, bindingStatus: 'bound' };
        draft.fields.binding = { source: 'server:live-cadastre', coverage: 'complete', parcels: [] };
        draft.editorPayload.context.groundSurface = { treatment: 'green', polygon: outside };

        expect(() => adapter.serializeProposal(draft)).toThrow(/surroundings must fit/i);
    });
});

describe('free-placement binding handoff', () => {
    const SITE = {
        type: 'MultiPolygon',
        coordinates: [[[[16.1, 45.9], [16.101, 45.9], [16.101, 45.901], [16.1, 45.901], [16.1, 45.9]]]]
    };

    function makeDraft() {
        return {
            id: 'moved-draft', goal: 'park', adapterKey: 'park', cityId: 'zagreb',
            fields: { site: SITE, selectedParcelIds: [], cadastreParcelIds: [], binding: null },
            editorPayload: { placement: { free: true, site: SITE, bindingStatus: 'pending' } }
        };
    }

    function loadRebind(store, bindingResponse) {
        const bindingRequest = vi.fn(async () => bindingResponse);
        const placementApi = require('../../frontend/js/proposal-editor-adapters.js');
        const global = {
            proposalDraftStore: store,
            proposalDraftPlacement: {
                isFreePlacementDraft: placementApi.isFreePlacementDraft,
                freePlacementPatch: placementApi.freePlacementPatch,
                markFreePlacementBound: placementApi.markFreePlacementBound
            },
            __publishBinding: { createFetchBinding: () => bindingRequest },
            resolveBackendBaseUrl: () => 'https://example.test/api',
            fetch: vi.fn(),
            CityConfigManager: { getCurrentCityId: () => 'zagreb' }
        };
        const prefix = `const placementBindingInFlight = new Map(); function currentCityId(){ return 'zagreb'; } function tDraft(_key, fallback){ return fallback; }`;
        const fn = loadProposalEditorShellFunction('rebindFreePlacementDraft', { global }, prefix);
        return { fn, bindingRequest };
    }

    it('rebinds before use and preserves an authoritative empty destination result', async () => {
        const draft = makeDraft();
        const store = {
            getDraft: () => structuredClone(draft),
            updateDraft: (_id, patch) => {
                Object.assign(draft, patch);
                if (patch.fields) draft.fields = { ...draft.fields, ...patch.fields };
                if (patch.editorPayload) draft.editorPayload = { ...draft.editorPayload, ...patch.editorPayload };
                return structuredClone(draft);
            },
            validateDraft: () => structuredClone(draft)
        };
        const { fn, bindingRequest } = loadRebind(store, {
            source: 'server:live-cadastre', coverage: 'none', parcels: []
        });

        const rebound = await fn(draft.id);

        expect(bindingRequest).toHaveBeenCalledWith(expect.objectContaining({ site: SITE, city: 'zagreb' }));
        expect(rebound.editorPayload.placement.bindingStatus).toBe('bound');
        expect(rebound.fields.binding.source).toBe('server:live-cadastre');
        expect(rebound.fields.cadastreParcelIds).toEqual([]);
    });

    it('does not stamp a binding response after the user changes the site in flight', async () => {
        const draft = makeDraft();
        let releaseBinding;
        const pending = new Promise(resolve => { releaseBinding = resolve; });
        const store = {
            getDraft: () => structuredClone(draft),
            updateDraft: vi.fn(() => { throw new Error('stale response must not update draft'); }),
            validateDraft: () => structuredClone(draft)
        };
        const { fn } = loadRebind(store, pending);
        const request = fn(draft.id);
        await Promise.resolve();
        draft.editorPayload.placement.site = {
            type: 'MultiPolygon',
            coordinates: [[[[16.2, 45.9], [16.201, 45.9], [16.201, 45.901], [16.2, 45.901], [16.2, 45.9]]]]
        };
        releaseBinding({ source: 'server:live-cadastre', parcels: [] });
        await expect(request).rejects.toThrow(/geometry changed/i);
        expect(store.updateDraft).not.toHaveBeenCalled();
    });

    it('keeps the draft unchanged when authoritative rebinding fails', async () => {
        const draft = makeDraft();
        const original = structuredClone(draft);
        const store = {
            getDraft: () => structuredClone(draft),
            updateDraft: vi.fn(),
            validateDraft: vi.fn(() => structuredClone(draft))
        };
        const { fn } = loadRebind(store, Promise.reject(new Error('cadastre unavailable')));

        await expect(fn(draft.id)).rejects.toThrow(/cadastre unavailable/i);
        expect(store.updateDraft).not.toHaveBeenCalled();
        expect(draft).toEqual(original);
    });

    it('refuses unknown or missing server coverage without stamping a false bound state', async () => {
        for (const binding of [
            { source: 'server:live-cadastre', coverage: 'unknown', parcels: [] },
            { source: 'server:live-cadastre', parcels: [] }
        ]) {
            const draft = makeDraft();
            const original = structuredClone(draft);
            const store = {
                getDraft: () => structuredClone(draft),
                updateDraft: vi.fn(),
                validateDraft: vi.fn(() => structuredClone(draft))
            };
            const { fn, bindingRequest } = loadRebind(store, binding);

            await expect(fn(draft.id)).rejects.toThrow(/coverage|cannot verify/i);
            expect(bindingRequest).toHaveBeenCalledOnce();
            expect(store.updateDraft).not.toHaveBeenCalled();
            expect(draft).toEqual(original);
        }
    });
});

describe('published source identity classification', () => {
    it('does not treat a generic hash as publication, but recognizes immutable published records', () => {
        expect(isPublishedProposalRecord({ proposalId: 'local-1', hash: 'content-hash' })).toBe(false);
        expect(isPublishedProposalRecord({ serverProposalId: 51 })).toBe(true);
        expect(isPublishedProposalRecord({ lifecycleStatus: 'published' })).toBe(true);
    });
});

describe('reparcellization publish handoff', () => {
    it('restores transient parcel IDs when staging a saved plan for terms', async () => {
        const shellPath = '../../frontend/js/proposal-editor-shell.js';
        const previous = {
            proposalDraftStore: globalThis.proposalDraftStore,
            prepare: globalThis.prepareProposalDraftParcelSelection,
            show: globalThis.showProposalDialog,
            pending: globalThis.pendingReparcellizationPlan,
            draftId: globalThis.pendingProposalDraftId,
            source: globalThis.pendingProposalReplacementSource
        };
        const plan = {
            algorithm: 'amend',
            inputParcels: [{ label: 'A', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }],
            polygons: [{ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }, jointPool: true }]
        };
        const draft = {
            id: 'draft-handoff', goal: 'reparcellization', adapterKey: 'reparcellization',
            sourceProposalId: null, sourceSnapshot: {}, revision: 4,
            fields: { selectedParcelIds: ['live-piece-1', 'live-piece-2'], name: 'Block', description: 'Plan', offer: 10, offerCurrency: 'USDT' },
            editorPayload: { plan }, validation: { valid: true }
        };
        let opened = null;
        globalThis.proposalDraftStore = {
            validateDraft: () => draft,
            getPublishReceipt: () => null,
            updateDraft: () => draft,
            markPublishFailed: () => {}
        };
        globalThis.prepareProposalDraftParcelSelection = async () => ({
            ids: draft.fields.selectedParcelIds.slice(),
            layers: draft.fields.selectedParcelIds.map(id => ({ feature: { properties: { parcel_id: id } } }))
        });
        globalThis.showProposalDialog = overrides => { opened = overrides; };
        delete globalThis.pendingReparcellizationPlan;
        delete globalThis.pendingProposalDraftId;
        delete globalThis.pendingProposalReplacementSource;
        delete require.cache[require.resolve(shellPath)];
        require(shellPath);
        try {
            await globalThis.stageProposalDraftForPublishing(draft.id);
            expect(opened.geometryPreset.submitted).toBe(true);
            expect(plan).not.toHaveProperty('parcelIds');
            expect(globalThis.pendingReparcellizationPlan.parcelIds).toEqual(['live-piece-1', 'live-piece-2']);
            expect(globalThis.pendingReparcellizationPlan.inputParcels).toEqual(plan.inputParcels);
            expect(globalThis.pendingReparcellizationPlan.polygons[0].jointPool).toBe(true);
        } finally {
            if (previous.proposalDraftStore === undefined) delete globalThis.proposalDraftStore;
            else globalThis.proposalDraftStore = previous.proposalDraftStore;
            if (previous.prepare === undefined) delete globalThis.prepareProposalDraftParcelSelection;
            else globalThis.prepareProposalDraftParcelSelection = previous.prepare;
            if (previous.show === undefined) delete globalThis.showProposalDialog;
            else globalThis.showProposalDialog = previous.show;
            if (previous.pending === undefined) delete globalThis.pendingReparcellizationPlan;
            else globalThis.pendingReparcellizationPlan = previous.pending;
            if (previous.draftId === undefined) delete globalThis.pendingProposalDraftId;
            else globalThis.pendingProposalDraftId = previous.draftId;
            if (previous.source === undefined) delete globalThis.pendingProposalReplacementSource;
            else globalThis.pendingProposalReplacementSource = previous.source;
        }
    });

    it('resumes a persisted agreement batch without requiring replaced live pieces', async () => {
        const shellPath = '../../frontend/js/proposal-editor-shell.js';
        const previous = {
            proposalDraftStore: globalThis.proposalDraftStore,
            prepare: globalThis.prepareProposalDraftParcelSelection,
            show: globalThis.showProposalDialog,
            pending: globalThis.pendingReparcellizationPlan
        };
        const plan = {
            algorithm: 'amend',
            inputParcels: [{ label: 'A', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }],
            polygons: [{ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }, jointPool: true }]
        };
        const draft = {
            id: 'draft-batch-retry', goal: 'reparcellization', adapterKey: 'reparcellization',
            sourceSnapshot: {}, revision: 2,
            fields: { selectedParcelIds: ['replaced-live-piece'], name: 'Block', description: 'Plan', offer: 10, offerCurrency: 'USDT' },
            editorPayload: { plan }, publish: { parcelAgreementBatch: { groupId: 'group-1', items: [] } },
            validation: { valid: true }
        };
        let prepareCalls = 0;
        let opened = 0;
        globalThis.proposalDraftStore = {
            validateDraft: () => draft,
            getPublishReceipt: () => null,
            updateDraft: () => draft,
            markPublishFailed: () => {}
        };
        globalThis.prepareProposalDraftParcelSelection = async () => { prepareCalls += 1; throw new Error('must not resolve replaced pieces'); };
        globalThis.showProposalDialog = () => { opened += 1; };
        delete globalThis.pendingReparcellizationPlan;
        delete require.cache[require.resolve(shellPath)];
        require(shellPath);
        try {
            await globalThis.stageProposalDraftForPublishing(draft.id);
            expect(prepareCalls).toBe(0);
            expect(opened).toBe(1);
            expect(globalThis.pendingReparcellizationPlan.parcelIds).toEqual(['replaced-live-piece']);
        } finally {
            if (previous.proposalDraftStore === undefined) delete globalThis.proposalDraftStore;
            else globalThis.proposalDraftStore = previous.proposalDraftStore;
            if (previous.prepare === undefined) delete globalThis.prepareProposalDraftParcelSelection;
            else globalThis.prepareProposalDraftParcelSelection = previous.prepare;
            if (previous.show === undefined) delete globalThis.showProposalDialog;
            else globalThis.showProposalDialog = previous.show;
            if (previous.pending === undefined) delete globalThis.pendingReparcellizationPlan;
            else globalThis.pendingReparcellizationPlan = previous.pending;
        }
    });
});

// Saving a local LR preview must use the same per-owner money as its later terms and child agreements.
it('serializes LR compensation from owner cents, including a cash-free land exchange', () => {
    const proposal = {
        proposalId: 'ledger-source', goal: 'reparcellization', primaryType: 'Reparcellization',
        cadastreParcelIds: ['cadastre-a'], offer: 9999, offerCurrency: 'USDT',
        reparcellization: {
            polygons: [{ ownerKey: 'a', owners: [{ ownerKey: 'a', share: 1 }],
                geometry: turf.bboxPolygon([0, 0, 1, 1]).geometry }],
            ownerShares: [{ ownerKey: 'a', cashOffer: 12.34 }, { ownerKey: 'b', cashOffer: 0.01 }]
        }
    };
    const draft = draftFor(reparcellizationAdapter, proposal);
    expect(reparcellizationAdapter.serializeProposal(draft)).toMatchObject({
        offer: 12.35, budget: 12.35, offerCurrency: 'EUR', budgetCurrency: 'EUR'
    });
    draft.editorPayload.plan.ownerShares.forEach(owner => { owner.cashOffer = 0; });
    expect(reparcellizationAdapter.serializeProposal(draft)).toMatchObject({ offer: 0, budget: 0 });
    expect(proposal.offer).toBe(9999);
});
