// The landing feed opens the existing proposal selection/preview, never applies a proposal.
(function (global) {
    'use strict';
    let opening = false;
    function href(event) {
        const url = new URL(event.href, global.location.origin);
        const current = new URL(global.location.href);
        for (const key of ['lang', 'reduceMotion']) {
            if (current.searchParams.has(key)) url.searchParams.set(key, current.searchParams.get(key));
        }
        if (['localhost', '127.0.0.1'].includes(current.hostname) && current.searchParams.has('backend')) {
            url.searchParams.set('backend', current.searchParams.get('backend'));
        }
        const city = event.cityId && global.CityConfigManager.getCityConfig(event.cityId) ? event.cityId : 'explore';
        url.searchParams.set('city', city);
        return url.pathname + url.search;
    }
    // `arrive` ('latest' for a city pick, 'pick' for a feed pick) lands in 3D on the proposal
    // (js/world/arrival.js); it rides the city-switch reload as ?arrive= and is consumed on arrival.
    async function open(event, { fromUrl = false, arrive = null } = {}) {
        if (opening) return;
        opening = true;
        try {
            const manager = global.CityConfigManager;
            const target = href(event);
            // ?arrive= only rides the reload; the address bar never keeps it, so a reload does not dive again.
            const reloadUrl = new URL(target, global.location.origin);
            if (arrive) reloadUrl.searchParams.set('arrive', arrive);
            const city = new URL(target, global.location.origin).searchParams.get('city');
            if (city !== manager.getCurrentCityId()) {
                if (global.WorldView.isOpen()) {
                    global.WorldHandoff.store({ dataUrl: global.WorldView.captureHandoffFrame(), cityId: city, proposalId: event.proposalId });
                }
                global.history.replaceState(null, '', reloadUrl.pathname + reloadUrl.search);
                const navigating = await manager.switchCity(city, { requireConfirmation: false });
                if (!navigating) throw new Error('City navigation could not open');
                return;
            }
            let proposal = global.getProposalByIdOrHash(event.proposalId);
            if (!proposal) proposal = await global.importServerProposal(event.proposalId);
            // The local copy is preferred above: downloading must never reset its applied state.
            if (!fromUrl) global.history.pushState(null, '', target);
            const opened = global.openProposalFromList(global.getProposalKey(proposal) || event.proposalId, { proposal, closeSheets: true });
            if (!opened) throw new Error('Proposal selection could not open');
            // Selection normally opens a compact card; feed arrivals also need its Activity link.
            global.setProposalDetailsPanelMinimized(global.document.getElementById('proposal-details-panel'), false);
            global.WorldView.close();
            global.WorldEntry.finishNavigation();
            // The globe's cover (released in finally) stays over the 3D load.
            if (arrive) await global.WorldArrival.enter3D(proposal);
        } finally {
            if (fromUrl) global.WorldHandoff.proposalReady(event.proposalId);
            opening = false;
        }
    }
    // A bet in the feed opens that bet's own dialog over the map of its city; another city's bet
    // loads that city on the bet link (/bets/<proposal account>), which opens the dialog on arrival.
    async function openBet(event) {
        if (opening) return;
        opening = true;
        try {
            const target = href(event);
            const city = new URL(target, global.location.origin).searchParams.get('city');
            if (city !== global.CityConfigManager.getCurrentCityId()) {
                global.location.assign(target);
                return;
            }
            // The bet's address goes in first, as a proposal pick's does: landing reads it (the first-visit
            // intro stands aside for a bet link), and the dialog keeps it while open.
            global.history.pushState(null, '', target);
            global.WorldView.close();
            global.WorldEntry.finishNavigation();
            await global.whenAppBooted();
            const dialog = await global.openBetDialog({ proposalAccount: event.proposalAccount, title: event.subject });
            if (!dialog) throw new Error('Bet dialog could not open');
        } finally {
            opening = false;
        }
    }
    global.WorldProposalEntry = { href, open, openBet, isOpening: () => opening };
    async function fromUrl() {
        const params = new URLSearchParams(global.location.search);
        const id = params.get('focusProposal');
        if (!id) return;
        const arrive = params.get('arrive');
        if (arrive) {
            // Consumed once: a reload of this URL reopens the proposal without diving again.
            params.delete('arrive');
            global.history.replaceState(global.history.state, '', global.location.pathname + '?' + params);
        }
        try {
            await global.whenAppBooted();
            if (global.i18n.t('world.activity.title') === 'world.activity.title') {
                await new Promise(resolve => global.addEventListener('i18n:translationsLoaded', resolve, { once: true }));
            }
            await open({ proposalId: id, cityId: global.CityConfigManager.getCurrentCityId(), href: '/?' + params }, { fromUrl: true, arrive });
        } catch (error) {
            console.warn('[world] Proposal route could not open', error);
            global.updateStatus(global.i18n.t('world.activity.openError'));
            global.WorldHandoff.proposalReady(id);
        }
    }
    if (global.document.readyState === 'complete') fromUrl();
    else global.addEventListener('load', fromUrl, { once: true });
})(window);
