// A read-only (secondary) tab must not DESTROY work.
//
// All tabs share one proposals blob with no cross-tab merge, so a secondary tab writing the shared
// key would clobber the primary's work — that part of the guard is right. What was wrong is what it
// did instead: dropped the write entirely. A road drawn in a read-only tab rendered fine, answered
// getAllProposals(), and then simply did not exist after a reload. Warning that work MIGHT be lost
// is not a licence to delete it.
//
// The work is now parked under its own key (a different record, so the primary's blob is untouched)
// and offered back on the next primary load.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const dataSrc = readFileSync(new URL('../../frontend/js/proposals/data.js', import.meta.url), 'utf8');

// The real proposalStorage object, with a fake PersistentStorage underneath so we can see exactly
// which KEYS get written — the whole point of the fix is that it writes a different one.
function bootStore({ secondaryTab }) {
    const store = new Map();
    globalThis.window = globalThis;
    globalThis.__cbSecondaryTab = secondaryTab;
    globalThis.PersistentStorage = {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: key => store.delete(key)
    };
    // data.js is a classic script declaring top-level `const`s, which an indirect eval keeps in its
    // own script scope rather than putting on globalThis — so take the object as the completion value.
    const proposalStorage = (0, eval)(dataSrc + '\n;proposalStorage');
    return { proposalStorage, store };
}

const ROAD = { proposalId: 'p-road-1', title: 'Road 0208-1547', roadProposal: { definition: { segments: [] } } };

// addProposal() pulls in the whole normalisation chain from other frontend files, which is not what
// is under test here — put the proposal straight into the store's map and drive persistence.
function withProposal(ctx, proposal) {
    ctx.proposalStorage.proposals.set(String(proposal.proposalId), proposal);
    return ctx;
}

describe('read-only tab keeps work instead of dropping it', () => {
    let ctx;
    afterEach(() => { delete globalThis.__cbSecondaryTab; });

    it('never writes the shared key from a read-only tab', () => {
        ctx = withProposal(bootStore({ secondaryTab: true }), ROAD);
        ctx.proposalStorage._persist();
        // The reason the guard exists at all: the primary tab's blob must be untouched.
        expect(ctx.store.has('cadastre_proposals')).toBe(false);
    });

    it('parks the work under its own key rather than discarding it', () => {
        ctx = withProposal(bootStore({ secondaryTab: true }), ROAD);
        ctx.proposalStorage._persist();
        const parked = ctx.store.get('cadastre_proposals_recovery');
        expect(parked, 'a read-only tab must not silently destroy the proposal').toBeTruthy();
        expect(JSON.parse(parked).proposals.map(p => p.proposalId)).toContain('p-road-1');
    });

    it('offers the parked work back to a primary tab, and restoring consumes the slot', () => {
        // Park it as a secondary tab...
        ctx = withProposal(bootStore({ secondaryTab: true }), ROAD);
        ctx.proposalStorage._persist();
        const parkedBlob = ctx.store.get('cadastre_proposals_recovery');

        // ...then reopen as the primary tab, with that slot still present and nothing else stored.
        const fresh = bootStore({ secondaryTab: false });
        fresh.store.set('cadastre_proposals_recovery', parkedBlob);

        const offer = fresh.proposalStorage.readRecovery();
        expect(offer).toBeTruthy();
        expect(offer.proposals.map(p => p.proposalId)).toEqual(['p-road-1']);

        const restored = [];
        fresh.proposalStorage.addProposal = entry => restored.push(entry.proposalId);
        expect(fresh.proposalStorage.restoreRecovery()).toBe(1);
        expect(restored).toEqual(['p-road-1']);
        // Restoring consumes the slot; DECLINING (never calling this) deliberately does not, so
        // "Not now" can never be the click that finally loses the work.
        expect(fresh.store.has('cadastre_proposals_recovery')).toBe(false);
    });

    it('does not offer back something the user already redrew', () => {
        // The common case: you gave up on the read-only tab and drew the road again. Re-adding the
        // parked copy would duplicate it.
        const fresh = withProposal(bootStore({ secondaryTab: false }), ROAD);
        fresh.store.set('cadastre_proposals_recovery', JSON.stringify({ savedAt: null, proposals: [ROAD] }));
        expect(fresh.proposalStorage.readRecovery()).toBeNull();
    });

    it('a secondary tab is never offered the restore, or it would just park it again', () => {
        ctx = bootStore({ secondaryTab: true });
        ctx.store.set('cadastre_proposals_recovery', JSON.stringify({ savedAt: null, proposals: [ROAD] }));
        expect(ctx.proposalStorage.readRecovery()).toBeNull();
    });
});
