import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const geometry = require('../../frontend/js/corridor-geometry.js');
const authoring = require('../../frontend/js/proposals/corridor-authoring.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

const P = (lat, lng, extra = {}) => ({ lat, lng, ...extra });
const clone = value => JSON.parse(JSON.stringify(value));
// Where a design was published (DesignSync): its CID at one index.
const PUBLISHED = { cid: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq', publishedAt: '2026-10-21T12:00:00.000Z', apiBase: 'https://api.example.test' };

function corridor(id, segments, options = {}) {
    const definition = {
        points: clone(segments),
        segments: clone(segments),
        segmentIds: segments.map((_, index) => `${id || 'new'}-${index}`),
        metadata: { isTrack: options.track === true },
        ...(options.tunnels ? { tunnels: clone(options.tunnels) } : {})
    };
    return {
        ...(id ? { proposalId: id } : {}),
        applied: options.applied !== false,
        title: id || 'New corridor',
        roadProposal: { definition },
        ...(options.identity || {})
    };
}

const plan = (newProposal, existing, options = {}) => authoring.planCorridorAuthoring(
    newProposal,
    existing,
    {
        geometry,
        isApplied: record => record.applied === true,
        isTrack: definition => definition.metadata?.isTrack === true,
        ...options
    }
);

const planEdit = (before, edited, records, options = {}) => authoring.planCorridorEdit(
    before,
    edited,
    records,
    {
        geometry,
        isApplied: record => record.applied === true,
        isTrack: definition => definition.metadata?.isTrack === true,
        ...options
    }
);

const installedGlobals = new Map();
function installGlobal(name, value) {
    if (!installedGlobals.has(name)) {
        installedGlobals.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
    }
    globalThis[name] = value;
}

afterEach(() => {
    delete global.corridorTunnelEdgeKey;
    for (const [name, prior] of installedGlobals) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    installedGlobals.clear();
    vi.restoreAllMocks();
});

function managerHarness(existing, derive) {
    const records = new Map(existing.map(record => [String(record.proposalId), record]));
    const addProposal = vi.fn(function addProposalToDraft(proposal, options = {}) {
        const stored = clone(proposal);
        stored.proposalId = 'new-road';
        stored.roadProposal.id = 'new-road';
        stored.roadProposal.proposalId = 'new-road';
        this.proposals.set('new-road', stored);
        this.save();
        return 'new-road';
    });
    const storage = {
        proposals: records,
        nextProposalId: 1,
        _suspendSaveCount: 0,
        _hasPendingSave: false,
        beginBatch() { this._suspendSaveCount += 1; },
        endBatch() { this._suspendSaveCount -= 1; },
        save: vi.fn(),
        getAllProposals() { return [...this.proposals.values()]; },
        getProposal(id) { return this.proposals.get(String(id)) || null; },
        addProposal,
        _indexProposal: vi.fn(function indexProposal(record) {
            this.proposals.set(String(record.proposalId), record);
        }),
        snapshotForMutation() {
            return { records: new Map([...this.proposals].map(([id, record]) => [id, clone(record)])), nextProposalId: this.nextProposalId };
        },
        createMutationDraft(snapshot) {
            const draft = Object.create(this);
            draft.proposals = new Map([...snapshot.records].map(([id, record]) => [id, clone(record)]));
            draft.nextProposalId = snapshot.nextProposalId;
            draft.save = vi.fn();
            return draft;
        },
        serializeMutationDraft: () => null,
        publishMutationDraft(draft) {
            for (const id of [...this.proposals.keys()]) if (!draft.proposals.has(id)) this.proposals.delete(id);
            draft.proposals.forEach((record, id) => {
                const current = this.proposals.get(id);
                if (current) {
                    Object.keys(current).forEach(key => delete current[key]);
                    Object.assign(current, clone(record));
                } else this.proposals.set(id, clone(record));
            });
        }
    };
    const browserRoot = {
        CorridorAuthoring: authoring,
        CorridorGeometry: geometry
    };
    installGlobal('window', browserRoot);
    installGlobal('proposalStorage', storage);
    installGlobal('setProposalApplied', (record, applied) => { record.applied = applied === true; });
    const manager = {
        createCorridorProposalAtomically: ProposalManager.createCorridorProposalAtomically,
        _createCorridorProposalTransactionBody: ProposalManager._createCorridorProposalTransactionBody,
        _enqueueFabricChange: operation => operation(),
        rematerializeCorridorScope: derive,
        _clearLastApplyFailure: vi.fn(),
        _refreshUIAfterProposalChange: vi.fn()
    };
    return { manager, records, storage, addProposal };
}

describe('atomic corridor authoring plan', () => {
    it('refreshes peer cross-sections after an in-place profile edit without touching unrelated records', () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]]);
        const branch = corridor('branch', [[P(5, 5), P(0, 5)]]);
        const far = corridor('far', [[P(20, 20), P(20, 25)]]);
        const profile = width => ({ strips: [{ type: 'driving', width }] });
        through.roadProposal.definition.profile = profile(4);
        branch.roadProposal.definition.profile = profile(3);
        const initial = plan(branch, [through]);
        const appliedThrough = clone(through);
        appliedThrough.roadProposal.definition = initial.existingChanges[0].definition;
        const appliedBranch = clone(initial.proposal);
        appliedBranch.proposalId = 'branch';
        const originalFar = clone(far);
        const editedThrough = clone(appliedThrough);
        editedThrough.roadProposal.definition.profile = profile(6);

        const result = planEdit(appliedThrough, editedThrough, [appliedThrough, appliedBranch, far]);

        const refreshedBranch = result.existingChanges.find(change => change.proposalId === 'branch');
        expect(refreshedBranch).toBeTruthy();
        expect(refreshedBranch.definition.junctions[0].arms.map(arm => arm.profile.strips[0].width)).toEqual([6, 6]);
        expect(result.proposal.roadProposal.definition.junctions[0].arms.map(arm => arm.profile.strips[0].width)).toEqual([3]);
        expect(result.existingChanges.some(change => change.proposalId === 'far')).toBe(false);
        expect(far).toEqual(originalFar);
        // Planning returns detached snapshots and does not mutate committed inputs.
        expect(appliedBranch.roadProposal.definition.junctions[0].arms.map(arm => arm.profile.strips[0].width)).toEqual([4, 4]);
    });

    it('refreshes every peer at a new edge join in a three-way junction', () => {
        const eastWest = corridor('east-west', [[P(0, -5), P(0, 5)]]);
        const northSouth = corridor('north-south', [[P(-5, 0), P(5, 0)]]);
        const existing = authoring.planCorridorComposition([eastWest, northSouth], { geometry });
        const branch = corridor(null, [[P(5, 5), P(0, 0)]]);

        const result = planEdit(branch, branch, existing);

        expect(result.existingChanges.map(change => change.proposalId)).toEqual(['east-west', 'north-south']);
        for (const change of result.existingChanges) {
            const center = change.definition.junctions.find(junction => junction.lat === 0 && junction.lng === 0);
            expect(center.arms).toHaveLength(3);
            expect(center.arms.some(arm => arm.toward.lat === 5 && arm.toward.lng === 5)).toBe(true);
        }
        const center = result.proposal.roadProposal.definition.junctions.find(junction => junction.lat === 0 && junction.lng === 0);
        expect(center.arms).toHaveLength(4);
    });

    it('removes stale peer junction snapshots when an edited road moves away', () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]]);
        const branch = corridor('branch', [[P(5, 5), P(0, 5)]]);
        const initial = plan(branch, [through]);
        const appliedThrough = clone(through);
        appliedThrough.roadProposal.definition = initial.existingChanges[0].definition;
        const appliedBranch = clone(initial.proposal);
        appliedBranch.proposalId = 'branch';
        const editedThrough = clone(appliedThrough);
        editedThrough.roadProposal.definition.points = [[P(10, 0), P(10, 10)]];
        editedThrough.roadProposal.definition.segments = clone(editedThrough.roadProposal.definition.points);

        const result = planEdit(appliedThrough, editedThrough, [appliedThrough, appliedBranch]);

        expect(result.proposal.roadProposal.definition.junctions).toBeUndefined();
        const refreshedBranch = result.existingChanges.find(change => change.proposalId === 'branch');
        expect(refreshedBranch.definition.junctions).toBeUndefined();
    });

    it('writes a snapped T node into the existing road while keeping two proposal records', () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]]);
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        const originals = clone({ through, branch });

        const result = plan(branch, [through]);

        expect(result.proposal).not.toBe(branch);
        expect(result.existingChanges).toHaveLength(1);
        expect(result.existingChanges[0].proposalId).toBe('through');
        expect(result.existingChanges[0].definition.points).toHaveLength(2);
        expect(result.proposal.roadProposal.definition.points).toHaveLength(1);
        expect(result.junctionRecords).toBe(1);
        expect({ through, branch }).toEqual(originals);
    });

    it('authors views that the store records as OSM documents, the joined road as two ways sharing the node (roads.md §11)', () => {
        const osmForm = require('../../frontend/js/corridor-osm-form.js');
        const through = corridor('through', [[P(0, 0), P(0, 10)]]);
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        through.roadProposal.definition.profile = { strips: [{ type: 'driving', width: 3.5 }, { type: 'driving', width: 3.5 }] };
        branch.roadProposal.definition.profile = { strips: [{ type: 'driving', width: 3 }] };
        const result = plan(branch, [through]);
        [result.proposal.roadProposal.definition, result.existingChanges[0].definition].forEach(definition => {
            // what the editor hands on is the view; nothing carries a form until it is stored
            expect(definition.osm).toBeUndefined();
            const record = osmForm.toRecord(definition);
            expect(record.osm.elements.some(element => element.type === 'way')).toBe(true);
            expect(osmForm.toView(record).points).toEqual(definition.points);
        });
        const joined = osmForm.toRecord(result.existingChanges[0].definition).osm.elements.filter(element => element.type === 'way');
        expect(joined).toHaveLength(2);
        expect(joined[0].nodes[joined[0].nodes.length - 1]).toBe(joined[1].nodes[0]);
    });

    it('plans a new road handed over as its stored record (the draft build projects to the OSM document before the atomic create)', () => {
        const osmForm = require('../../frontend/js/corridor-osm-form.js');
        const through = corridor('through', [[P(0, 0), P(0, 10)]]);
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        branch.roadProposal.definition.profile = { strips: [{ type: 'driving', width: 3 }] };
        branch.roadProposal.definition = osmForm.toRecord(branch.roadProposal.definition);
        expect(branch.roadProposal.definition.points).toBeUndefined();
        expect(branch.roadProposal.definition.osm).toBeTruthy();

        const result = plan(branch, [through]);

        const definition = result.proposal.roadProposal.definition;
        expect(definition.osm).toBeUndefined();
        expect(definition.points).toHaveLength(1);
        expect(definition.points[0]).toEqual([P(5, 5), P(0, 5)]);
        expect(definition.profile.strips[0].width).toBe(3);
        expect(result.existingChanges).toHaveLength(1);
        expect(result.junctionRecords).toBe(1);
        // a loop drawn as one closed stroke is a valid centreline too
        const loop = corridor(null, [[P(0, 0), P(0, 10), P(10, 10), P(0, 0)]]);
        loop.roadProposal.definition = osmForm.toRecord(loop.roadProposal.definition);
        expect(() => plan(loop, [])).not.toThrow();
    });

    it('records the junction and the other road\'s arms in both definitions, and an end-to-end join too', () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]]);
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        through.roadProposal.definition.profile = { strips: [{ type: 'driving', width: 3.5 }, { type: 'driving', width: 3.5 }] };
        branch.roadProposal.definition.profile = { strips: [{ type: 'driving', width: 3 }] };
        const result = plan(branch, [through]);
        // The branch learns of the through road's two arms at the node it ends on…
        const branchJunctions = result.proposal.roadProposal.definition.junctions;
        expect(branchJunctions).toHaveLength(1);
        expect(branchJunctions[0]).toMatchObject({ lat: 0, lng: 5 });
        expect(branchJunctions[0].arms.map(arm => arm.toward).sort((a, b) => a.lng - b.lng)).toEqual([P(0, 0), P(0, 10)]);
        expect(branchJunctions[0].arms.every(arm => arm.profile && Array.isArray(arm.profile.strips))).toBe(true);
        // …and the through road learns of the branch's one arm there.
        const throughJunctions = result.existingChanges[0].definition.junctions;
        expect(throughJunctions).toHaveLength(1);
        expect(throughJunctions[0].arms.map(arm => arm.toward)).toEqual([P(5, 5)]);

        // Two roads meeting end to end change no geometry, yet the junction is recorded and the
        // existing record is re-snapshotted to carry it (a narrow road widens back to a wide one
        // from its own definition — corridor-transition.js).
        const west = corridor('west', [[P(0, -10), P(0, 0)]]);
        const east = corridor(null, [[P(0, 0), P(0, 10)]]);
        west.roadProposal.definition.width = 12; // a record that only knows its width still records an arm
        const joined = plan(east, [west]);
        expect(joined.existingChanges).toHaveLength(1);
        expect(joined.existingChanges[0].definition.junctions[0].arms.map(arm => arm.toward)).toEqual([P(0, 10)]);
        expect(joined.proposal.roadProposal.definition.junctions[0].arms).toEqual([{ toward: P(0, -10), width: 12 }]);
        expect(joined.junctionRecords).toBe(1);
    });

    it('nodes both records at an X crossing before either is persisted', () => {
        const eastWest = corridor('east-west', [[P(0, -5), P(0, 5)]]);
        const northSouth = corridor(null, [[P(-5, 0), P(5, 0)]]);

        const result = plan(northSouth, [eastWest]);

        expect(result.existingChanges[0].definition.points).toHaveLength(2);
        expect(result.proposal.roadProposal.definition.points).toHaveLength(2);
        const oldNodes = result.existingChanges[0].definition.points.flat();
        const newNodes = result.proposal.roadProposal.definition.points.flat();
        expect(oldNodes.some(point => point.lat === 0 && point.lng === 0)).toBe(true);
        expect(newNodes.some(point => point.lat === 0 && point.lng === 0)).toBe(true);
    });

    it('touches only applied corridors', () => {
        const newRoad = corridor(null, [[P(0, -5), P(0, 5)]]);
        const parkedRoad = corridor('parked', [[P(-5, 0), P(5, 0)]], { applied: false });
        const farRoad = corridor('far', [[P(20, 20), P(20, 25)]]);

        const result = plan(newRoad, [parkedRoad, farRoad]);

        expect(result.existingChanges).toEqual([]);
        expect(result.junctionRecords).toBe(0);
        expect(result.proposal.roadProposal.definition.points).toHaveLength(1);
    });

    // This used to assert the opposite ("touches only applied corridors of the same kind"): a road
    // drawn across a track stayed two strangers. Decision 4 of road-editor.md: roads and tracks form
    // junctions with each other — a tram crossing a road is a level crossing that shares the node,
    // as in OSM.
    it('nodes a road with an applied track it crosses', () => {
        const newRoad = corridor(null, [[P(0, -5), P(0, 5)]]);
        const track = corridor('track', [[P(-5, 0), P(5, 0)]], { track: true });

        const result = plan(newRoad, [track]);

        expect(result.isTrack).toBe(false);
        expect(result.junctionRecords).toBe(1);
        expect(result.existingChanges.map(change => change.proposalId)).toEqual(['track']);
        const trackNodes = result.existingChanges[0].definition.points.flat();
        const roadNodes = result.proposal.roadProposal.definition.points.flat();
        expect(trackNodes.some(point => point.lat === 0 && point.lng === 0)).toBe(true);
        expect(roadNodes.some(point => point.lat === 0 && point.lng === 0)).toBe(true);
        // The track stays a track: only its topology changed.
        expect(result.existingChanges[0].definition.metadata.isTrack).toBe(true);
    });

    it('does not turn a protected crossing into a junction', () => {
        global.corridorTunnelEdgeKey = (a, b) => [
            `${a.lat.toFixed(7)},${a.lng.toFixed(7)}`,
            `${b.lat.toFixed(7)},${b.lng.toFixed(7)}`
        ].sort().join('|');
        const protectedKey = global.corridorTunnelEdgeKey(P(0, -5), P(0, 5));
        const bridge = corridor('bridge', [[P(0, -5), P(0, 5)]], {
            tunnels: [{ edgeKey: protectedKey }]
        });
        const under = corridor(null, [[P(-5, 0), P(5, 0)]]);

        const result = plan(under, [bridge]);

        expect(result.existingChanges).toEqual([]);
        expect(result.proposal.roadProposal.definition.points).toHaveLength(1);
    });

    it('is deterministic regardless of proposal-store iteration order', () => {
        const newRoad = corridor(null, [[P(0, -10), P(0, 10)]]);
        const left = corridor('a-left', [[P(-5, -2), P(5, -2)]]);
        const right = corridor('b-right', [[P(-5, 2), P(5, 2)]]);

        const forward = plan(newRoad, [left, right]);
        const reverse = plan(newRoad, [right, left]);

        expect(reverse).toEqual(forward);
        expect(forward.existingChanges.map(change => change.proposalId)).toEqual(['a-left', 'b-right']);
    });

    it('persists a converged network that needs no repair after a JSON round trip', () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]]);
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        const result = plan(branch, [through]);
        const persisted = JSON.parse(JSON.stringify([
            {
                ...through,
                roadProposal: {
                    ...through.roadProposal,
                    definition: result.existingChanges[0].definition
                }
            },
            { ...result.proposal, proposalId: 'new-road' }
        ]));
        const entries = persisted.map(record => {
            const definition = record.roadProposal.definition;
            return {
                segments: clone(definition.points),
                segmentIds: clone(definition.segmentIds),
                segmentProfiles: clone(definition.segmentProfiles || {})
            };
        });

        const secondPass = geometry.normalizeCorridorNetwork(entries, { toleranceMeters: 0 });

        expect(secondPass.every(entry => entry.changed === false)).toBe(true);
    });

    it('does not silently heal a nearby endpoint that the drawing did not actually snap', () => {
        const through = corridor('through', [[P(43, 15), P(43, 15.001)]]);
        const nearbyBranch = corridor(null, [[P(43.001, 15.0005), P(43.0000001, 15.0005)]]);

        const result = plan(nearbyBranch, [through]);

        expect(result.existingChanges).toEqual([]);
        expect(result.junctionRecords).toBe(0);
    });

    it('detaches only the publication mark, the one published identity a design has (M3)', () => {
        const ORIGIN = { cid: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq' };
        const record = corridor('local-id', [[P(0, 0), P(0, 1)]], {
            identity: { published: PUBLISHED, origin: ORIGIN, author: 'Ana' }
        });

        const removed = authoring.detachPublishedIdentity(record);

        expect(authoring.PUBLISHED_IDENTITY_KEYS).toEqual(['published']);
        expect(removed).toEqual({ published: PUBLISHED });
        expect(record.published).toBeUndefined();
        expect(record.proposalId).toBe('local-id');
        // Its own lineage and author are content, not publication: they stay.
        expect(record.origin).toEqual(ORIGIN);
        expect(record.author).toBe('Ana');
        expect(record.roadProposal).toBeTruthy();
    });
});

