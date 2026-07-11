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
    // wrong city's map. Rewrite the URL to a plain app load without reloading the page.
    function stripSharedRouteFromUrl() {
        try {
            const url = new URL(global.location.href);
            url.searchParams.delete('city');
            url.searchParams.delete('proposalShare');
            url.searchParams.delete('shared');
            const path = url.pathname.startsWith('/proposals/') ? '/' : url.pathname;
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
    // city, or the user chose to stay and the route was dropped.
    async function promptCityMismatchForProposal(requestedCityId) {
        const manager = global.CityConfigManager;
        if (!manager || !requestedCityId) return false;
        const currentCityId = manager.getCurrentCityId();
        if (requestedCityId === currentCityId) return false;

        const follow = await askUser(manager.getCityLabel(currentCityId), manager.getCityLabel(requestedCityId));
        if (follow) {
            await manager.switchCity(requestedCityId);
            return true;
        }
        stripSharedRouteFromUrl();
        return true;
    }

    global.promptCityMismatchForProposal = promptCityMismatchForProposal;
})(window);
