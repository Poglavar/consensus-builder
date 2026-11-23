(function (win) {
    'use strict';
    const doc = win.document;
    const t = (key, values) => win.i18n.t(`dogCritic.${key}`, values);
    const categories = win.DogWalkability.CATEGORIES;

    function element(tag, label) {
        const node = doc.createElement(tag);
        if (label != null) node.textContent = label;
        return node;
    }

    function shell(plan) {
        const panel = element('section');
        panel.className = 'active-travel-panel right-screen-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-labelledby', 'dog-critic-title');
        panel.innerHTML = `
            <header class="panel-header active-travel-header">
                <img src="/images/critic-dog.webp" alt="" width="48" height="48">
                <div><h2 id="dog-critic-title" data-dog="title"></h2><p data-dog="plan"></p></div>
                <button type="button" class="close-circle-btn" data-dog="close">×</button>
            </header>
            <div class="panel-body active-travel-body">
                <p role="status" data-dog="status"></p>
                <div class="active-travel-grid" data-dog="results" hidden>
                    <output data-dog="score" class="active-travel-score"></output>
                    <p data-dog="connected"></p>
                    <table class="active-travel-table">
                        <thead><tr><th scope="col" data-dog="destination"></th><th scope="col" data-dog="five"></th><th scope="col" data-dog="ten"></th></tr></thead>
                        <tbody data-dog="counts"></tbody>
                    </table>
                    <p data-dog="coverage" class="sheet-note"></p>
                    <details class="active-travel-detail" data-dog="trips">
                        <summary data-dog="inspect"></summary>
                        <label><span data-dog="search"></span><input type="search" data-dog="filter"></label>
                        <div class="active-travel-field"><label for="dog-critic-home" data-dog="building"></label><select id="dog-critic-home" data-dog="home"></select></div>
                        <div class="active-travel-field"><label for="dog-critic-category" data-dog="destination"></label><select id="dog-critic-category" data-dog="category"></select></div>
                        <p role="status" data-dog="trip"></p>
                        <button type="button" class="btn btn-sm" data-dog="show"></button>
                    </details>
                    <details class="active-travel-detail">
                        <summary data-dog="gaps"></summary>
                        <p data-dog="gapText"></p>
                        <p data-dog="unlinked"></p>
                        <ul data-dog="unlinkedList"></ul>
                    </details>
                    <details class="active-travel-detail">
                        <summary data-dog="method"></summary>
                        <p data-dog="methodText"></p>
                    </details>
                </div>
            </div>`;
        for (const key of ['title', 'destination', 'five', 'ten', 'inspect', 'search', 'building', 'show', 'gaps', 'method', 'methodText']) {
            for (const node of panel.querySelectorAll(`[data-dog="${key}"]`)) node.textContent = t(key);
        }
        const ui = Object.fromEntries([...panel.querySelectorAll('[data-dog]')].map(node => [node.dataset.dog, node]));
        ui.plan.textContent = plan.content.title;
        ui.status.textContent = t('loading');
        ui.close.setAttribute('aria-label', t('close'));
        doc.body.append(panel);
        return { panel, ui };
    }

    function render(current, assessment, frame) {
        const { ui } = current;
        const integer = value => new Intl.NumberFormat(win.i18n.language || undefined).format(value);
        const latLng = ([lng, lat]) => [lat, lng];
        const line = (coords, options) => win.L.polyline(coords.map(latLng), { interactive: false, ...options });
        const total = assessment.homes.length;
        const unlinked = assessment.destinations.filter(row => !row.connected);
        const absent = categories.filter(category => !assessment.categories[category].destinations);
        ui.connected.textContent = t('connected', { count: integer(assessment.connectedHomes), total: integer(total) });
        ui.score.textContent = assessment.score == null ? t('noScore') : t('score', { score: integer(assessment.score) });
        ui.coverage.textContent = [
            ...absent.map(category => t('missing', { category: t(category) })),
            ...(assessment.unstatedUse ? [t('unknownUse', { count: integer(assessment.unstatedUse) })] : [])
        ].join(' ');
        for (const category of categories) {
            const counts = assessment.categories[category];
            const row = element('tr'), title = element('th', t(category));
            title.scope = 'row';
            row.append(title);
            for (const count of [counts.within5, counts.within10]) {
                row.append(element('td', counts.destinations && total ? t('fraction', { count: integer(count), total: integer(total) }) : '—'));
            }
            ui.counts.append(row);
            const option = element('option', t(category));
            option.value = category;
            option.disabled = !counts.destinations;
            ui.category.append(option);
        }
        ui.category.value = categories.find(cat => assessment.categories[cat].destinations) || '';
        ui.category.disabled = !ui.category.value;
        ui.gapText.textContent = t('gapText', {
            paths: integer(assessment.gaps.filter(gap => gap.kind === 'no-sidewalk').length),
            crossings: integer(assessment.gaps.filter(gap => gap.kind === 'crossing-gap').length)
        });
        ui.unlinked.textContent = t('unlinked', { count: integer(unlinked.length) });
        current.network = win.L.featureGroup().addTo(win.map);
        current.route = win.L.featureGroup().addTo(win.map);
        for (const path of assessment.paths) line(path, { color: '#137a64', weight: 3, opacity: 0.85 }).addTo(current.network);
        for (const gap of assessment.gaps) line(gap.points, { color: '#b55618', weight: 4, dashArray: '4 6' }).addTo(current.network);
        for (const row of unlinked) {
            const item = element('li');
            ui.unlinkedList.append(item);
            if (!row.coordinate) { item.textContent = row.title; continue; }
            const marker = win.L.circleMarker(latLng(row.coordinate), { interactive: false, color: '#b55618',
                weight: 2, fillColor: '#fff', fillOpacity: 1, radius: 5 }).addTo(current.network);
            const locate = element('button', row.title);
            locate.type = 'button';
            locate.className = 'btn btn-sm';
            locate.addEventListener('click', () => {
                current.route.clearLayers();
                win.L.circleMarker(marker.getLatLng(), { interactive: false, color: '#6b39b1', fill: false,
                    weight: 3, radius: 8 }).addTo(current.route);
                frame(current.route.getBounds());
            });
            item.append(locate);
        }
        for (const home of assessment.homes) if (home.coordinate) {
            const color = home.connected ? '#195c96' : '#b55618';
            win.L.circleMarker(latLng(home.coordinate), { interactive: false, color, fillColor: color, fillOpacity: 0.85,
                weight: 1, radius: home.connected ? 3 : 5 }).addTo(current.network);
        }
        const homes = new Map(assessment.homes.map(home => [home.id, home]));
        const updateTrip = () => {
            current.route.clearLayers();
            const home = homes.get(ui.home.value), category = ui.category.value;
            const trip = home?.routes[category];
            if (ui.trips.open && home?.coordinate) win.L.circleMarker(latLng(home.coordinate), { interactive: false, color: '#6b39b1',
                fillColor: '#fff', fillOpacity: 1, weight: 3, radius: 6 }).addTo(current.route);
            if (trip) {
                const coords = assessment.route(home.id, category);
                if (ui.trips.open) line(coords, { color: '#6b39b1', weight: 5 }).addTo(current.route);
                const minutes = Math.ceil(trip.seconds / 60);
                ui.trip.textContent = trip.id === home.id ? t('atBuilding', { title: trip.title })
                    : t('trip', { minutes: integer(minutes), title: trip.title });
            } else ui.trip.textContent = !home ? t('noHome') : !home.connected ? t('noAccess')
                : !category ? t('noDestination') : t('noRoute');
            ui.show.disabled = !home?.coordinate;
        };
        function filterHomes() {
            const selected = ui.home.value;
            const query = ui.filter.value.trim().toLocaleLowerCase();
            const options = [...homes.values()].filter(home => (home.title || '').toLocaleLowerCase().includes(query))
                .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
            ui.home.replaceChildren(...options.map(home => {
                const node = element('option', home.title);
                node.value = home.id;
                return node;
            }));
            if (options.some(home => home.id === selected)) ui.home.value = selected;
            ui.home.disabled = !options.length;
            updateTrip();
        }
        ui.filter.addEventListener('input', filterHomes);
        ui.trips.addEventListener('toggle', updateTrip);
        ui.home.addEventListener('change', updateTrip);
        ui.category.addEventListener('change', updateTrip);
        ui.show.addEventListener('click', () => frame(current.route.getBounds()));
        ui.trips.hidden = !total;
        ui.status.hidden = true;
        ui.results.hidden = false;
        filterHomes();
        // The tour already framed the context once. Keep the results view stable; the explicit
        // “show route” action below remains the deliberate close-up affordance.
        if (!current.contextShown) frame(current.network.getBounds(), true);
    }

    win.DogCritic = win.ActiveTravelPanel.create({ id: 'dog', shell, evaluate: win.DogWalkability.evaluate, render, t });
})(window);
