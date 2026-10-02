import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../frontend/js/world/proposal-entry.js', import.meta.url), 'utf8');
function setup(proposal) {
    const win = {
        location: { origin: 'http://localhost:8107', href: 'http://localhost:8107/?world=1&lang=hr&backend=http%3A%2F%2Flocalhost%3A3037', search: '' },
        document: { readyState: 'loading', getElementById: () => 'details-panel' }, addEventListener: vi.fn(), history: { pushState: vi.fn(), replaceState: vi.fn() },
        CityConfigManager: { getCityConfig: id => ['zagreb','new_york','explore'].includes(id) ? {} : null, getCurrentCityId: () => 'zagreb', switchCity: vi.fn(async () => true) },
        getProposalByIdOrHash: vi.fn(() => proposal), getProposalKey: p => p.proposalId,
        importServerProposal: vi.fn(async id => ({ proposalId: id, applied: false })),
        WorldView: { close: vi.fn(), isOpen: () => true, captureHandoffFrame: () => 'data:image/jpeg;base64,globe' }, WorldEntry: { finishNavigation: vi.fn() },
        WorldHandoff: { store: vi.fn(), proposalReady: vi.fn() },
        openProposalFromList: vi.fn(() => true), applyProposalToMap: vi.fn(),
        setProposalDetailsPanelMinimized: vi.fn(),
    };
    vm.runInNewContext(source, { window: win, URL, URLSearchParams });
    return win;
}
const event = { proposalId: 'park-1', cityId: 'zagreb', href: '/?focusProposal=park-1&city=zagreb' };
describe('opening a globe event on the map', () => {
    for (const applied of [true,false]) it(`preserves the local ${applied ? 'applied' : 'unapplied'} copy and opens existing selection`, async () => {
        const proposal = { proposalId: 'park-1', applied }; const win = setup(proposal);
        await win.WorldProposalEntry.open(event);
        expect(win.importServerProposal).not.toHaveBeenCalled();
        expect(win.openProposalFromList).toHaveBeenCalledWith('park-1', { proposal, closeSheets: true });
        expect(win.applyProposalToMap).not.toHaveBeenCalled();
        expect(proposal.applied).toBe(applied);
        expect(win.WorldView.close).toHaveBeenCalledOnce();
        expect(win.WorldEntry.finishNavigation).toHaveBeenCalledOnce();
        expect(win.setProposalDetailsPanelMinimized).toHaveBeenCalledWith('details-panel', false);
        expect(win.openProposalFromList.mock.invocationCallOrder[0]).toBeLessThan(win.WorldView.close.mock.invocationCallOrder[0]);
        expect(win.WorldProposalEntry.isOpening()).toBe(false);
    });
    it('downloads an absent proposal through the existing importer and previews without applying it', async () => {
        const win = setup(null); await win.WorldProposalEntry.open(event);
        expect(win.importServerProposal).toHaveBeenCalledWith('park-1');
        expect(win.openProposalFromList.mock.calls[0][1].proposal.applied).toBe(false);
        expect(win.applyProposalToMap).not.toHaveBeenCalled();
    });
    it('switches city with a map-focus route and preserves language and local backend routing', async () => {
        const win = setup(null); const other = { ...event, cityId: 'new_york', href: '/?focusProposal=park-1&city=new_york' };
        await win.WorldProposalEntry.open(other);
        expect(win.CityConfigManager.switchCity).toHaveBeenCalledWith('new_york', { requireConfirmation: false });
        expect(win.WorldHandoff.store).toHaveBeenCalledWith({ dataUrl: 'data:image/jpeg;base64,globe', cityId: 'new_york', proposalId: 'park-1' });
        const route = new URL(win.history.replaceState.mock.calls[0][2], win.location.origin);
        expect(route.searchParams.get('focusProposal')).toBe('park-1');
        expect(route.searchParams.get('lang')).toBe('hr');
        expect(route.searchParams.get('backend')).toBe('http://localhost:3037');
        expect(route.searchParams.has('world')).toBe(false);
        expect(route.searchParams.has('activity')).toBe(false);
        expect(win.importServerProposal).not.toHaveBeenCalled();
    });
    it('leaves the globe available after a failed download and releases the opening guard', async () => {
        const win = setup(null); win.importServerProposal.mockRejectedValue(new Error('offline'));
        await expect(win.WorldProposalEntry.open(event)).rejects.toThrow('offline');
        expect(win.WorldView.close).not.toHaveBeenCalled();
        expect(win.WorldProposalEntry.isOpening()).toBe(false);
    });
    it('releases the reload cover after framing the proposal, including failed downloads', async () => {
        const win = setup(null);
        await win.WorldProposalEntry.open(event, { fromUrl: true });
        expect(win.WorldHandoff.proposalReady).toHaveBeenCalledWith('park-1');
        expect(win.openProposalFromList.mock.invocationCallOrder[0]).toBeLessThan(win.WorldHandoff.proposalReady.mock.invocationCallOrder[0]);
        win.importServerProposal.mockRejectedValue(new Error('offline'));
        await expect(win.WorldProposalEntry.open(event, { fromUrl: true })).rejects.toThrow('offline');
        expect(win.WorldHandoff.proposalReady).toHaveBeenCalledTimes(2);
    });
});
