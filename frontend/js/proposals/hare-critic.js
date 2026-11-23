(function (win) {
    'use strict';
    const doc = win.document;
    const { CATEGORIES, TIERS, evaluate } = win.HareCycling;
    const common = new Set(['destination', 'building', 'search', 'show', 'fraction', 'green', 'shops', 'transit',
        'missing', 'unknownUse', 'gaps', 'trip', 'atBuilding', 'noDestination', 'mapUnavailable']);
    const t = (key, values) => win.i18n.t(common.has(key) ? `dogCritic.${key}` : `hareCritic.${key}`, values);
    const COLORS = { protected: '#147258', painted: '#0866a2', slow: '#957719', fast: '#b75325', prohibited: '#ad3039', unknown: '#687382' };

    function element(tag, text) {
        const node = doc.createElement(tag);
        if (text != null) node.textContent = text;
        return node;
    }

    function shell(plan) {
        const panel = element('section');
        panel.className = 'active-travel-panel right-screen-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-labelledby', 'hare-critic-title');
        panel.innerHTML = `
            <header class="panel-header active-travel-header">
                <img src="/images/critic-hare.webp" alt="" width="48" height="48">
                <div><h2 id="hare-critic-title" data-hare="title"></h2><p data-hare="plan"></p></div>
                <button type="button" class="close-circle-btn" data-hare="close">×</button>
            </header>
            <div class="panel-body active-travel-body">
                <p role="status" data-hare="status"></p>
                <div class="active-travel-grid" data-hare="results" hidden>
                    <output class="active-travel-score" data-hare="score"></output>
                    <p class="sheet-note" data-hare="coverage"></p>
                    <table class="active-travel-table">
                        <thead><tr><th scope="col" data-hare="destination"></th><th scope="col" data-hare="reachable"></th><th scope="col" data-hare="homes"></th></tr></thead>
                        <tbody data-hare="counts"></tbody>
                    </table>
                    <p data-hare="connected"></p>
                    <p data-hare="coverageNotes" class="sheet-note" hidden></p>
                    <details class="active-travel-detail" data-hare="trips">
                        <summary data-hare="inspect"></summary>
                        <label><span data-hare="search"></span><input type="search" data-hare="filter"></label>
                        <div class="active-travel-field"><label for="hare-home" data-hare="building"></label><select id="hare-home" data-hare="home"></select></div>
                        <div class="active-travel-field"><label for="hare-category" data-hare="categoryLabel"></label><select id="hare-category" data-hare="category"></select></div>
                        <div class="active-travel-field"><label for="hare-target" data-hare="destination"></label><select id="hare-target" data-hare="target"></select></div>
                        <p role="status" data-hare="trip"></p>
                        <button type="button" class="btn btn-sm" data-hare="show"></button>
                    </details>
                    <details class="active-travel-detail">
                        <summary data-hare="quality"></summary>
                        <dl class="hare-quality" data-hare="tiers"></dl>
                    </details>
                    <details class="active-travel-detail">
                        <summary data-hare="gaps"></summary>
                        <p data-hare="crossingGaps"></p>
                        <p data-hare="unlinked"></p>
                        <ul data-hare="unlinkedList"></ul>
                    </details>
                    <details class="active-travel-detail">
                        <summary data-hare="method"></summary>
                        <p data-hare="methodText"></p>
                    </details>
                </div>
            </div>`;
        for (const key of ['title', 'destination', 'reachable', 'homes', 'inspect', 'search', 'building', 'categoryLabel',
            'show', 'quality', 'gaps', 'method', 'methodText']) {
            for (const node of panel.querySelectorAll(`[data-hare="${key}"]`)) node.textContent = t(key);
        }
        const ui = Object.fromEntries([...panel.querySelectorAll('[data-hare]')].map(node => [node.dataset.hare, node]));
        ui.plan.textContent = plan.content.title;
        ui.status.textContent = t('loading');
        ui.close.setAttribute('aria-label', t('close'));
        doc.body.append(panel);
        return { panel, ui };
    }

    function render(current, data, frame) {
        const { ui } = current;
        const number = new Intl.NumberFormat(win.i18n.language || undefined);
        const integer = value => number.format(Math.round(value));
        const metres = value => t('metres', { value: integer(value) });
        const fraction = (count, total) => total ? t('fraction', { count: integer(count), total: integer(total) }) : '—';
        const latLng = ([lng, lat]) => [lat, lng];
        function line(layer, coords, options) {
            return win.L.polyline(coords.map(latLng), { interactive: false, ...options }).addTo(layer);
        }
        function dot(layer, coordinate, color, radius = 5) {
            return win.L.circleMarker(latLng(coordinate), { interactive: false, color, fillColor: '#fff', fillOpacity: 1,
                weight: 2, radius }).addTo(layer);
        }
        function option(text, value) {
            const result = element('option', text);
            result.value = value;
            return result;
        }
        const total = data.homes.length, length = data.scoredM + data.lengths.unknown;
        ui.score.textContent = data.score == null ? t('noScore') : t('score', { score: integer(data.score) });
        ui.coverage.textContent = length ? t('coverage', { score: integer(100 * data.scoredM / length), length: metres(length) }) : t('noNetwork');
        ui.connected.textContent = total ? t('connected', { count: integer(data.connectedHomes), total: integer(total) }) : t('noHome');
        const notes = [...CATEGORIES.filter(category => !data.categories[category].destinations).map(category => t('missing', { category: t(category) })),
            ...(data.unstatedUse ? [t('unknownUse', { count: integer(data.unstatedUse) })] : [])];
        ui.coverageNotes.textContent = notes.join(' ');
        ui.coverageNotes.hidden = !notes.length;
        for (const category of CATEGORIES) {
            const { destinations, reachableDestinations, reachableHomes } = data.categories[category];
            const row = element('tr'), heading = element('th', t(category));
            heading.scope = 'row';
            row.append(heading, element('td', total ? fraction(reachableDestinations, destinations) : '—'),
                element('td', reachableHomes == null ? '—' : fraction(reachableHomes, total)));
            ui.counts.append(row);
            const choice = option(t(category), category);
            choice.disabled = !destinations;
            ui.category.append(choice);
        }
        ui.category.value = CATEGORIES.find(category => data.categories[category].destinations) || '';
        ui.category.disabled = !ui.category.value;
        for (const type of TIERS) {
            const name = element('dt'), swatch = element('span');
            swatch.className = 'hare-tier';
            swatch.style.background = COLORS[type];
            swatch.setAttribute('aria-hidden', 'true');
            name.append(swatch, t(type));
            ui.tiers.append(name, element('dd', metres(data.lengths[type])));
        }
        current.network = win.L.featureGroup().addTo(win.map);
        current.route = win.L.featureGroup().addTo(win.map);
        for (const segment of data.segments) {
            const type = ['prohibited', 'unknown', 'fast', 'slow', 'painted', 'protected'].find(tier => segment.tiers.includes(tier));
            line(current.network, segment.points, { color: COLORS[type], weight: 4, opacity: 0.9,
                dashArray: type === 'unknown' ? '4 5' : null });
        }
        for (const gap of data.gaps) line(current.network, gap.points, { color: '#b82479', weight: 5, dashArray: '5 5' });
        ui.crossingGaps.textContent = t('gapText', {
            crossings: integer(data.gaps.filter(gap => gap.kind === 'crossing-gap').length),
            ends: integer(data.gaps.filter(gap => gap.kind === 'unlinked-end').length)
        });
        const unreachable = data.destinations.filter(place => total ? !place.reachable : !place.connected);
        ui.unlinked.textContent = t(total ? 'unlinked' : 'unattached', { count: integer(unreachable.length) });
        for (const place of unreachable) {
            const item = element('li');
            ui.unlinkedList.append(item);
            if (!place.coordinate) { item.textContent = place.title; continue; }
            dot(current.network, place.coordinate, COLORS.prohibited);
            const locate = element('button', place.title);
            locate.type = 'button';
            locate.className = 'btn btn-sm';
            locate.addEventListener('click', () => {
                current.route.clearLayers();
                dot(current.route, place.coordinate, '#6334b8', 9);
                frame(current.route.getBounds());
            });
            item.append(locate);
        }
        for (const home of data.homes) if (home.coordinate) dot(current.network, home.coordinate, home.connected ? '#265d8a' : COLORS.prohibited, home.connected ? 2 : 4);
        const homes = new Map(data.homes.map(home => [home.id, home]));
        function updateTrip() {
            current.route.clearLayers();
            const home = homes.get(ui.home.value);
            const category = ui.category.value;
            const selected = home && category ? data.selectTrip(home.id, category, ui.target.value || undefined) : {};
            const { trip, coordinates } = selected;
            if (ui.trips.open && home?.coordinate) dot(current.route, home.coordinate, '#6334b8', 7);
            if (trip) {
                if (ui.trips.open) line(current.route, coordinates, { color: '#6334b8', weight: 6 });
                ui.trip.textContent = trip.id === home.id ? t('atBuilding', { title: trip.title })
                    : t('trip', { minutes: integer(Math.ceil(trip.seconds / 60)), title: trip.title });
            } else ui.trip.textContent = !home ? t('noMatch') : !home.connected ? t('noAccess')
                : !category ? t('noDestination') : t('noRoute');
            ui.show.disabled = !home?.coordinate;
        }
        function chooseCategory() {
            const targets = data.destinations.filter(place => place.category === ui.category.value)
                .sort((a, b) => a.title.localeCompare(b.title));
            ui.target.replaceChildren(option(t('nearest'), ''), ...targets.map(place => option(place.title, place.id)));
            ui.target.disabled = !targets.length;
            updateTrip();
        }
        function findHomes() {
            const selected = ui.home.value, query = ui.filter.value.trim().toLocaleLowerCase();
            const options = [...homes.values()].filter(home => home.title.toLocaleLowerCase().includes(query))
                .sort((a, b) => a.title.localeCompare(b.title));
            ui.home.replaceChildren(...options.map(home => option(home.title, home.id)));
            if (options.some(home => home.id === selected)) ui.home.value = selected;
            ui.home.disabled = !options.length;
            updateTrip();
        }
        ui.filter.addEventListener('input', findHomes);
        ui.home.addEventListener('change', updateTrip);
        ui.category.addEventListener('change', chooseCategory);
        ui.target.addEventListener('change', updateTrip);
        ui.trips.addEventListener('toggle', updateTrip);
        ui.show.addEventListener('click', () => frame(current.route.getBounds()));
        ui.trips.hidden = !total;
        ui.status.hidden = true;
        ui.results.hidden = false;
        chooseCategory();
        findHomes();
        // Preserve the tour's contextual frame; only the explicit route action reframes.
        if (!current.contextShown) frame(current.network.getBounds(), true);
    }

    win.HareCritic = win.ActiveTravelPanel.create({ id: 'hare', shell, evaluate, render, t });
})(window);
