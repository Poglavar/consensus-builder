// Exercise the record-route dispatch (proposals/core.js handleProposalRouteFromUrl) without a browser:
// the proposal list, design and agreement links (plan-design-agreement.md, M2), the boot's parcel
// fetch handed back however a link ends, and the retired id, named-plan and on-chain proposal links
// answering nothing (designs are not minted, M3).
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');
const sharedSource = readFileSync(new URL('../../frontend/js/proposals/sharing-routes.js', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../frontend/js/proposals/core.js', import.meta.url), 'utf8');

const cidOf = text => Cid.cidOf(new TextEncoder().encode(text));
const DESIGN_A = cidOf('design-a');
const DESIGN_B = cidOf('design-b');
const AGREEMENT = cidOf('agreement-a');

function boot(pathname, connected = false) {
    const window = {
        location: { pathname, search: '?city=nairobi', hash: '#details' },
        walletManager: { getState: () => ({ status: connected ? 'connected' : 'disconnected', accounts: connected ? ['wallet'] : [] }) },
        AgreementSync: { handleAgreementRoute: vi.fn(async () => ({})) },
        // A design or agreement link holds the boot's viewport parcel fetch (map-core.js IS_PROPOSAL_DEEP_LINK).
        skipParcelFetchUntilProposalLoaded: true
    };
    const context = vm.createContext({
        window, showAllProposalsModal: vi.fn(),
        map: { fire: vi.fn() },
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
        console: { log() {}, debug() {}, info() {}, warn: vi.fn(), error: vi.fn() }
    });
    vm.runInContext(sharedSource, context);
    // The design route itself is exercised in shared-plan-import.test.js; here only the dispatch.
    context.handleSharedDesignRoute = vi.fn(async () => ({}));
    vm.runInContext(source, context);
    return context;
}

describe('proposal URL entry', () => {
    it.each(['/proposals', '/proposals/'])('opens the proposals collection for a guest at %s', async pathname => {
        const app = boot(pathname);
        await app.handleProposalRouteFromUrl();
        expect(app.showAllProposalsModal).toHaveBeenCalledOnce();
        expect(app.window.location).toEqual({ pathname, search: '?city=nairobi', hash: '#details' });
    });

    // There is no minted-proposals list any more: a connected wallet gets the same collection.
    it.each(['/proposals', '/proposals/'])('opens the same collection for a connected wallet at %s', async pathname => {
        const app = boot(pathname, true);
        await app.handleProposalRouteFromUrl();
        expect(app.showAllProposalsModal).toHaveBeenCalledOnce();
        expect(app.handleSharedDesignRoute).not.toHaveBeenCalled();
    });

    it.each([`/designs/${DESIGN_A},${DESIGN_B}`, `/designs/${DESIGN_A},${DESIGN_B}/`])('opens the shared designs at %s, then gives the parcel fetch back', async pathname => {
        const app = boot(pathname);
        await app.handleProposalRouteFromUrl();
        expect(app.handleSharedDesignRoute).toHaveBeenCalledExactlyOnceWith([DESIGN_A, DESIGN_B]);
        expect(app.window.AgreementSync.handleAgreementRoute).not.toHaveBeenCalled();
        expect(app.window.skipParcelFetchUntilProposalLoaded).toBe(false);
        expect(app.map.fire).toHaveBeenCalledWith('moveend');
        expect(app.window.location.pathname).toBe(pathname);
    });

    it('opens a proposed agreement at /agreements/<cid>', async () => {
        const app = boot(`/agreements/${AGREEMENT}`);
        await app.handleProposalRouteFromUrl();
        expect(app.window.AgreementSync.handleAgreementRoute).toHaveBeenCalledExactlyOnceWith(AGREEMENT);
        expect(app.handleSharedDesignRoute).not.toHaveBeenCalled();
        expect(app.window.skipParcelFetchUntilProposalLoaded).toBe(false);
    });

    it('gives the parcel fetch back when a design link fails', async () => {
        const app = boot(`/designs/${DESIGN_A}`);
        app.handleSharedDesignRoute = vi.fn(async () => { throw new Error('index unreachable'); });
        await app.handleProposalRouteFromUrl();
        expect(app.window.skipParcelFetchUntilProposalLoaded).toBe(false);
        expect(app.map.fire).toHaveBeenCalledWith('moveend');
        expect(app.console.error).toHaveBeenCalledWith('handleProposalRouteFromUrl failed:', expect.objectContaining({ message: 'index unreachable' }));
    });

    it.each(['/proposals/12,13', '/proposals/garden-plan', '/proposals/solana/devnet/PROG/ACCT', '/proposals/evm/84532/0xabc/5'])('answers the retired link %s with no route', async pathname => {
        const app = boot(pathname, true);
        await app.handleProposalRouteFromUrl();
        expect(app.handleSharedDesignRoute).not.toHaveBeenCalled();
        expect(app.window.AgreementSync.handleAgreementRoute).not.toHaveBeenCalled();
        expect(app.showAllProposalsModal).not.toHaveBeenCalled();
        expect(app.fetch).not.toHaveBeenCalled();
        expect(app.console.warn).toHaveBeenCalledWith(expect.stringContaining(`no proposal route matches ${pathname}`));
    });

    it('ignores unrelated path prefixes', async () => {
        const app = boot('/proposals-archive');
        await app.handleProposalRouteFromUrl();
        expect(app.showAllProposalsModal).not.toHaveBeenCalled();
        expect(app.handleSharedDesignRoute).not.toHaveBeenCalled();
        expect(app.fetch).not.toHaveBeenCalled();
        expect(app.console.warn).not.toHaveBeenCalled();
    });
});
