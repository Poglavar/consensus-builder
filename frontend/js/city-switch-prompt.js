// Asks before adopting a ?city= that disagrees with the city this browser already holds data for.
//
// Local data is not city-scoped, so switching cities wipes everything stored in this browser.
// A shared proposal link stamps the sharer's city, which means simply *opening* someone's link
// used to erase the recipient's local proposals, profile and settings without a word. city-config
// now only records the request (getPendingCitySwitch); this module resolves it once the UI exists.
//
// Three ways out:
//   - switch: wipe and load the link's city (what the old code did, but chosen deliberately)
//   - private window: keep everything, open the link where this browser has no data to lose
//   - stay: ignore the link entirely
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

    // "Stay here" must also drop the link's route, or the shared proposal would be applied to the
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

    async function copyLinkToClipboard() {
        const link = global.location.href;
        try {
            if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
                await global.navigator.clipboard.writeText(link);
                return true;
            }
        } catch (_) { /* fall through to the manual path below */ }
        return false;
    }

    function buildButton(label, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        return button;
    }

    // Resolves to 'switch' | 'private' | 'stay'.
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
                'This link is for {requested} — you are viewing {current}',
                { requested: requestedLabel, current: currentLabel }
            );

            const body = document.createElement('div');
            body.className = 'cb-confirm-message';
            body.textContent = t(
                'city.switchPrompt.body',
                'Switching cities erases everything stored in this browser: your local proposals, settings and profile. Proposals you have already uploaded are safe and will come back.'
            );

            const hint = document.createElement('div');
            hint.className = 'city-switch-hint';
            hint.textContent = t(
                'city.switchPrompt.hint',
                'To keep your current work, open the link in a private window or another browser profile. A new tab is not enough — it shares the same storage.'
            );

            const buttons = document.createElement('div');
            buttons.className = 'cb-confirm-buttons city-switch-buttons';

            const stayBtn = buildButton(
                t('city.switchPrompt.stay', 'Stay in {current}', { current: currentLabel }),
                'btn btn-secondary'
            );
            const privateBtn = buildButton(
                t('city.switchPrompt.privateWindow', 'Copy link for a private window'),
                'btn btn-secondary'
            );
            const switchBtn = buildButton(
                t('city.switchPrompt.switch', 'Switch to {requested} and clear', { requested: requestedLabel }),
                'btn btn-action'
            );

            function close(result) {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve(result);
            }

            stayBtn.addEventListener('click', () => close('stay'));
            switchBtn.addEventListener('click', () => close('switch'));
            privateBtn.addEventListener('click', async () => {
                const copied = await copyLinkToClipboard();
                privateBtn.textContent = copied
                    ? t('city.switchPrompt.privateWindowCopied', 'Link copied — paste it into a private window')
                    : t('city.switchPrompt.privateWindowManual', 'Copy this page\'s address into a private window');
                privateBtn.disabled = true;
                // Deliberately not closing: the user still has to choose what this window does.
            });
            // No dismiss-on-backdrop: every outcome here is consequential, so make them pick one.

            buttons.appendChild(stayBtn);
            buttons.appendChild(privateBtn);
            buttons.appendChild(switchBtn);
            dialog.appendChild(heading);
            dialog.appendChild(body);
            dialog.appendChild(hint);
            dialog.appendChild(buttons);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            switchBtn.focus();
        });
    }

    async function resolvePendingCitySwitch() {
        const manager = global.CityConfigManager;
        if (!manager || typeof manager.getPendingCitySwitch !== 'function') return;
        const pending = manager.getPendingCitySwitch();
        if (!pending) return;

        const currentLabel = manager.getCityLabel(pending.currentCityId);
        const requestedLabel = manager.getCityLabel(pending.requestedCityId);
        const choice = await askUser(currentLabel, requestedLabel);

        if (choice === 'switch') {
            // switchCity wipes, then navigates with ?city=<requested>. On the next boot the stored
            // city is gone, so determineCurrentCityId adopts the query city without a second wipe
            // and the shared-proposal route runs normally.
            manager.clearPendingCitySwitch();
            await manager.switchCity(pending.requestedCityId);
            return;
        }

        // 'stay' (and the private-window path, which leaves this window as it was): keep the
        // current city and drop the link's route so nothing loads into the wrong map.
        manager.clearPendingCitySwitch();
        stripSharedRouteFromUrl();
    }

    // Same dialog, driven by a proposal's own `city` rather than a ?city= param. Covers links that
    // never carried the param (older shares, or one stripped in transit). Resolves to true when the
    // caller must abort — either the page is reloading into the other city, or the user stayed put.
    async function promptCityMismatchForProposal(requestedCityId) {
        const manager = global.CityConfigManager;
        if (!manager || !requestedCityId) return false;
        const currentCityId = manager.getCurrentCityId();
        if (requestedCityId === currentCityId) return false;

        const choice = await askUser(manager.getCityLabel(currentCityId), manager.getCityLabel(requestedCityId));
        if (choice === 'switch') {
            await manager.switchCity(requestedCityId);
            return true;
        }
        stripSharedRouteFromUrl();
        return true;
    }

    global.promptCityMismatchForProposal = promptCityMismatchForProposal;

    global.hasPendingCitySwitch = function hasPendingCitySwitch() {
        const manager = global.CityConfigManager;
        return !!(manager && typeof manager.getPendingCitySwitch === 'function' && manager.getPendingCitySwitch());
    };
    global.resolvePendingCitySwitch = resolvePendingCitySwitch;

    global.addEventListener('load', () => {
        // After the app's own load handlers have had a tick, so the map is behind the dialog.
        setTimeout(() => { resolvePendingCitySwitch(); }, 50);
    });
})(window);
