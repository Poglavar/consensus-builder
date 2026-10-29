// The globe's and the landing feed's ways into the map (world/proposal-entry.js): a design opens its
// selection without being applied, an agreement its link (/agreements/<cid>) and panel, a bet its dialog
// (/bets/<agreement account>); another city's item reloads on its link.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../frontend/js/world/proposal-entry.js', import.meta.url), 'utf8');
function setup(proposal, { keepsView = false } = {}) {
    const win = {
        location: { origin: 'http://localhost:8107', href: 'http://localhost:8107/?world=1&lang=hr&backend=http%3A%2F%2Flocalhost%3A3037', search: '' },
        document: { readyState: 'loading', getElementById: () => 'details-panel' }, addEventListener: vi.fn(), history: { pushState: vi.fn(), replaceState: vi.fn() },
        CityConfigManager: { getCityConfig: id => ['zagreb','new_york','explore'].includes(id) ? {} : null, getCurrentCityId: () => 'zagreb', switchCity: vi.fn(async () => true) },
        getProposalByIdOrHash: vi.fn(() => proposal), getProposalKey: p => p.proposalId,
        importServerProposal: vi.fn(async cid => ({ proposalId: `design-${cid}`, applied: false })),
        WorldView: { close: vi.fn(), isOpen: () => true, captureHandoffFrame: () => 'data:image/jpeg;base64,globe' }, WorldEntry: { finishNavigation: vi.fn() },
        WorldHandoff: { store: vi.fn(), proposalReady: vi.fn() },
        openProposalFromList: vi.fn(() => true), applyProposalToMap: vi.fn(),
        setProposalDetailsPanelMinimized: vi.fn(),
        whenAppBooted: vi.fn(async () => {}), openBetDialog: vi.fn(async () => ({})),
        AgreementSync: { handleAgreementRoute: vi.fn(async () => true) },
        SelectionAddress: { keepsView: () => keepsView }, ClickStack: { keepNextView: vi.fn() },
    };
    win.location.assign = vi.fn();
    vm.runInNewContext(source, { window: win, URL, URLSearchParams });
    return win;
}
// A city pick on the globe arrives on that city's latest published design, by its CID (ui/world-entry.js);
// a design read from the index is stored locally as design-<cid>.
const DESIGN = 'bafkreiehkrtqnkc7fjuviaz4oyqis7wexv3zsq3vfzknyf43rc5qvygce4';
const event = { proposalId: DESIGN, cityId: 'zagreb', href: `/?design=${DESIGN}&city=zagreb` };
describe('opening a globe design on the map', () => {
    for (const applied of [true,false]) it(`preserves the local ${applied ? 'applied' : 'unapplied'} copy and opens existing selection`, async () => {
        const proposal = { proposalId: `design-${DESIGN}`, applied }; const win = setup(proposal);
        await win.WorldProposalEntry.open(event);
        expect(win.importServerProposal).not.toHaveBeenCalled();
        expect(win.openProposalFromList).toHaveBeenCalledWith(`design-${DESIGN}`, { proposal, closeSheets: true, centerOnProposal: true });
        expect(win.applyProposalToMap).not.toHaveBeenCalled();
        expect(proposal.applied).toBe(applied);
        expect(win.WorldView.close).toHaveBeenCalledOnce();
        expect(win.WorldEntry.finishNavigation).toHaveBeenCalledOnce();
        expect(win.setProposalDetailsPanelMinimized).toHaveBeenCalledWith('details-panel', false);
        expect(win.openProposalFromList.mock.invocationCallOrder[0]).toBeLessThan(win.WorldView.close.mock.invocationCallOrder[0]);
        expect(win.WorldProposalEntry.isOpening()).toBe(false);
    });
    it('downloads an absent design by its CID through the existing importer and previews without applying it', async () => {
        const win = setup(null); await win.WorldProposalEntry.open(event);
        expect(win.importServerProposal).toHaveBeenCalledWith(DESIGN);
        expect(win.openProposalFromList.mock.calls[0][0]).toBe(`design-${DESIGN}`);
        expect(win.openProposalFromList.mock.calls[0][1].proposal.applied).toBe(false);
        expect(win.applyProposalToMap).not.toHaveBeenCalled();
    });
    it('switches city with a map-focus route and preserves language and local backend routing', async () => {
        const win = setup(null); const other = { ...event, cityId: 'new_york', href: `/?design=${DESIGN}&city=new_york` };
        await win.WorldProposalEntry.open(other);
        expect(win.CityConfigManager.switchCity).toHaveBeenCalledWith('new_york', { requireConfirmation: false, url: expect.any(String) });
        expect(win.WorldHandoff.store).toHaveBeenCalledWith({ dataUrl: 'data:image/jpeg;base64,globe', cityId: 'new_york', proposalId: DESIGN });
        // the switch goes to the design's address; the entry being left is not rewritten (Back)
        expect(win.history.replaceState).not.toHaveBeenCalled();
        const route = new URL(win.CityConfigManager.switchCity.mock.calls[0][1].url, win.location.origin);
        expect(route.searchParams.get('design')).toBe(DESIGN);
        expect(route.searchParams.get('lang')).toBe('hr');
        expect(route.searchParams.get('backend')).toBe('http://localhost:3037');
        expect(route.searchParams.has('world')).toBe(false);
        expect(route.searchParams.has('activity')).toBe(false);
        expect(win.importServerProposal).not.toHaveBeenCalled();
    });
    it('sends a design of another city home instead of storing it here (a stale or missing ?city=)', async () => {
        // storage refuses another city's record (proposals/data.js); the link opens it in its city,
        // asking first when the link came from outside
        for (const fromUrl of [false, true]) {
            const win = setup(null);
            win.importServerProposal.mockRejectedValue(Object.assign(new Error('elsewhere'), { code: 'proposal-in-other-city', cityId: 'split' }));
            win.openProposalInItsCity = vi.fn(async () => true);
            await win.WorldProposalEntry.open(event, { fromUrl });
            expect(win.openProposalInItsCity).toHaveBeenCalledWith(DESIGN, 'split', { ask: fromUrl });
            expect(win.openProposalFromList).not.toHaveBeenCalled();
            expect(win.WorldProposalEntry.isOpening()).toBe(false);
        }
    });
    it('leaves the globe available after a failed download and releases the opening guard', async () => {
        const win = setup(null); win.importServerProposal.mockRejectedValue(new Error('offline'));
        await expect(win.WorldProposalEntry.open(event)).rejects.toThrow('offline');
        expect(win.WorldView.close).not.toHaveBeenCalled();
        expect(win.WorldProposalEntry.isOpening()).toBe(false);
    });
    it('releases the reload cover after framing the design, including failed downloads', async () => {
        const win = setup(null);
        await win.WorldProposalEntry.open(event, { fromUrl: true });
        expect(win.WorldHandoff.proposalReady).toHaveBeenCalledWith(DESIGN);
        expect(win.openProposalFromList.mock.invocationCallOrder[0]).toBeLessThan(win.WorldHandoff.proposalReady.mock.invocationCallOrder[0]);
        win.importServerProposal.mockRejectedValue(new Error('offline'));
        await expect(win.WorldProposalEntry.open(event, { fromUrl: true })).rejects.toThrow('offline');
        expect(win.WorldHandoff.proposalReady).toHaveBeenCalledTimes(2);
    });
    it('reopens a reloaded selection where the view in the address left it, framing it only without one', async () => {
        const proposal = { proposalId: `design-${DESIGN}`, applied: false };
        const kept = setup(proposal, { keepsView: true });
        await kept.WorldProposalEntry.open(event, { fromUrl: true });
        expect(kept.ClickStack.keepNextView).toHaveBeenCalledWith();
        expect(kept.openProposalFromList.mock.calls[0][1].centerOnProposal).toBe(false);
        expect(kept.ClickStack.keepNextView).toHaveBeenLastCalledWith(false);
        const framed = setup(proposal, { keepsView: true });
        await framed.WorldProposalEntry.open(event);
        expect(framed.ClickStack.keepNextView).not.toHaveBeenCalled();
        expect(framed.openProposalFromList.mock.calls[0][1].centerOnProposal).toBe(true);
    });
});