describe('corridor authoring commit boundary', () => {
    it('updates both road sites to rebuilt junction land before deriving or persisting them', async () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]]);
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        const oldSite = { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] };
        for (const record of [through, branch]) {
            record.site = clone(oldSite);
            record.binding = { coverage: 'complete' };
            record.roadProposal.definition.polygon = clone(oldSite);
        }
        const derive = vi.fn(async records => {
            for (const record of records) {
                expect(record.site).toEqual(record.roadProposal.definition.polygon);
                expect(record.site).not.toEqual(oldSite);
                expect(record.binding).toBeUndefined();
            }
            return { ok: true };
        });
        const { manager, records } = managerHarness([through], derive);
        installGlobal('rebuildRoadDefinitionFootprint', definition => {
            definition.polygon = { type: 'Polygon', coordinates: [[[0,0],[2,0],[2,1],[0,1],[0,0]]] };
        });
        expect((await manager.createCorridorProposalAtomically(branch)).ok).toBe(true);
        expect(derive).toHaveBeenCalledOnce();
        for (const record of records.values()) expect(record.site).toEqual(record.roadProposal.definition.polygon);
    });

    it('persists both sides of a T before deriving its ground', async () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]], {
            identity: { published: PUBLISHED }
        });
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        const derive = vi.fn(async (records, options) => {
            expect(records[0].proposalId).toBe('new-road');
            expect(records[0].roadProposal.definition.points).toHaveLength(1);
            expect(options._parcelMutation.proposals.getProposal('through')
                .roadProposal.definition.points).toHaveLength(2);
            // The committed record stays visible and unchanged until durable publication.
            expect(through.roadProposal.definition.points).toHaveLength(1);
            return { ok: true, failed: [] };
        });
        const { manager, records, addProposal } = managerHarness([through], derive);

        const result = await manager.createCorridorProposalAtomically(branch);

        expect(result.ok).toBe(true);
        expect(result.topology.changedProposalIds).toEqual(['through']);
        expect(addProposal).toHaveBeenCalledWith(expect.any(Object), { emitEvent: false });
        expect(records.get('new-road').applied).toBe(true);
        expect(through.published).toBeUndefined();
        expect(derive).toHaveBeenCalledOnce();
    });

    it('restores every touched road and removes the provisional proposal when derivation fails', async () => {
        const through = corridor('through', [[P(0, 0), P(0, 10)]], {
            identity: { published: PUBLISHED }
        });
        const original = clone(through);
        const branch = corridor(null, [[P(5, 5), P(0, 5)]]);
        const derive = vi.fn(async () => ({
            ok: false,
            failed: [{ reason: 'ground derivation failed' }]
        }));
        const { manager, records } = managerHarness([through], derive);

        const result = await manager.createCorridorProposalAtomically(branch);

        expect(result).toEqual({
            ok: false,
            proposalId: null,
            reason: 'ground derivation failed'
        });
        expect(records.has('new-road')).toBe(false);
        expect(records.get('through')).toBe(through);
        expect(through).toEqual(original);
    });
});
