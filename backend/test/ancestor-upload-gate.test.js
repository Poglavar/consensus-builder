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
