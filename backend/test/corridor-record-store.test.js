// The local proposal store and the road record (roads.md §11, step two): a road is added as the
// view the editor works on, every persisted row holds the record (the OSM document, no stretch
// fields), and a row read back from storage runs as the view again. Loads proposals/data.js in this
// realm with the real authored-record projection, so the test fails if either boundary is skipped.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let storage;
let rows;
let osmForm;
let P;

beforeAll(() => {
    rows = new Map();
    const noop = () => { };
    global.PersistentStorage = {
        getItem: key => (rows.has(key) ? rows.get(key) : null),
        setItem: (key, value) => rows.set(key, value),
        removeItem: key => rows.delete(key),
        forEach: callback => rows.forEach((value, key) => callback(value, key)),
        atomicWrite: async change => {
            (change.puts || new Map()).forEach((value, key) => rows.set(key, value));
            (change.deletes || []).forEach(key => rows.delete(key));
        }
    };
    global.document = { getElementById: () => null, createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, addEventListener: noop }), addEventListener: noop, body: { appendChild: noop } };
    global.ProposalAuthoredRecord = require('../../frontend/js/proposals/authored-record.js');
    osmForm = require('../../frontend/js/corridor-osm-form.js');
    P = require('../../frontend/js/corridor-profile.js');
    global.window = {
        document: global.document,
        addEventListener: noop,
        __cbSecondaryTab: false,
        __formationDepth: require('../../frontend/js/proposals/formation-depth.js'),
        __corridorOsmForm: osmForm
    };
    global.L = undefined;
    global.turf = undefined;
    // Collaborators from sibling classic scripts, as the boundary needs them and no more.
    Object.assign(globalThis, {
        normalizeParcelIdList: ids => (Array.isArray(ids) ? ids.map(String) : []),
        normalizeProposalStatusAxes: () => { },
        normalizeLensEntries: () => [],
        isLocalProposalId: id => /^local-/.test(String(id)),
        normalizeProposalGoalKey: goal => goal,
        serialiseRoadDefinition: definition => JSON.stringify(definition),
        serialiseGeometry: geometry => JSON.stringify(geometry),
        hashStringDeterministic: text => String(text).length,
        stableStringify: value => JSON.stringify(value),
        getCurrentCityId: () => 'zagreb',
        getLifecycleStatus: proposal => proposal.lifecycleStatus || 'Active',
        normalizeChainId: value => value,
        buildChainProposalId: (chain, id) => `${chain}-${id}`,
        getCurrentUserAgent: () => null,
        showEphemeralMessage: () => { }
    });
    const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../frontend/js/proposals/data.js');
    (0, eval)(readFileSync(scriptPath, 'utf8') + '\nglobalThis.__capStore = { proposalStorage };');
    storage = globalThis.__capStore.proposalStorage;
});

const A = { lat: 45.8001, lng: 15.9701 };
const B = { lat: 45.8004, lng: 15.9712, level: -1 };
const profile = () => ({ strips: P.CORRIDOR_PROFILE_PRESETS[10].map(lane => ({ ...lane })) });
const drawn = () => ({
    proposalId: 'road-1', title: 'Drawn street', goal: 'road-track', type: 'road', cadastreParcelIds: ['HR-335550-1791/25'],
    roadProposal: { mode: 'draw', definition: { points: [[A, B]], segments: [[A, B]], segmentIds: ['s1'], profile: profile(), width: 10, tunnels: [], metadata: { isRoad: true, isCorridor: true }, polygon: { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.972, 45.8], [15.972, 45.801], [15.97, 45.8]]] } } }
});

describe('a road in the local store', () => {
    it('is stored as its record and runs as its view, through a save and a reload', async () => {
        storage.proposals.clear();
        storage.addProposal(drawn());
        await Promise.resolve();
        const inMemory = storage.getProposal('road-1').roadProposal.definition;
        expect(inMemory.points).toEqual([[A, B]]);
        expect(inMemory.osm).toBeUndefined();

        const stored = JSON.parse(rows.get('proposal:road-1')).roadProposal.definition;
        osmForm.VIEW_FIELDS.forEach(field => expect(stored[field], field).toBeUndefined());
        expect(stored.osm.elements.filter(element => element.type === 'way')).toHaveLength(1);
        expect(stored.polygon.type).toBe('Polygon');

        storage.proposals.clear();
        storage.load();
        const reloaded = storage.getProposal('road-1').roadProposal.definition;
        expect(reloaded.points).toEqual([[A, B]]);
        expect(reloaded.segmentIds).toEqual(['s1']);
        expect(JSON.stringify(P.normalizeCorridorProfile(reloaded.profile))).toBe(JSON.stringify(P.normalizeCorridorProfile(profile())));
        expect(reloaded.osm).toBeUndefined();
        expect(reloaded.polygon.type).toBe('Polygon');
    });

    it('takes a row stored before the record (stretch fields only) and stores it as the record at its next save', async () => {
        storage.proposals.clear();
        rows.clear();
        rows.set('cadastre_proposals_manifest', JSON.stringify({ version: 1, nextProposalId: 2 }));
        rows.set('proposal:old-1', JSON.stringify({ ...drawn(), proposalId: 'old-1' }));
        storage.load();
        const loaded = storage.getProposal('old-1').roadProposal.definition;
        expect(loaded.points).toEqual([[A, B]]);
        expect(loaded.osm).toBeUndefined();
        storage.setProposalName('old-1', 'Renamed');
        storage._persist();
        await Promise.resolve();
        const stored = JSON.parse(rows.get('proposal:old-1')).roadProposal.definition;
        expect(stored.points).toBeUndefined();
        expect(stored.osm.elements.length).toBeGreaterThan(0);
    });
});
