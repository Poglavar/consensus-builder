// Exercise proposal URL dispatch without a browser, including collection URLs and trailing slashes.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposals/core.js', import.meta.url), 'utf8');

function boot(pathname, connected = false) {
    const window = {
        location: { pathname, search: '?city=nairobi', hash: '#details' },
        walletManager: { getState: () => ({ status: connected ? 'connected' : 'disconnected', accounts: connected ? ['wallet'] : [] }) },
        openMintedProposalsModal: vi.fn()
    };
    const context = vm.createContext({
        window, showAllProposalsModal: vi.fn(), handleSharedPlanRoute: vi.fn(async () => {}),
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({ proposalIds: [12, 13] }) })),
        console: { log() {}, debug() {}, warn: vi.fn(), error: vi.fn() }
    });
    vm.runInContext(source, context);
    return context;
}

describe('proposal URL entry', () => {
    it.each(['/proposals', '/proposals/'])('opens the proposals collection for a guest at %s', async pathname => {
        const app = boot(pathname);
        await app.handleProposalRouteFromUrl();
        expect(app.showAllProposalsModal).toHaveBeenCalledOnce();
        expect(app.window.openMintedProposalsModal).not.toHaveBeenCalled();
        expect(app.window.location).toEqual({ pathname, search: '?city=nairobi', hash: '#details' });
    });

    it.each(['/proposals', '/proposals/'])('opens minted proposals for a connected wallet at %s', async pathname => {
        const app = boot(pathname, true);
        await app.handleProposalRouteFromUrl();
        expect(app.window.openMintedProposalsModal).toHaveBeenCalledOnce();
        expect(app.showAllProposalsModal).not.toHaveBeenCalled();
    });

    it.each(['/proposals/12,13', '/proposals/12,13/'])('loads the same shared selection at %s', async pathname => {
        const app = boot(pathname);
        await app.handleProposalRouteFromUrl();
        expect(app.handleSharedPlanRoute).toHaveBeenCalledWith(['12', '13']);
        expect(app.window.location.pathname).toBe(pathname);
    });

    it.each(['/proposals/garden-plan', '/proposals/garden-plan/'])('resolves the named plan at %s', async pathname => {
        const app = boot(pathname);
        await app.handleProposalRouteFromUrl();
        expect(app.fetch).toHaveBeenCalledWith(expect.stringContaining('/plans/garden-plan'));
        expect(app.handleSharedPlanRoute).toHaveBeenCalledWith(['12', '13']);
        expect(app.window.location.pathname).toBe(pathname);
    });

    it('ignores unrelated path prefixes', async () => {
        const app = boot('/proposals-archive');
        await app.handleProposalRouteFromUrl();
        expect(app.showAllProposalsModal).not.toHaveBeenCalled();
        expect(app.handleSharedPlanRoute).not.toHaveBeenCalled();
        expect(app.fetch).not.toHaveBeenCalled();
    });
});
