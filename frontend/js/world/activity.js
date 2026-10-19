// A slowly cycling, public activity list beside the globe. Owns its fetch and timer lifecycle.
(function (global) {
    'use strict';
    function mount(root, { t, reducedMotion, coverage }) {
        const panel = document.createElement('section');
        panel.className = 'world-activity';
        const header = document.createElement('div'); header.className = 'world-activity__header';
        const title = document.createElement('h2'); title.id = 'world-activity-title';
        panel.setAttribute('aria-labelledby', title.id);
        header.append(title);
        const status = document.createElement('p'); status.className = 'world-activity__status'; status.setAttribute('role', 'status');
        const viewport = document.createElement('div'); viewport.className = 'world-activity__viewport';
        const track = document.createElement('div'); track.className = 'world-activity__track';
        viewport.append(track); panel.append(header, status, viewport); root.append(panel);
        let events = [], state = 'loading', destroyed = false, request = null, userScrolling = false;
        panel.classList.toggle('world-activity--static', !!reducedMotion);
        const horizontalMode = () => !!global.matchMedia?.('(max-width: 600px)')?.matches;
        const cyclingEnabled = () => events.length > (horizontalMode() ? 1 : 3) && !reducedMotion && !userScrolling;
        function proposalTypeLabel(event) {
            const key = global.WorldActivityModel.proposalTypeKey(event);
            if (key === 'urban-rule') return t('world.activity.zoningType', 'Zoning');
            const fallback = key === 'other' ? 'Other' : key.replace(/-/g, ' ');
            return t(`modal.roadWidth.proposalList.goalLabels.${key}`, fallback);
        }
        // A bet reads as what it was: "Bet 1.00 USDC on yes".
        function actionLabel(event) {
            if (event.type === 'stake' && event.side && event.amount !== null) {
                const amount = CbFormat.formatMoney(Number(event.amount), 'USDC');
                return t('world.activity.bet.' + event.side, event.side === 'yes' ? 'Bet {{amount}} on yes' : 'Bet {{amount}} on no', { amount });
            }
            if (event.type === 'stake') return t('panel.proposal.market.placedTitle', 'Bet placed');
            return t('world.activity.actions.' + event.type, event.type);
        }
        function enableManualScroll() {
            if (userScrolling) return;
            const style = global.getComputedStyle(track);
            const horizontal = horizontalMode();
            const matrix = new global.DOMMatrixReadOnly(style.transform === 'none' ? 'matrix(1, 0, 0, 1, 0, 0)' : style.transform);
            const translated = horizontal ? matrix.m41 : matrix.m42;
            const list = track.firstElementChild;
            const listRect = list?.getBoundingClientRect();
            const listSize = horizontal ? (list?.scrollWidth || listRect?.width || 0) : (listRect?.height || 0);
            let offset = Math.max(0, -translated);
            if (listSize) offset %= listSize;
            // Near the loop seam, rotate the real rows to keep the same visible events when the
            // duplicate disappears; otherwise native scroll clamping would jump backwards.
            const viewportSize = horizontal ? viewport.clientWidth : viewport.clientHeight;
            const seamStart = Math.max(0, listSize - viewportSize);
            while (list?.firstElementChild && offset > seamStart) {
                const first = list.firstElementChild;
                const rect = first.getBoundingClientRect();
                const itemSize = horizontal ? rect.width : rect.height;
                if (!itemSize) break;
                list.append(first);
                offset -= itemSize;
            }
            userScrolling = true;
            panel.classList.remove('world-activity--cycling');
            panel.classList.add('world-activity--manual');
            track.style.transform = 'none';
            track.querySelector('.world-activity__copy')?.remove();
            if (horizontal) viewport.scrollLeft = offset;
            else viewport.scrollTop = offset;
        }
        viewport.addEventListener('wheel', event => {
            enableManualScroll();
            event.preventDefault();
            const horizontal = horizontalMode();
            const delta = horizontal ? (event.deltaX || event.deltaY) : event.deltaY;
            const pageSize = horizontal ? viewport.clientWidth : viewport.clientHeight;
            const amount = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageSize : 1);
            if (horizontal) viewport.scrollLeft += amount;
            else viewport.scrollTop += amount;
        }, { passive: false });
        let pointerStart = null;
        viewport.addEventListener('pointerdown', event => {
            pointerStart = { x: event.clientX, y: event.clientY };
        }, { passive: true });
        viewport.addEventListener('pointermove', event => {
            if (!pointerStart || userScrolling) return;
            const dx = Math.abs(event.clientX - pointerStart.x);
            const dy = Math.abs(event.clientY - pointerStart.y);
            const horizontal = horizontalMode();
            if (horizontal ? dx > 8 && dx > dy : dy > 8 && dy > dx) {
                enableManualScroll();
                pointerStart = null;
            }
        }, { passive: true });
        for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
            viewport.addEventListener(type, () => { pointerStart = null; }, { passive: true });
        }
        viewport.addEventListener('focusin', event => {
            if (event.target.matches(':focus-visible')) enableManualScroll();
        });
        function render() {
            title.textContent = t('world.activity.title', 'Latest activity');
            status.textContent = state === 'ready' ? '' : t('world.activity.' + state, { loading: 'Loading activity…', empty: 'No recent activity yet.', error: 'Activity is temporarily unavailable.' }[state]);
            status.hidden = state === 'ready'; viewport.hidden = state !== 'ready';
            track.replaceChildren();
            for (let copy = 0; copy < (cyclingEnabled() ? 2 : 1); copy++) {
                const list = document.createElement('ul'); list.className = 'world-activity__list';
                if (copy) { list.setAttribute('aria-hidden', 'true'); list.classList.add('world-activity__copy'); }
                for (const event of events) {
                    const li = document.createElement('li');
                    const link = document.createElement('a'); link.href = global.WorldProposalEntry.href(event); link.className = 'world-activity__event';
                    link.dataset.eventType = event.type;
                    link.addEventListener('click', async click => {
                        if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
                        click.preventDefault();
                        panel.setAttribute('aria-busy', 'true');
                        try {
                            if (event.proposalAccount) await global.WorldProposalEntry.openBet(event);
                            else await global.WorldProposalEntry.open(event, { arrive: 'pick' });
                        }
                        catch (error) {
                            status.textContent = t('world.activity.openError', 'Could not open this proposal. Please try again.');
                            status.hidden = false;
                            console.warn('[world] Proposal could not open', error);
                        } finally { panel.removeAttribute('aria-busy'); }
                    });
                    if (copy) link.tabIndex = -1;
                    const action = document.createElement('span'); action.className = 'world-activity__action';
                    action.textContent = actionLabel(event);
                    const subject = document.createElement('span'); subject.className = 'world-activity__subject'; subject.textContent = event.subject;
                    const time = document.createElement('time'); time.dateTime = new Date(event.date).toISOString();
                    time.textContent = CbFormat.formatDateTime(event.date);
                    const place = global.WorldActivityModel.locationOf(event, { coverage, city: id => {
                        if (!id || id === 'explore') return null;
                        const config = global.CityConfigManager.getCityConfig(id);
                        if (!config) return null;
                        const center = global.CityConfigManager.getCityCenter(config);
                        return { name: t('city.labels.' + id, config.label).split(',')[0], lat: center[0], lon: center[1] };
                    } });
                    if (place.kind === 'country' && place.cc) {
                        place.name = new Intl.DisplayNames([global.i18n?.getLanguage?.() || 'en'], { type: 'region' }).of(place.cc) || place.name;
                    }
                    const location = document.createElement('span'); location.className = 'world-activity__location';
                    location.textContent = place.kind === 'city' ? place.name
                        : t('world.activity.location.' + place.kind, { near: 'near {{place}}', country: 'in {{place}}', unknown: 'Location unknown' }[place.kind], { place: place.name });
                    const meta = document.createElement('span'); meta.className = 'world-activity__meta'; meta.append(location, time);
                    const compact = document.createElement('span'); compact.className = 'world-activity__compact';
                    const compactCity = document.createElement('span'); compactCity.className = 'world-activity__compact-city';
                    compactCity.textContent = ['city', 'near'].includes(place.kind) ? place.name : location.textContent;
                    const compactType = document.createElement('span'); compactType.className = 'world-activity__compact-type';
                    compactType.textContent = event.type === 'stake' ? actionLabel(event) : proposalTypeLabel(event);
                    compact.append(compactCity, compactType);
                    link.append(compact, action, subject, meta); li.append(link); list.append(li);
                }
                track.append(list);
            }
            panel.classList.toggle('world-activity--cycling', cyclingEnabled());
            track.style.setProperty('--activity-duration', events.length * 8 + 's');
        }
        const mobileQuery = global.matchMedia?.('(max-width: 600px)');
        mobileQuery?.addEventListener?.('change', render);
        async function load() {
            if (request || destroyed) return;
            request = new AbortController();
            try {
                const base = String(global.getBackendBase()).replace(/\/+$/, '');
                const response = await fetch(base + '/activity/recent?limit=12', { cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
                if (!response.ok) throw new Error('Activity HTTP ' + response.status);
                const payload = await response.json();
                events = global.WorldActivityModel.prepare(payload.events);
                state = events.length ? 'ready' : 'empty';
            } catch (error) {
                if (destroyed) return;
                state = 'error';
                console.warn('[world] Activity could not load', error);
            } finally {
                request = null;
                if (!destroyed) render();
            }
        }
        const timer = global.setInterval(() => {
            if (!userScrolling && !document.hidden && !panel.matches(':hover') && !panel.contains(document.activeElement)) load();
        }, 60000);
        render(); load();
        return { render, destroy() { destroyed = true; mobileQuery?.removeEventListener?.('change', render); global.clearInterval(timer); request?.abort(); panel.remove(); } };
    }
    global.WorldActivity = { mount };
})(window);
