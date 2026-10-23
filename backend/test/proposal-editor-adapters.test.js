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
const { isPublished: isPublishedProposalRecord } = require('../../frontend/js/proposals/lineage.js');

const {
    CREATABLE_PROPOSAL_GOALS,
    registry,
    corridorAdapter,
    buildBuildingAdapter,
    parcelLayoutAdapter,
    buildStructureAdapter,
    freePlacementPatch,
    isFreePlacementDraft,
    markFreePlacementBound,
    summarizeCommonChanges
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
        sourceLocalProposalId: source.proposalId,
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

describe('change summary source identity', () => {
    it('names the source by its local key, never by a chain token, a row\'s authored id or a hash', () => {
        const source = { goal: 'as-is', cadastreParcelIds: ['HR-1-100'], chainProposalId: 'solana-devnet-7', proposal_id: 'authored-7', hash: 'content-hash' };
        const summary = summarizeCommonChanges(source, { id: 'draft-1', fields: {} });
        expect(summary.sourceLocalProposalId).toBeNull();
        expect(summary.sourceName).toBe('');
        expect(summarizeCommonChanges({ ...source, proposalId: 'local-7' }, { id: 'draft-1', fields: {} }))
            .toMatchObject({ sourceLocalProposalId: 'local-7', sourceName: 'local-7' });
    });
});

describe('proposal editor adapter registry', () => {
    it('registers every creatable proposal goal', () => {
        expect(registry.completeness(CREATABLE_PROPOSAL_GOALS)).toEqual({ complete: true, missing: [] });
    });

    it('has no editor for a goal it does not register', () => {
        expect(registry.get('merge')).toBeNull();
        expect(registry.canEdit({ goal: 'merge' })).toEqual({ editable: false, reason: 'No editor adapter is registered for this proposal type.' });
        expect(registry.list().map(entry => entry.key)).toEqual(expect.arrayContaining(['road-track', 'parcel-layout', 'park']));
    });

    it('normalizes aliases to the same adapter', () => {
        expect(registry.get('road')).toBe(registry.get('road-track'));
        expect(registry.get('parcel-based')).toBe(registry.get('parcelBased'));
        expect(registry.get('ownership-transfer-from-me')).toBe(registry.get('ownership-transfer'));
    });

    it('selects an editor for persisted records from the canonical goal field only', () => {
        expect(registry.get({ goal: 'park', type: 'urban-rule' })).toBe(registry.get('park'));
        expect(registry.get({ proposalType: 'park', type: 'park', structureProposal: { kind: 'park' } })).toBeNull();
        expect(registry.get({ goal: 'Transit Station', typologyType: 'station' })).toBeNull();
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

    it('serializes the road as its view, which the store row encodes as the record (roads.md §11) and reads back unchanged', () => {
        expect(corridorAdapter.canEdit(proposal)).toBe(true);
        const draft = draftFor(corridorAdapter, proposal);
        const replacement = corridorAdapter.serializeProposal(draft);
        const osmForm = require('../../frontend/js/corridor-osm-form.js');
        const P = require('../../frontend/js/corridor-profile.js');

        const served = replacement.roadProposal.definition;
        expect(served.osm).toBeUndefined();
        expect(served.points).toEqual(proposal.roadProposal.definition.points);
        const record = osmForm.toRecord(served);
        osmForm.VIEW_FIELDS.forEach(field => expect(record[field], field).toBeUndefined());
        expect(record.osm.elements.filter(element => element.type === 'way')).toHaveLength(1);
        expect(record).toMatchObject({ tunnels: proposal.roadProposal.definition.tunnels, polygon: proposal.roadProposal.definition.polygon, metadata: proposal.roadProposal.definition.metadata });
        const view = osmForm.toView(record);
        expect(view.points).toEqual(proposal.roadProposal.definition.points);
        expect(view.segmentIds).toEqual(['segment-a']);
        expect(JSON.stringify(P.normalizeCorridorProfile(view.profile))).toBe(JSON.stringify(P.normalizeCorridorProfile(proposal.roadProposal.definition.profile)));
        expect(view.width).toBe(12);
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
            geometry: { ...proposal.geometry, groundSurface: { treatment: 'green', polygon: feature.geometry } },
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
            expect(openOptions.initialGroundTreatment).toBe('green');

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
    describe('building surroundings', () => {
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

        it.each(['single', 'block', 'row', 'parcelBased'])('round-trips surroundings for %s designs', typology => {
            const adapter = buildBuildingAdapter('single');
            const draft = draftFor(adapter, freeform);
            draft.editorPayload = { ...draft.editorPayload, typology };
            const saved = adapter.serializeProposal(draft);
            expect(saved.geometry.groundSurface).toEqual(groundSurface);
            expect(adapter.draftFromProposal(saved).editorPayload.context.groundSurface).toEqual(groundSurface);
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
                geometry: { ...freeform.geometry, landTake: freeform.geometry.buildings[0] }
            };
            const draft = draftFor(adapter, source);

            expect(draft.editorPayload.context.landTake).toEqual(source.geometry.landTake);
            draft.editorPayload.context.landTake = null;
            const saved = adapter.serializeProposal(draft);
            expect(saved.geometry.landTake).toBeUndefined();
            expect(saved.buildingProposal.takeWholeParcels).toBeUndefined();
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
            id: 'saved-block-edit', sourceLocalProposalId: 'proposal-block', adapterKey: 'buildings', goal: 'buildings',
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

    it('switches generated and existing-building snapshots, both on the block\'s own site', () => {
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

        // A Block is never a free placement (proposals/freeform-conversion.js): the generated mode
        // stays on the same site and parcels as the existing-building mode.
        sync('building', {
            parcelIds: ['source-parcel'], parameters: { mode: 'parametric', typology: 'block' },
            buildings: [footprint], placement: { free: false, site }
        });
        expect(draft.editorPayload.context.parameters.mode).toBe('parametric');
        expect(draft.editorPayload.placement).toBeNull();
        expect(draft.fields.site).toEqual(siteApi.toMultiPolygon(site));
        expect(draft.fields.selectedParcelIds).toEqual(['source-parcel']);
    });

    it('does not replace source selection anchors with transient live child parcels', () => {
        const draft = {
            id: 'saved-single-edit', sourceLocalProposalId: 'proposal-1', adapterKey: 'single', goal: 'single',
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
            id: 'saved-lake-edit', sourceLocalProposalId: 'lake-1', adapterKey: 'lake', goal: 'lake',
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
        const activeDraft = { id: 'incumbent-draft', sourceLocalProposalId: 'proposal-1' };
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

describe('parcel-layout adapter', () => {
    const square = (x0, x1) => ({ type: 'Polygon', coordinates: [[[x0, 45.8], [x1, 45.8], [x1, 45.81], [x0, 45.81], [x0, 45.8]]] });
    const plots = [
        { geometry: square(15.9, 15.905), area: 1, source: 'manual' },
        { geometry: square(15.905, 15.91), area: 1, source: 'manual' }
    ];
    const pool = square(15.9, 15.91);
    const proposal = {
        proposalId: 'layout-1',
        city: 'zagreb',
        goal: 'parcel-layout',
        primaryType: 'ParcelLayout',
        title: 'Lay out the block',
        cadastreParcelIds: ['p1', 'p2'],
        parcelLayout: { algorithm: 'manual', pool, totalArea: 2, plots }
    };

    it('is registered under its own key with only the design, parcels and details sections', () => {
        const adapter = registry.get('parcel-layout');
        expect(adapter.key).toBe('parcel-layout');
        expect(registry.get(proposal)).toBe(adapter);
        expect(adapter.sections).toEqual(['design', 'parcels', 'details']);
        expect(adapter.label).toBe('Parcel layout');
        expect(registry.get('reparcellization')).toBeNull();
    });

    it('reopens and serializes saved plots as geometry only, without terms', () => {
        const draft = draftFor(parcelLayoutAdapter, proposal);
        expect(draft.fields).not.toHaveProperty('offer');
        expect(draft.fields).not.toHaveProperty('approvalConfig');
        draft.editorPayload.plan.parcelIds = ['live-1'];
        draft.fields = { ...draft.fields, offer: 10, offerCurrency: 'EUR', approvalConfig: { schema: 'proposal-approval/v1' }, lens: ['k'] };
        const record = parcelLayoutAdapter.serializeProposal(draft);

        expect(record.goal).toBe('parcel-layout');
        expect(record.primaryType).toBe('ParcelLayout');
        expect(record.parcelLayout.plots).toEqual(plots);
        expect(record.parcelLayout.pool).toEqual(pool);
        expect(record.parcelLayout).not.toHaveProperty('parcelIds');
        ['offer', 'budget', 'offerCurrency', 'budgetCurrency', 'kind', 'approvalConfig', 'lens', 'isConditional', 'expiresAt']
            .forEach(key => expect(record).not.toHaveProperty(key));
        expect(record).not.toHaveProperty('reparcellization');
    });

    it('validates the geometry with the layout rules', () => {
        const draft = draftFor(parcelLayoutAdapter, proposal);
        expect(parcelLayoutAdapter.validate(draft)).toMatchObject({ valid: true, errors: [] });

        const gap = draftFor(parcelLayoutAdapter, proposal);
        gap.editorPayload.plan.plots = [plots[0]];
        expect(parcelLayoutAdapter.validate(gap).errors.map(error => error.code)).toContain('coverage-gap');

        const overlap = draftFor(parcelLayoutAdapter, proposal);
        overlap.editorPayload.plan.plots = [plots[0], plots[1], { geometry: square(15.902, 15.907), source: 'manual' }];
        expect(parcelLayoutAdapter.validate(overlap).errors.map(error => error.code)).toContain('overlapping-plots');

        const malformed = draftFor(parcelLayoutAdapter, proposal);
        malformed.editorPayload.plan.plots.push({ geometry: { type: 'Polygon', coordinates: [[]] } });
        expect(parcelLayoutAdapter.validate(malformed)).toMatchObject({
            valid: false,
            errors: expect.arrayContaining([expect.objectContaining({ code: 'invalid-plot', path: 'editorPayload.plan' })])
        });

        const empty = draftFor(parcelLayoutAdapter, proposal);
        empty.editorPayload.plan.plots = [];
        expect(parcelLayoutAdapter.validate(empty).errors.map(error => error.code)).toContain('missing-plots');
    });

    it('cannot be edited without plots, previews its plots and summarizes geometry only', () => {
        expect(parcelLayoutAdapter.canEdit({ goal: 'parcel-layout', parcelLayout: { plots: [] } }).editable).toBe(false);
        expect(parcelLayoutAdapter.canEdit(proposal)).toBe(true);

        const draft = draftFor(parcelLayoutAdapter, proposal);
        expect(parcelLayoutAdapter.renderPreview(draft)).toEqual({ kind: 'parcel-layout', viewMode: '2d', plots });

        draft.editorPayload.plan.plots = [{ geometry: pool, source: 'manual' }];
        draft.fields = { ...draft.fields, offer: 99 };
        const summary = parcelLayoutAdapter.summarizeChanges(proposal, draft);
        expect(summary.changedFacets).toEqual([]);
        expect(summary.geometry).toMatchObject({ changed: true, plotCountBefore: 2, plotCountAfter: 1 });
        expect(summary.geometry.afterArea).toBeCloseTo(summary.geometry.beforeArea, 0);
        expect(summary.geometry).not.toHaveProperty('ownershipChanged');
    });
});

// A subdivision (PARCEL-OPTIONAL.md phase 4) is a parcel layout whose pool is its SITE: the bound
// parcels' part and the open ground. Its plots must tile the site, whatever pool the layout carries,
// and its editor opens on the site with the binding's parcels, never on a live selection.
describe('subdivision (parcel layout pooled from a site)', () => {
    const sitePlots = require('../../frontend/js/proposals/site-plots.js');
    const rect = (x0, y0, x1, y1) => ({
        type: 'Polygon',
        coordinates: [[[15.876 + x0 * 1e-4, 43.7537 + y0 * 1e-4], [15.876 + x1 * 1e-4, 43.7537 + y0 * 1e-4],
            [15.876 + x1 * 1e-4, 43.7537 + y1 * 1e-4], [15.876 + x0 * 1e-4, 43.7537 + y1 * 1e-4], [15.876 + x0 * 1e-4, 43.7537 + y0 * 1e-4]]]
    });
    const site = rect(0, 0, 12, 6);
    const plot = geometry => ({ geometry, source: 'equal' });
    const plots = sitePlots.cutPlots(site, { plotWidthM: 20, turf: globalThis.turf }).map(feature => feature.geometry);
    const record = (layoutPlots, pool = site) => ({
        proposalId: 'sub-1',
        city: 'sibenik',
        goal: 'parcel-layout',
        title: 'Subdivide the hole',
        cadastreParcelIds: ['HR-330264-1'],
        site: { type: 'MultiPolygon', coordinates: [site.coordinates] },
        binding: { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'partial', source: 'server' },
        parcelLayout: { algorithm: 'equal', poolSource: 'site', pool, plots: layoutPlots }
    });

    it('accepts plots that tile the site exactly', () => {
        const draft = draftFor(parcelLayoutAdapter, record(plots.map(plot)));
        expect(parcelLayoutAdapter.validate(draft)).toMatchObject({ valid: true, errors: [] });
    });

    it('refuses plots that leave the open part of the site uncovered, even when the layout\'s pool agrees with them', () => {
        // Only the plots over the parcel half: the layout's own pool is that half, the site is not.
        const parcelHalf = rect(0, 0, 6, 6);
        const halfPlots = plots
            .map(geometry => turf.intersect(turf.feature(geometry), turf.feature(parcelHalf)))
            .filter(Boolean).map(feature => plot(feature.geometry));
        const draft = draftFor(parcelLayoutAdapter, record(halfPlots, parcelHalf));
        const result = parcelLayoutAdapter.validate(draft);
        expect(result.valid).toBe(false);
        expect(result.errors.map(error => error.code)).toContain('coverage-gap');
    });

    it('opens the editor on the site with the binding\'s parcels', async () => {
        const calls = [];
        globalThis.openParcelLayoutEditor = async options => { calls.push(options); return true; };
        try {
            const draft = draftFor(parcelLayoutAdapter, record(plots.map(plot)));
            draft.fields.binding = { parcels: [{ parcelId: 'HR-330264-1' }], coverage: 'partial' };
            await expect(parcelLayoutAdapter.openDesignEditor(draft)).resolves.toBe(true);
            expect(calls).toHaveLength(1);
            expect(calls[0].sitePool.boundParcelIds).toEqual(['HR-330264-1']);
            expect(calls[0].sitePool.site).toEqual({ type: 'MultiPolygon', coordinates: [site.coordinates] });
            expect(calls[0].algorithm).toBe('equal');
            expect(calls[0].initialPlots).toHaveLength(plots.length);
            expect(calls[0].pool).toEqual(calls[0].sitePool.site);
            expect(globalThis.pendingParcelLayout.pool).toEqual(calls[0].sitePool.site);
        } finally {
            delete globalThis.openParcelLayoutEditor;
            delete globalThis.pendingParcelLayout;
        }
    });

    it('hands the editor the saved open-ground area, and null when the layout has none', async () => {
        const calls = [];
        globalThis.openParcelLayoutEditor = async options => { calls.push(options); return true; };
        try {
            const saved = record(plots.map(plot));
            saved.parcelLayout.openGroundM2 = 42.5;
            await parcelLayoutAdapter.openDesignEditor(draftFor(parcelLayoutAdapter, saved));
            await parcelLayoutAdapter.openDesignEditor(draftFor(parcelLayoutAdapter, record(plots.map(plot))));
            expect(calls.map(call => call.sitePool.expectedOpenGroundM2)).toEqual([42.5, null]);
        } finally {
            delete globalThis.openParcelLayoutEditor;
            delete globalThis.pendingParcelLayout;
        }
    });
});

// A layout's inputs are the parcels its record declares. The editor opens on that record, and what
// the map happens to have loaded or selected must never redefine it: when it did, an applied layout
// handed the editor its own CHILD parcels as inputs, the pool became the outline of the outputs,
// and the boundary that is supposed to contain the layout was defined by the layout.
describe('parcel-layout inputs survive the trip into the design editor', () => {
    const POOLED = ['HR-335550-1791/25', 'HR-335550-1791/30', 'HR-335550-1791/31'];
    // What the applied layout minted — these are outputs, and must never be mistaken for inputs.
    const CHILDREN = POOLED.map((id, i) => `${id}#p-plan-${i + 1}`);

    function proposal(layoutOverrides = {}) {
        return {
            proposalId: 'p-plan',
            city: 'zagreb',
            goal: 'parcel-layout',
            cadastreParcelIds: POOLED.slice(),
            parcelLayout: {
                totalArea: 1000,
                plots: [
                    { source: 'manual', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }
                ],
                ...layoutOverrides
            }
        };
    }

    // Stand in for the browser globals openDesignEditor reaches for.
    async function openWith(draft, selectionIds) {
        const saved = {
            prepare: globalThis.prepareProposalDraftParcelSelection,
            open: globalThis.openParcelLayoutEditor,
            pending: globalThis.pendingParcelLayout
        };
        globalThis.prepareProposalDraftParcelSelection = async () => ({
            ids: selectionIds.slice(),
            layers: selectionIds.map(id => ({ feature: { properties: { parcel_id: id } } }))
        });
        globalThis.openParcelLayoutEditor = async () => true;
        try {
            await parcelLayoutAdapter.openDesignEditor(draft);
            return globalThis.pendingParcelLayout;
        } finally {
            globalThis.prepareProposalDraftParcelSelection = saved.prepare;
            globalThis.openParcelLayoutEditor = saved.open;
            globalThis.pendingParcelLayout = saved.pending;
        }
    }

    it('keeps the pooled parcels the record declared, not the ones the map resolves', async () => {
        const draft = draftFor(parcelLayoutAdapter, proposal());
        const plan = await openWith(draft, CHILDREN);
        expect(plan.parcelIds).toEqual(POOLED);
        expect(plan.parcelIds.some(id => id.includes('#'))).toBe(false);
    });

    // The remaining branch — no declaration, so the live selection IS the input — is not reachable
    // from here: prepareProposalDraftParcelSelection is module-local, so it cannot be stubbed and
    // under node it resolves to nothing. Covered by the browser instead.

    it('reopens a saved layout even when none of its parcels are on the map', async () => {
        const draft = draftFor(parcelLayoutAdapter, proposal());
        const plan = await openWith(draft, []);
        expect(plan.parcelIds).toEqual(POOLED);
    });

    it('still refuses a layout that has neither plots nor parcels to work from', async () => {
        const draft = draftFor(parcelLayoutAdapter, proposal({ plots: [] }));
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

    it('asks a draft without ground for a site, and never asks a site draft for parcels (M2: no parcel acts)', () => {
        const park = buildStructureAdapter('park');
        const noGround = park.validate(siteDraft(park, {}, {}));
        expect(noGround.errors.map(error => error.code)).toEqual(expect.arrayContaining(['missing-site']));
        const transfer = registry.get('ownership-transfer');
        const onSite = transfer.validate({ ...siteDraft(transfer, { site: SITE }, {}), goal: 'ownership-transfer' });
        expect(onSite.errors.map(error => error.code)).not.toContain('missing-parcels');
        expect(onSite.errors.map(error => error.code)).not.toContain('missing-site');
        const bare = transfer.validate({ ...siteDraft(transfer, {}, {}), goal: 'ownership-transfer' });
        expect(bare.errors.map(error => error.code)).toContain('missing-site');
    });

    it('moves physical structures to a new site and stamps only fresh authoritative binding parcels', () => {
        const adapter = buildStructureAdapter('park');
        const source = {
            proposalId: 'park-source', goal: 'park', title: 'Old park',
            site: SITE, cadastreParcelIds: ['old-parcel'],
            published: { cid: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq', publishedAt: '2026-10-21T10:00:00.000Z', apiBase: 'https://example.test' },
            lifecycleStatus: 'Active',
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
        // A moved design is a new design: it is published, when it is, under its own CID.
        expect(moved).not.toHaveProperty('published');
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

    // This regression uses the reported exact-fit moved ground polygon, whose shared boundary Turf says is not within.
    it('accepts exact moved-site boundaries and rejects outside, malformed, or missing containment geometry', () => {
        const site = { type: 'MultiPolygon', coordinates: [[[
            [15.98240961971112, 45.8004999999987],
            [15.982409619714531, 45.799999999998704],
            [15.983009619714494, 45.80000000000071],
            [15.983009619711197, 45.800500000000696],
            [15.98240961971112, 45.8004999999987]
        ]]] };
        const building = { type: 'Feature', properties: { height: 37 }, geometry: { type: 'Polygon', coordinates: [[
            [15.982487698659497, 45.80008786100589], [15.98296363310726, 45.8000878610073],
            [15.982963634522434, 45.80042075223726], [15.982487697240344, 45.80042075223588],
            [15.982487698659497, 45.80008786100589]
        ]] } };
        const exactGround = { type: 'Polygon', coordinates: [[
            [15.98240961971112, 45.8004999999987], [15.982409619714531, 45.799999999998704],
            [15.983009619714494, 45.80000000000071], [15.983009619713913, 45.800088099707324],
            [15.982963633108275, 45.80008809970721], [15.98296363310726, 45.8000878610073],
            [15.982487698659497, 45.80008786100589], [15.982487697240344, 45.80042075223588],
            [15.982562753480233, 45.8004207522361], [15.982562753479215, 45.80042099093621],
            [15.983009619711718, 45.80042099093729], [15.983009619711197, 45.800500000000696],
            [15.98240961971112, 45.8004999999987]
        ]] };
        const makeDraft = ground => {
            const adapter = buildBuildingAdapter('single');
            const draft = draftFor(adapter, {
                proposalId: 'exact-moved-site', goal: 'single', title: 'Exact fit', site,
                cadastreParcelIds: ['source-parcel'], geometry: { buildings: [building] },
                buildingProposal: { typologyType: 'single' }
            });
            const placement = freePlacementPatch(draft, { free: true, site });
            draft.fields = { ...draft.fields, ...placement.fields, binding: {
                source: 'server:live-cadastre', coverage: 'none', parcels: []
            } };
            draft.editorPayload.placement = { ...placement.placement, bindingStatus: 'bound' };
            draft.editorPayload.context.groundSurface = { treatment: 'green', polygon: ground };
            return { adapter, draft };
        };
        const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
        const siteFeature = feature(site);
        const groundFeature = feature(exactGround);
        const exactDraft = makeDraft(exactGround);

        expect(turf.booleanWithin(groundFeature, siteFeature)).toBe(false);
        expect(turf.difference(groundFeature, siteFeature)).toBeNull();
        expect(exactDraft.adapter.serializeProposal(exactDraft.draft).freePlacement).toBe(true);

        const outside = structuredClone(exactGround);
        outside.coordinates[0][10][0] += 0.000001;
        const outsideDraft = makeDraft(outside);
        expect(() => outsideDraft.adapter.serializeProposal(outsideDraft.draft)).toThrow(/surroundings must fit/i);

        const malformedDraft = makeDraft({ type: 'Polygon', coordinates: [[]] });
        expect(() => malformedDraft.adapter.serializeProposal(malformedDraft.draft)).toThrow(/surroundings must fit/i);

        const missingBuilding = makeDraft(exactGround);
        missingBuilding.draft.editorPayload.context.buildings[0].geometry = null;
        expect(() => missingBuilding.adapter.serializeProposal(missingBuilding.draft)).toThrow(/building geometry must fit/i);

        const missingSite = makeDraft(exactGround);
        missingSite.draft.editorPayload.placement.site = null;
        expect(() => missingSite.adapter.serializeProposal(missingSite.draft)).toThrow(/building geometry must fit/i);
    });

    // User decision 2026-10-18: Block, Row and Detached are rules on their parcels; leaving them is a
    // conversion to Freeform or a re-run of the rule there, never a free placement.
    it('keeps the building rules (Block, Row, Detached) out of free placement', () => {
        for (const [key, typologyType] of [['buildings', 'block'], ['row', 'row']]) {
            const rule = draftFor(registry.get(key), {
                proposalId: `${typologyType}-source`, goal: 'buildings', typologyType, title: 'Rule design',
                site: SITE, cadastreParcelIds: ['source-parcel'],
                buildingProposal: { typologyType },
                geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: POLYGON }] }
            });
            expect(() => freePlacementPatch(rule, { free: true, site: SITE })).toThrow(/fixed site/i);
            expect(isFreePlacementDraft({ ...rule, editorPayload: { ...rule.editorPayload, placement: { free: true, site: SITE } } })).toBe(false);
        }

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
                landTake: { type: 'Feature', properties: {}, geometry: POLYGON }
            }
        };
        const saved = adapter.serializeProposal(draft);
        saved.proposalId = 'moved-single';
        expect(saved.freePlacement).toBe(true);
        expect(saved.site).toEqual(SITE);
        expect(saved.cadastreParcelIds).toEqual([]);
        expect(saved.geometry.groundBoundary).toEqual(draft.editorPayload.context.groundBoundary);
        expect(saved.geometry.landTake).toEqual(draft.editorPayload.context.landTake);

        const reopenedSeed = adapter.draftFromProposal(saved);
        expect(reopenedSeed.editorPayload.placement).toEqual({ free: true, site: SITE, bindingStatus: 'bound' });
        expect(reopenedSeed.fields.binding).toEqual(saved.binding);
        expect(reopenedSeed.fields.selectedParcelIds).toEqual([]);
        const reopened = {
            id: 'reopened-single', sourceLocalProposalId: 'moved-single', sourceSnapshot: saved,
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
                initialGroundTreatment: 'green', initialLandTake: saved.geometry.landTake
            }));
        } finally {
            if (previous.open === undefined) delete globalThis.openSingleBuildingForParcels;
            else globalThis.openSingleBuildingForParcels = previous.open;
            if (previous.pending === undefined) delete globalThis.pendingBuildingProposalContext;
            else globalThis.pendingBuildingProposalContext = previous.pending;
        }
    });

    it('refuses saving a Freeform collection as one proposal even outside the map Done path', () => {
        const adapter = buildBuildingAdapter('single');
        const feature = { type: 'Feature', properties: { height: 18 }, geometry: { type: 'Polygon', coordinates: [[[15.97005,45.8001],[15.9702,45.8001],[15.9702,45.8003],[15.97005,45.8003],[15.97005,45.8001]]] } };
        const source = { proposalId: 'collection', goal: 'single', typologyType: 'single', title: 'Collection',
            site: SITE, cadastreParcelIds: [], geometry: { buildings: [feature, structuredClone(feature)] },
            buildingProposal: { typologyType: 'single', parameters: { typology: 'single' } } };
        const draft = draftFor(adapter, source);
        expect(adapter.validate(draft).errors.map(error => error.code)).toContain('freeform-building-count');
        expect(() => adapter.serializeProposal(draft)).toThrow(/exactly one building/);
    });

    it('saves a moved Freeform building inside its bound site and still rejects a part outside it', () => {
        const adapter = buildBuildingAdapter('single');
        const part = (west, east) => [[[west, 45.8001], [east, 45.8001], [east, 45.8003], [west, 45.8003], [west, 45.8001]]];
        const building = { type: 'Feature', properties: { height: 18 }, geometry: { type: 'Polygon', coordinates: part(15.97005, 15.9702) } };
        const source = {
            proposalId: 'moved-single', goal: 'single', typologyType: 'single', title: 'Freeform',
            site: SITE, cadastreParcelIds: [], geometry: { buildings: [building] },
            buildingProposal: { typologyType: 'single', parameters: { typology: 'single' } }
        };
        const draft = draftFor(adapter, source);
        const placement = freePlacementPatch(draft, { free: true, site: SITE });
        draft.fields = { ...draft.fields, ...placement.fields, binding: { source: 'server:live-cadastre', coverage: 'none', parcels: [] } };
        draft.editorPayload.placement = { ...placement.placement, bindingStatus: 'bound' };
        const saved = adapter.serializeProposal(draft);
        expect(saved.geometry.buildings).toEqual([building]);
        expect(saved.freePlacement).toBe(true);

        draft.editorPayload.context.buildings[0].geometry.coordinates = part(15.9704, 15.9706);
        expect(() => adapter.serializeProposal(draft)).toThrow(/building geometry must fit entirely/i);
    });

    // Block and Row records saved as free placements before 2026-10-18 (two on the laptop database,
    // none on production) reopen as the rule on their declared parcels: the rule is re-run there.
    it('reopens an older moved Block or Row on its declared parcels, not as a free placement', async () => {
        for (const [key, typologyType, opener] of [['buildings', 'block', 'openUrbanRuleForParcels'], ['row', 'row', 'openRowHouseForParcels']]) {
            const adapter = buildBuildingAdapter(key);
            const feature = { type: 'Feature', properties: { height: 18 }, geometry: POLYGON };
            const saved = {
                proposalId: `${typologyType}-moved`, goal: 'buildings', typologyType, title: 'Moved rule',
                freePlacement: true, site: SITE, cadastreParcelIds: ['bound-parcel'],
                binding: { source: 'server:live-cadastre', coverage: 'complete', parcels: [{ parcelId: 'bound-parcel' }] },
                geometry: { buildings: [feature] },
                buildingProposal: { typologyType, parameters: { mode: 'manual', typology: typologyType } }
            };
            const seed = adapter.draftFromProposal(saved);
            expect(seed.editorPayload.placement).toBeUndefined();
            const previous = { open: globalThis[opener], seed: globalThis.buildBlockifySeed, prepare: globalThis.prepareProposalDraftParcelSelection };
            const open = vi.fn(async () => true);
            globalThis[opener] = open;
            globalThis.buildBlockifySeed = context => ({ ...(context.parameters || {}) });
            try {
                await expect(adapter.openDesignEditor({
                    id: `${typologyType}-draft`, sourceLocalProposalId: saved.proposalId, sourceSnapshot: saved,
                    cityId: 'zagreb', adapterKey: key, goal: 'buildings', ...seed
                })).resolves.toBe(true);
                expect(open.mock.calls[0][0]).not.toHaveProperty('placement');
            } finally {
                for (const [name, value] of [[opener, previous.open], ['buildBlockifySeed', previous.seed]]) {
                    if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
                }
            }
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

    // The site is bound by POST /designs/binding (derived, nothing stored), read through the shell's
    // own fetchPlacementBinding. `bindingResponse` is the binding the server answers with (or a
    // promise of it); `respond` replaces the whole HTTP answer.
    function loadRebind(store, bindingResponse, { respond } = {}) {
        const bindingRequest = vi.fn(async () => bindingResponse);
        const placementApi = require('../../frontend/js/proposal-editor-adapters.js');
        const fetch = vi.fn(async (url, init) => {
            if (respond) return respond(url, init);
            const binding = await bindingRequest(JSON.parse(init.body));
            return { ok: true, status: 200, json: async () => ({ binding }) };
        });
        const global = {
            proposalDraftStore: store,
            proposalDraftPlacement: {
                isFreePlacementDraft: placementApi.isFreePlacementDraft,
                freePlacementPatch: placementApi.freePlacementPatch,
                markFreePlacementBound: placementApi.markFreePlacementBound
            },
            DesignSync: {
                parcelSourceIdOf: city => (city === 'zagreb' ? 'hr-katastar' : null),
                refusalMessage: (status, body) => (body && body.error) || `HTTP ${status}`
            },
            resolveBackendBaseUrl: () => 'https://example.test/api/',
            fetch,
            CityConfigManager: { getCurrentCityId: () => 'zagreb', getParcelContext: (_site, city) => ({city, parcelSourceId:'hr-katastar'}) }
        };
        const fetchSource = shellFunctionSource('fetchPlacementBinding');
        const prefix = `const placementBindingInFlight = new Map(); function currentCityId(){ return 'zagreb'; } function tDraft(_key, fallback){ return fallback; }\n${fetchSource}`;
        const fn = loadProposalEditorShellFunction('rebindFreePlacementDraft', { global }, prefix);
        return { fn, bindingRequest, fetch };
    }

    function shellFunctionSource(name) {
        const ast = parse(proposalEditorShellSource, { sourceType: 'script' });
        let found = null;
        (function find(node) {
            if (!node || typeof node !== 'object' || found) return;
            if (node.type === 'FunctionDeclaration' && node.id?.name === name) {
                found = node;
                return;
            }
            Object.keys(node).forEach(key => {
                if (['loc', 'start', 'end'].includes(key)) return;
                const value = node[key];
                if (Array.isArray(value)) value.forEach(find); else find(value);
            });
        })(ast);
        expect(found, `${name} declaration exists`).toBeTruthy();
        return proposalEditorShellSource.slice(found.start, found.end);
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
        const { fn, bindingRequest, fetch } = loadRebind(store, {
            source: 'server:live-cadastre', coverage: 'none', parcels: []
        });

        const rebound = await fn(draft.id);

        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][0]).toBe('https://example.test/api/designs/binding');
        expect(fetch.mock.calls[0][1].method).toBe('POST');
        expect(bindingRequest).toHaveBeenCalledWith({ site: SITE, toleranceM: 0, city: 'zagreb', parcelSourceId: 'hr-katastar' });
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
        const failures = [
            // The index refuses: its own message, under its own code.
            [async () => ({ ok: false, status: 503, json: async () => ({ code: 'parcel-source-unavailable', error: 'cadastre unavailable' }) }),
                { message: 'cadastre unavailable', code: 'parcel-source-unavailable' }],
            // The server cannot be reached: the draft stays saved locally.
            [async () => { throw new TypeError('Failed to fetch'); },
                { message: expect.stringMatching(/binding service is unavailable/), code: 'binding-unavailable' }],
            // A 200 without a binding is no binding.
            [async () => ({ ok: true, status: 200, json: async () => ({}) }),
                { message: expect.stringMatching(/binding service is unavailable/), code: 'binding-unavailable' }]
        ];
        for (const [respond, expected] of failures) {
            const draft = makeDraft();
            const original = structuredClone(draft);
            const store = {
                getDraft: () => structuredClone(draft),
                updateDraft: vi.fn(),
                validateDraft: vi.fn(() => structuredClone(draft))
            };
            const { fn } = loadRebind(store, null, { respond });

            await expect(fn(draft.id)).rejects.toMatchObject(expected);
            expect(store.updateDraft).not.toHaveBeenCalled();
            expect(draft).toEqual(original);
        }
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
    it('does not treat a generic hash or a server row as publication, but recognizes a published design', () => {
        expect(isPublishedProposalRecord({ proposalId: 'local-1', hash: 'content-hash' })).toBe(false);
        expect(isPublishedProposalRecord({ serverProposalId: '51', publicationApiBase: 'https://example.test' })).toBe(false);
        expect(isPublishedProposalRecord({
            published: { cid: require('../../frontend/js/cid.js').cidOfObject({ schema: 'design/v1' }), publishedAt: null, apiBase: 'https://example.test' }
        })).toBe(true);
    });
});

// A parcel layout is shared together with its agreement (plan-design-agreement.md, M1 (a)): the
// create dialog never opens for one; the refusal is publish-terms.js publishRefusal (M2).
describe('parcel layouts are not staged for publishing', () => {
    it('refuses with the publish-later message and opens no create dialog', async () => {
        const shellPath = '../../frontend/js/proposal-editor-shell.js';
        require('../../frontend/js/proposals/publish-terms.js');
        const previous = {
            proposalDraftStore: globalThis.proposalDraftStore,
            prepare: globalThis.prepareProposalDraftParcelSelection,
            show: globalThis.showProposalDialog,
            alert: globalThis.showStyledAlert
        };
        const draft = {
            id: 'draft-layout', goal: 'parcel-layout', adapterKey: 'parcel-layout',
            sourceLocalProposalId: null, sourceSnapshot: {}, revision: 1,
            fields: { selectedParcelIds: ['live-piece-1'], name: 'Block', description: 'Layout' },
            editorPayload: { plan: { algorithm: 'equal', plots: [] } }, validation: { valid: true }
        };
        let opened = 0;
        let prepared = 0;
        const alerts = [];
        globalThis.proposalDraftStore = {
            getDraft: () => draft,
            validateDraft: () => draft,
            getPublishReceipt: () => null,
            updateDraft: () => draft,
            markPublishFailed: () => {}
        };
        globalThis.prepareProposalDraftParcelSelection = async () => { prepared += 1; return { ids: [], layers: [] }; };
        globalThis.showProposalDialog = () => { opened += 1; };
        globalThis.showStyledAlert = message => { alerts.push(message); };
        delete require.cache[require.resolve(shellPath)];
        require(shellPath);
        try {
            await expect(globalThis.stageProposalDraftForPublishing(draft.id)).resolves.toBe(false);
            expect(opened).toBe(0);
            expect(prepared).toBe(0);
            expect(alerts).toEqual(['A parcel layout is published with its agreement. Propose an agreement that includes it.']);
        } finally {
            Object.entries({
                proposalDraftStore: previous.proposalDraftStore,
                prepareProposalDraftParcelSelection: previous.prepare,
                showProposalDialog: previous.show,
                showStyledAlert: previous.alert
            }).forEach(([key, value]) => {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            });
        }
    });
});