describe('opening a globe agreement', () => {
    const cid = 'bafkreiftzbz2gpufkdckedn2fgb6jiq3qxd6zeohfzmgm42rysek3kuf7y';
    const agreement = { agreementCid: cid, cityId: 'zagreb', subject: 'Courtyard infill', href: `/agreements/${cid}?city=zagreb` };
    it('opens the agreement on its link over this city, not a design', async () => {
        const win = setup(null);
        await win.WorldProposalEntry.openAgreement(agreement);
        expect(win.history.pushState).toHaveBeenCalledWith(null, '', `/agreements/${cid}?city=zagreb&lang=hr&backend=http%3A%2F%2Flocalhost%3A3037`);
        expect(win.WorldView.close).toHaveBeenCalledOnce();
        expect(win.WorldEntry.finishNavigation).toHaveBeenCalledOnce();
        expect(win.whenAppBooted).toHaveBeenCalled();
        expect(win.AgreementSync.handleAgreementRoute).toHaveBeenCalledWith(cid);
        expect(win.history.pushState.mock.invocationCallOrder[0]).toBeLessThan(win.AgreementSync.handleAgreementRoute.mock.invocationCallOrder[0]);
        expect(win.openProposalFromList).not.toHaveBeenCalled();
        expect(win.CityConfigManager.switchCity).not.toHaveBeenCalled();
        expect(win.WorldProposalEntry.isOpening()).toBe(false);
    });
    it("loads another city's agreement on its link, keeping the globe frame, language and local backend routing", async () => {
        const win = setup(null);
        await win.WorldProposalEntry.openAgreement({ ...agreement, cityId: 'new_york', href: `/agreements/${cid}?city=new_york` });
        expect(win.WorldHandoff.store).toHaveBeenCalledWith({ dataUrl: 'data:image/jpeg;base64,globe', cityId: 'new_york' });
        const [city, options] = win.CityConfigManager.switchCity.mock.calls[0];
        expect(city).toBe('new_york');
        expect(options.requireConfirmation).toBe(false);
        const route = new URL(options.url);
        expect(route.pathname).toBe(`/agreements/${cid}`);
        expect(route.searchParams.get('city')).toBe('new_york');
        expect(route.searchParams.get('lang')).toBe('hr');
        expect(route.searchParams.get('backend')).toBe('http://localhost:3037');
        expect(win.history.pushState).not.toHaveBeenCalled();
        expect(win.AgreementSync.handleAgreementRoute).not.toHaveBeenCalled();
    });
    it('reports a city switch or an agreement that could not open and releases the opening guard', async () => {
        const stuck = setup(null); stuck.CityConfigManager.switchCity.mockResolvedValue(false);
        await expect(stuck.WorldProposalEntry.openAgreement({ ...agreement, cityId: 'new_york', href: `/agreements/${cid}?city=new_york` })).rejects.toThrow('City navigation could not open');
        expect(stuck.WorldProposalEntry.isOpening()).toBe(false);
        const offline = setup(null); offline.AgreementSync.handleAgreementRoute.mockRejectedValue(new Error('offline'));
        await expect(offline.WorldProposalEntry.openAgreement(agreement)).rejects.toThrow('offline');
        expect(offline.WorldProposalEntry.isOpening()).toBe(false);
    });
    it('ignores a second pick while the first is still opening', async () => {
        const win = setup(null);
        let boot;
        win.whenAppBooted.mockReturnValue(new Promise(resolve => { boot = resolve; }));
        const first = win.WorldProposalEntry.openAgreement(agreement);
        expect(win.WorldProposalEntry.isOpening()).toBe(true);
        await win.WorldProposalEntry.openAgreement(agreement);
        await win.WorldProposalEntry.openBet({ agreementAccount: 'E323eSpdyobhdFKPCi2wcMj12ryFcJjhjKfZjpH8pxBh', cityId: 'zagreb', href: '/bets/E323eSpdyobhdFKPCi2wcMj12ryFcJjhjKfZjpH8pxBh?city=zagreb' });
        boot();
        await first;
        expect(win.history.pushState).toHaveBeenCalledOnce();
        expect(win.AgreementSync.handleAgreementRoute).toHaveBeenCalledOnce();
        expect(win.openBetDialog).not.toHaveBeenCalled();
        expect(win.WorldProposalEntry.isOpening()).toBe(false);
    });
});

