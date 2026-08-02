// The share-plan gate on ancestor proposals. It must check COMPLETENESS (is every ancestor part of
// the plan being shared) rather than upload ORDER — proposal ancestry is derived from live parcel
// state and can be genuinely cyclic, so an ordering gate is not always satisfiable. Pure: the only
// I/O is fetch, stubbed here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensureAncestorProposalsUploaded } = require('../../frontend/js/proposals/server-sync.js');

// The real cycle observed on prod: Road 2107-2043 and Subdivide 2107-2048 each re-cut the other's
// children, so each is an ancestor of the other. Neither can ever be "uploaded first".
const ROAD = 'p-2g0teu3onpu';
const SUBDIVIDE = 'p-1mkonr8j4t2';
const PARK = 'p-g55abqcmtz';

const PROPOSALS = {
    [ROAD]: { proposalId: ROAD, title: 'Road 2107-2043', city: 'zagreb' },
    [SUBDIVIDE]: { proposalId: SUBDIVIDE, title: 'Subdivide 2107-2048', city: 'zagreb' },
    [PARK]: { proposalId: PARK, title: 'Park 2107-2047', city: 'zagreb' }
};

// Mirrors findAncestorTree's output shape: [{ proposalId, child, depth }].
const ANCESTORS = {
    [ROAD]: [SUBDIVIDE],
    [SUBDIVIDE]: [ROAD],
    [PARK]: [ROAD, SUBDIVIDE]
};

let fetched;

beforeEach(() => {
    fetched = [];
    globalThis.ProposalManager = {
        findAncestorTree: (id) => (ANCESTORS[id] || []).map((a, i) => ({ proposalId: a, child: id, depth: i + 1 }))
    };
    globalThis.proposalStorage = { getProposal: (id) => PROPOSALS[id] || null };
    globalThis.getProposalKey = (p) => p && p.proposalId;
    globalThis.resolveBackendBaseUrl = () => 'https://api.test';
    // Nothing in this plan has reached the server yet: every existence probe 404s.
    globalThis.fetch = async (url) => {
        fetched.push(String(url));
        return { ok: false, status: 404, clone: () => ({ json: async () => ({}) }) };
    };
});

afterEach(() => {
    delete globalThis.ProposalManager;
    delete globalThis.proposalStorage;
    delete globalThis.getProposalKey;
    delete globalThis.resolveBackendBaseUrl;
    delete globalThis.fetch;
});

describe('ancestor upload gate', () => {
    it('does not block on a cyclic ancestry when both sides are in the plan', async () => {
        // The regression: with an order-only gate both of these fail forever, and every proposal
        // downstream of them fails too — five stuck rows in one plan.
        const plan = new Set([ROAD, SUBDIVIDE, PARK]);

        for (const id of [ROAD, SUBDIVIDE, PARK]) {
            const gate = await ensureAncestorProposalsUploaded(PROPOSALS[id], { satisfiedBy: plan });
            expect(gate.ok, `${id} should not be blocked`).toBe(true);
            expect(gate.missing).toEqual([]);
        }
    });

    it('does not probe the server at all for ancestors already in the plan', async () => {
        await ensureAncestorProposalsUploaded(PROPOSALS[PARK], { satisfiedBy: new Set([ROAD, SUBDIVIDE, PARK]) });
        expect(fetched).toEqual([]);
    });

    it('still flags an ancestor the user excluded from the plan', async () => {
        // Completeness is the whole point: an ancestor that is neither in the plan nor on the server
        // leaves the recipient unable to rebuild the fabric this proposal sits on.
        const gate = await ensureAncestorProposalsUploaded(PROPOSALS[PARK], { satisfiedBy: new Set([PARK, ROAD]) });
        expect(gate.ok).toBe(false);
        expect(gate.missing.map(m => m.hash)).toEqual([SUBDIVIDE]);
    });

    it('without a plan set, falls back to the server probe for every ancestor', async () => {
        const gate = await ensureAncestorProposalsUploaded(PROPOSALS[PARK]);
        expect(gate.ok).toBe(false);
        expect(gate.missing.map(m => m.hash).sort()).toEqual([SUBDIVIDE, ROAD].sort());
        expect(fetched.length).toBe(2);
    });

    it('a proposal with no ancestors is never gated', async () => {
        globalThis.ProposalManager.findAncestorTree = () => [];
        const gate = await ensureAncestorProposalsUploaded(PROPOSALS[ROAD], { satisfiedBy: new Set() });
        expect(gate.ok).toBe(true);
    });

    it('accepts a plain array as the plan set', async () => {
        const gate = await ensureAncestorProposalsUploaded(PROPOSALS[PARK], { satisfiedBy: [ROAD, SUBDIVIDE] });
        expect(gate.ok).toBe(true);
    });
});

