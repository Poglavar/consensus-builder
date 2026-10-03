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
        function enableManualScroll() {
            if (userScrolling) return;
            const style = global.getComputedStyle(track);
            const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? 'matrix(1, 0, 0, 1, 0, 0)' : style.transform);
            const listHeight = track.firstElementChild?.getBoundingClientRect().height || 0;
            let offset = Math.max(0, -matrix.m42);
            if (listHeight) offset %= listHeight;
            // Near the loop seam, rotate the real rows to keep the same visible events when the
            // duplicate disappears; otherwise native scroll clamping would jump backwards.
            const list = track.firstElementChild;
            const rowHeight = list?.firstElementChild?.getBoundingClientRect().height || 0;
            if (rowHeight && offset > Math.max(0, listHeight - viewport.clientHeight)) {
                const rows = Math.floor(offset / rowHeight);
                for (let i = 0; i < rows; i++) list.append(list.firstElementChild);
                offset -= rows * rowHeight;
            }
            userScrolling = true;
            track.style.transform = 'none';
            track.querySelector('.world-activity__copy')?.remove();
            panel.classList.remove('world-activity--cycling');
            panel.classList.add('world-activity--manual');
            viewport.scrollTop = offset;
        }
        viewport.addEventListener('wheel', event => {
            enableManualScroll();
            event.preventDefault();
            viewport.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
        }, { passive: false });
        viewport.addEventListener('touchmove', enableManualScroll, { passive: true });
        viewport.addEventListener('pointerdown', event => { if (event.target === viewport) enableManualScroll(); }, { passive: true });
        viewport.addEventListener('focusin', event => {
            if (event.target.matches(':focus-visible')) enableManualScroll();
        });
        function render() {
            title.textContent = t('world.activity.title', 'Latest activity');
            status.textContent = state === 'ready' ? '' : t('world.activity.' + state, { loading: 'Loading activity…', empty: 'No recent activity yet.', error: 'Activity is temporarily unavailable.' }[state]);
            status.hidden = state === 'ready'; viewport.hidden = state !== 'ready';
            track.replaceChildren();
            for (let copy = 0; copy < (events.length > 3 && !reducedMotion && !userScrolling ? 2 : 1); copy++) {
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
                        try { await global.WorldProposalEntry.open(event); }
                        catch (error) {
                            status.textContent = t('world.activity.openError', 'Could not open this proposal. Please try again.');
                            status.hidden = false;
                            console.warn('[world] Proposal could not open', error);
                        } finally { panel.removeAttribute('aria-busy'); }
                    });
                    if (copy) link.tabIndex = -1;
                    const action = document.createElement('span'); action.className = 'world-activity__action';
                    action.textContent = t('world.activity.actions.' + event.type, event.type);
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
                    link.append(action, subject, meta); li.append(link); list.append(li);
                }
                track.append(list);
            }
            panel.classList.toggle('world-activity--cycling', events.length > 3 && !reducedMotion && !userScrolling);
            track.style.setProperty('--activity-duration', events.length * 8 + 's');
        }
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
        return { render, destroy() { destroyed = true; global.clearInterval(timer); request?.abort(); panel.remove(); } };
    }
    global.WorldActivity = { mount };
})(window);