describe('opening a globe bet', () => {
    const account = 'E323eSpdyobhdFKPCi2wcMj12ryFcJjhjKfZjpH8pxBh';
    const bet = { agreementCid: 'bafkreiftzbz2gpufkdckedn2fgb6jiq3qxd6zeohfzmgm42rysek3kuf7y', agreementAccount: account, cityId: 'zagreb', subject: 'Infill', href: `/bets/${account}?city=zagreb` };
    it('opens the bet dialog over this city, not the agreement', async () => {
        const win = setup(null);
        await win.WorldProposalEntry.openBet(bet);
        expect(win.WorldView.close).toHaveBeenCalledOnce();
        expect(win.WorldEntry.finishNavigation).toHaveBeenCalledOnce();
        expect(win.openBetDialog).toHaveBeenCalledWith({ account, title: 'Infill' });
        expect(win.AgreementSync.handleAgreementRoute).not.toHaveBeenCalled();
        expect(win.history.pushState).toHaveBeenCalledWith(null, '', `/bets/${account}?city=zagreb&lang=hr&backend=http%3A%2F%2Flocalhost%3A3037`);
        expect(win.history.pushState.mock.invocationCallOrder[0]).toBeLessThan(win.WorldEntry.finishNavigation.mock.invocationCallOrder[0]);
        expect(win.openProposalFromList).not.toHaveBeenCalled();
        expect(win.location.assign).not.toHaveBeenCalled();
        expect(win.WorldProposalEntry.isOpening()).toBe(false);
    });
    it("loads another city's bet on its bet link, keeping language and local backend routing", async () => {
        const win = setup(null);
        await win.WorldProposalEntry.openBet({ ...bet, cityId: 'new_york', href: `/bets/${account}?city=new_york` });
        const route = new URL(win.location.assign.mock.calls[0][0], win.location.origin);
        expect(route.pathname).toBe(`/bets/${account}`);
        expect(route.searchParams.get('city')).toBe('new_york');
        expect(route.searchParams.get('lang')).toBe('hr');
        expect(route.searchParams.get('backend')).toBe('http://localhost:3037');
        expect(win.WorldView.close).not.toHaveBeenCalled();
        expect(win.openBetDialog).not.toHaveBeenCalled();
    });
    it('reports a dialog that could not open and releases the opening guard', async () => {
        const win = setup(null); win.openBetDialog.mockResolvedValue(null);
        await expect(win.WorldProposalEntry.openBet(bet)).rejects.toThrow('Bet dialog could not open');
        expect(win.WorldProposalEntry.isOpening()).toBe(false);
    });
});