// The A6 path: with plan-order available the prerequisite set comes from the constraint graph —
// older intersecting APPLIED fabric-changers — not from the live-parcel ancestry walk. Strictly
// -older is antisymmetric, so the mutual-ancestor deadlock is unrepresentable, and overlays have
// no upload prerequisites at all (recipients re-parent them from geometry).
describe('ancestor upload gate — A6 constraint-graph ancestry', () => {
    const square = (lngWest, latSouth, lngWidth, latHeight) => ({
        type: 'Polygon',
        coordinates: [[
            [lngWest, latSouth],
            [lngWest + lngWidth, latSouth],
            [lngWest + lngWidth, latSouth + latHeight],
            [lngWest, latSouth + latHeight],
            [lngWest, latSouth]
        ]]
    });
    // Two overlapping fabric-changers (the prod cycle pair, now with geometry) + one overlay.
    const A6_PROPOSALS = {
        [ROAD]: {
            proposalId: ROAD, title: 'Road 2107-2043', city: 'zagreb', goal: 'road-track',
            createdAt: '2026-01-01T00:00:00Z', applied: true,
            geometry: square(16.000, 45.8004, 0.002, 0.0002)
        },
        [SUBDIVIDE]: {
            proposalId: SUBDIVIDE, title: 'Subdivide 2107-2048', city: 'zagreb', goal: 'reparcellization',
            createdAt: '2026-01-02T00:00:00Z', applied: true,
            reparcellization: { polygons: [{ geometry: square(16.000, 45.800, 0.001, 0.001) }] }
        },
        [PARK]: {
            proposalId: PARK, title: 'Park 2107-2047', city: 'zagreb', goal: 'park',
            createdAt: '2026-01-03T00:00:00Z', applied: true,
            structureProposal: { kind: 'park', geometry: square(16.0002, 45.8002, 0.0004, 0.0004) }
        }
    };

    beforeEach(() => {
        globalThis.turf = require('@turf/turf');
        globalThis.window = globalThis;
        globalThis.__planOrder = require('../../frontend/js/proposals/plan-order.js');
        globalThis.proposalStorage = {
            getProposal: (id) => A6_PROPOSALS[id] || null,
            getAllProposals: () => Object.values(A6_PROPOSALS)
        };
        // The legacy walk must NOT be consulted when footprints resolve; make it explode if it is.
        globalThis.ProposalManager = {
            findAncestorTree: () => { throw new Error('legacy ancestry walk must not run on the A6 path'); }
        };
    });

    afterEach(() => {
        delete globalThis.__planOrder;
        delete globalThis.window;
    });

    it('an overlay has no upload prerequisites, whatever it stands on', async () => {
        const gate = await ensureAncestorProposalsUploaded(A6_PROPOSALS[PARK]);
        expect(gate.ok).toBe(true);
        expect(gate.missing).toEqual([]);
        expect(fetched).toEqual([]);
    });

    it('the older fabric-changer of an intersecting pair uploads freely — no cycle exists', async () => {
        const gate = await ensureAncestorProposalsUploaded(A6_PROPOSALS[ROAD]);
        expect(gate.ok).toBe(true);
        expect(fetched).toEqual([]);
    });

    it('the newer fabric-changer requires the older one it intersects', async () => {
        const gate = await ensureAncestorProposalsUploaded(A6_PROPOSALS[SUBDIVIDE]);
        expect(gate.ok).toBe(false);
        expect(gate.missing.map(m => m.hash)).toEqual([ROAD]);
    });

    it('the requirement is satisfied by shipping together (completeness), not by order', async () => {
        const gate = await ensureAncestorProposalsUploaded(A6_PROPOSALS[SUBDIVIDE], { satisfiedBy: new Set([ROAD, SUBDIVIDE]) });
        expect(gate.ok).toBe(true);
        expect(fetched).toEqual([]);
    });

    it('an unapplied fabric-changer never constrains', async () => {
        const detached = { ...A6_PROPOSALS[ROAD], applied: false };
        globalThis.proposalStorage.getAllProposals = () => [detached, A6_PROPOSALS[SUBDIVIDE]];
        const gate = await ensureAncestorProposalsUploaded(A6_PROPOSALS[SUBDIVIDE]);
        expect(gate.ok).toBe(true);
    });

    it('non-intersecting fabric-changers do not constrain each other', async () => {
        const farAway = {
            ...A6_PROPOSALS[ROAD],
            geometry: square(17.000, 46.000, 0.002, 0.0002)
        };
        globalThis.proposalStorage.getAllProposals = () => [farAway, A6_PROPOSALS[SUBDIVIDE]];
        const gate = await ensureAncestorProposalsUploaded(A6_PROPOSALS[SUBDIVIDE]);
        expect(gate.ok).toBe(true);
    });
});
