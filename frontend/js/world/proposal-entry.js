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
    async function open(event, { fromUrl = false } = {}) {
        if (opening) return;
        opening = true;
        try {
            const manager = global.CityConfigManager;
            const target = href(event);
            const city = new URL(target, global.location.origin).searchParams.get('city');
            if (city !== manager.getCurrentCityId()) {
                if (global.WorldView.isOpen()) {
                    global.WorldHandoff.store({ dataUrl: global.WorldView.captureHandoffFrame(), cityId: city, proposalId: event.proposalId });
                }
                global.history.replaceState(null, '', target);
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
        } finally {
            if (fromUrl) global.WorldHandoff.proposalReady(event.proposalId);
            opening = false;
        }
    }
    global.WorldProposalEntry = { href, open, isOpening: () => opening };
    async function fromUrl() {
        const params = new URLSearchParams(global.location.search);
        const id = params.get('focusProposal');
        if (!id) return;
        try {
            await global.whenAppBooted();
            if (global.i18n.t('world.activity.title') === 'world.activity.title') {
                await new Promise(resolve => global.addEventListener('i18n:translationsLoaded', resolve, { once: true }));
            }
            await open({ proposalId: id, cityId: global.CityConfigManager.getCurrentCityId(), href: '/?' + params }, { fromUrl: true });
        } catch (error) {
            console.warn('[world] Proposal route could not open', error);
            global.updateStatus(global.i18n.t('world.activity.openError'));
            global.WorldHandoff.proposalReady(id);
        }
    }
    if (global.document.readyState === 'complete') fromUrl();
    else global.addEventListener('load', fromUrl, { once: true });
})(window);
