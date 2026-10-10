// Asks before following a shared proposal into another city.
//
// Cities each keep their own local store (see js/persistent-storage.js), so switching costs nothing
// but a reload — the city you leave is exactly as you left it when you come back. Nothing is erased,
// which is why a ?city= link is simply obeyed. What still deserves a question is a proposal that
// belongs somewhere else: following it moves the user off the map they were working on, and the
// link may not name a city at all (older shares, or a param dropped in transit). The proposal's own
// `city` field answers that, and this dialog lets the user decide.
(function (global) {
    'use strict';

    function t(key, fallback, params) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const translated = global.i18n.t(key, params || {});
                if (translated && translated !== key) return translated;
            }
        } catch (_) { }
        let text = fallback;
        if (params) {
            Object.keys(params).forEach((name) => {
                text = text.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}|\\{${name}\\}`, 'g'), params[name]);
            });
        }
        return text;
    }

    // Staying means the link's route must go too, or the shared proposal would be applied to the
    // wrong city's map. Rewrite the URL to a plain app load without reloading the page. The link's
    // ?city= becomes the city stayed in: dropped, a reload opened the stored city instead, which for
    // explore (never stored) is some other city altogether.
    function stripSharedRouteFromUrl() {
        try {
            const url = new URL(global.location.href);
            const current = global.CityConfigManager?.getCurrentCityId?.();
            if (current) url.searchParams.set('city', current);
            else url.searchParams.delete('city');
            url.searchParams.delete('proposalShare');
            url.searchParams.delete('shared');
            url.searchParams.delete('bets');
            url.searchParams.delete('focusProposal');
            const path = (url.pathname.startsWith('/proposals/') || url.pathname.startsWith('/plans/') || url.pathname.startsWith('/bets/')) ? '/' : url.pathname;
            global.history.replaceState(null, '', `${path}${url.search}${url.hash}`);
        } catch (_) { /* a stale URL is better than a thrown error */ }
    }

    function buildButton(label, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        return button;
    }

    // Resolves to true when the user wants to follow the proposal into its city.
    function askUser(currentLabel, requestedLabel) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'cb-confirm-overlay';

            const dialog = document.createElement('div');
            dialog.className = 'cb-confirm-dialog city-switch-dialog';

            const heading = document.createElement('h3');
            heading.className = 'city-switch-title';
            heading.textContent = t(
                'city.switchPrompt.title',
                'This proposal is in {requested} — you are viewing {current}',
                { requested: requestedLabel, current: currentLabel }
            );

            const body = document.createElement('div');
            body.className = 'cb-confirm-message';
            body.textContent = t(
                'city.switchPrompt.body',
                'Opening it switches the map to {requested} and reloads. Your work in {current} is kept and will be here when you come back.',
                { requested: requestedLabel, current: currentLabel }
            );

            const buttons = document.createElement('div');
            buttons.className = 'cb-confirm-buttons city-switch-buttons';

            const stayBtn = buildButton(
                t('city.switchPrompt.stay', 'Stay in {current}', { current: currentLabel }),
                'btn btn-secondary'
            );
            const switchBtn = buildButton(
                t('city.switchPrompt.switch', 'Open in {requested}', { requested: requestedLabel }),
                'btn btn-action'
            );

            function close(result) {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve(result);
            }

            stayBtn.addEventListener('click', () => close(false));
            switchBtn.addEventListener('click', () => close(true));
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) close(false);
            });

            buttons.appendChild(stayBtn);
            buttons.appendChild(switchBtn);
            dialog.appendChild(heading);
            dialog.appendChild(body);
            dialog.appendChild(buttons);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            switchBtn.focus();
        });
    }

    // Resolves to true when the caller must abort — either the page is reloading into the other
    // city, or the user chose to stay and the route was dropped. A city the app does not configure
    // (an old placeholder such as 'city', a typo) is no city to go to: the route goes on here, as it
    // does for a record with no city at all, rather than asking about a place that cannot open.
    // `url`: the route to open in the other city (default: the current address, which then has to
    // carry the route already). The page being left keeps its history entry either way.
    async function promptCityMismatchForProposal(rawCityId, { url = null } = {}) {
        const manager = global.CityConfigManager;
        if (!manager || !rawCityId) return false;
        const requestedCityId = manager.resolveCityId(rawCityId);
        const currentCityId = manager.getCurrentCityId();
        if (!requestedCityId || requestedCityId === currentCityId) return false;

        // Either answer ends this route here (reload into the other city, or drop the link), so
        // the "Fetching proposal" card has nothing left to report — and left up, it showed through
        // behind this dialog as a second, half-hidden modal.
        if (typeof global.hideProposalLoadOverlay === 'function') global.hideProposalLoadOverlay();

        const follow = await askUser(manager.getCityLabel(currentCityId), manager.getCityLabel(requestedCityId));
        if (follow && await manager.switchCity(requestedCityId, url ? { url } : {})) return true;
        stripSharedRouteFromUrl();
        return true;
    }

    // Opens a proposal that belongs to another city's store (CityConfigManager.foreignCityFor; storage
    // refuses to import it here): reload into that city with ?focusProposal=<id>, which
    // world/proposal-entry.js opens on arrival. A click in a list, the search box or a feed is the
    // request itself; a link opened from outside asks first (`ask`), as shared links do. Resolves true
    // when the caller must stop (the page is leaving, or the route was dropped).
    async function openProposalInItsCity(proposalId, cityId, { ask = false } = {}) {
        const target = new URL(global.location.href);
        target.pathname = '/';
        target.searchParams.set('focusProposal', String(proposalId));
        if (ask) return promptCityMismatchForProposal(cityId, { url: target.href });
        if (await global.CityConfigManager.switchCity(cityId, { requireConfirmation: false, url: target.href })) return true;
        stripSharedRouteFromUrl();
        return true;
    }

    global.promptCityMismatchForProposal = promptCityMismatchForProposal;
    global.openProposalInItsCity = openProposalInItsCity;
})(window);
