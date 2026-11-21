(function (win) {
    'use strict';
    const doc = win.document;
    const portrait = '/images/critic-cat.webp';
    const t = (name, values) => win.i18n.t(`squareCritic.${name}`, values);
    let ui, session;

    function node(tag, className, text) {
        const el = doc.createElement(tag);
        if (className) el.className = className;
        if (text != null) el.textContent = text;
        return el;
    }

    function ensurePanel() {
        if (ui) return ui;
        const panel = node('section', 'square-critic-panel right-screen-panel');
        panel.id = 'square-critic-panel';
        panel.hidden = true;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-labelledby', 'square-critic-title');
        panel.innerHTML = `
            <header class="panel-header square-critic-header">
                <img src="${portrait}" alt="" width="48" height="48">
                <div><h2 id="square-critic-title" data-cat="title"></h2><p data-cat="plan"></p></div>
                <button type="button" class="close-circle-btn" data-cat="close">×</button>
            </header>
            <div class="panel-body square-critic-body">
                <div class="square-critic-field" data-cat="field">
                    <label for="square-critic-square" data-cat="choose"></label>
                    <select id="square-critic-square" data-cat="square"></select>
                </div>
                <p role="status" data-cat="status"></p>
                <button type="button" class="btn btn-sm critic-tour-skip" data-cat="skip" hidden></button>
                <div class="square-critic-results" data-cat="results" hidden>
                    <div class="square-critic-score" data-cat="scoreCard" hidden>
                        <strong data-cat="score"></strong><span data-cat="verdict"></span>
                    </div>
                    <p class="square-critic-total" data-cat="total"></p>
                    <p class="square-critic-access" data-cat="access"></p>
                    <div class="square-critic-legend" data-cat="legend">
                        <span class="square-critic-wall" data-cat="wall"></span>
                        <span class="square-critic-gap" data-cat="gap"></span>
                    </div>
                    <div class="square-critic-sides" role="group" data-cat="sides"></div>
                    <details><summary data-cat="method"></summary><p data-cat="methodBody"></p></details>
                </div>
            </div>`;
        doc.body.append(panel);
        const refs = Object.fromEntries([...panel.querySelectorAll('[data-cat]')].map(el => [el.dataset.cat, el]));
        ui = { panel, ...refs };
        ui.close.addEventListener('click', () => close());
        ui.skip.addEventListener('click', () => {
            if (!session) return;
            win.cancelAnimationFrame(session.walk);
            highlight(session, -1);
            ui.close.focus();
            revealScore();
        });
        ui.square.addEventListener('change', () => inspect(session, Number(ui.square.value)));
        return ui;
    }

    function translate() {
        for (const key of ['title', 'choose', 'access', 'wall', 'method', 'methodBody']) ui[key].textContent = t(key);
        ui.close.setAttribute('aria-label', t('close'));
        ui.skip.textContent = win.CriticTour.t('skip');
        ui.sides.setAttribute('aria-label', t('sides'));
    }

    function status(text, quiet = false) {
        ui.status.classList.toggle('sr-only', quiet);
        ui.status.textContent = text;
    }

    function clearMap(current) {
        win.cancelAnimationFrame(current.walk);
        ui.skip.hidden = true;
        current.layer?.remove();
        current.layer = null;
    }

    function close(restore = true) {
        const current = session;
        if (!current) return;
        session = null;
        clearMap(current);
        current.unregister?.();
        ui.panel.hidden = true;
        if (!restore) return;
        if (current.frame) win.map.setView(current.view.center, current.view.zoom, { animate: false });
        void win.PlanAnalysisControls.restoreCriticOrigin(win, doc, current, 'cat')
            .catch(error => win.showStyledAlert(error.message));
    }

    function plannedBuildings(records) {
        const y = win.__planYield;
        return records.flatMap(record => y.buildingFeaturesOf(record).map(feature => ({
            geometry: feature.geometry,
            heightM: y.measureBuilding(feature, record.buildingProposal).heightM
        })));
    }

    async function existingBuildings(area, records) {
        const [lon, lat] = win.turf.center(area).geometry.coordinates;
        const configured = win.CityConfigManager.getBuildingSources(lat, lon);
        if (!win.SourceList.inUse(configured).length) throw new Error('No building source is in use.');
        const stock = (await win.DemolitionIndex.stockUnder([area])).map((feature, index) => ({ ...feature, key: String(index) }));
        const takers = win.__demolitionPrefetch.collectDemolitionRegions(records).map(region => ({
            proposalId: region.key, region: region.geometry
        })).concat(win.DemolitionIndex.takersOf(records, { appliedOnly: false }).filter(taker =>
            records.some(record => record.roadProposal && record.proposalId === taker.proposalId)));
        const { records: removed, failures } = win.DemolitionDerive.derive({ takers, buildings: stock }, win.turf);
        if (failures.length) throw failures[0].error;
        return stock.flatMap(feature => {
            const cut = removed.get(feature.key);
            if (cut && !cut.remainder) return [];
            const heightM = win.__planYield.measureBuilding({ ...feature,
                properties: { height: feature.properties.height_m, floors: feature.properties.floors } }).heightM;
            return [{ geometry: cut?.remainder || feature.geometry, heightM, existing: true }];
        });
    }

    const latLng = ([lon, lat]) => [lat, lon];

    function draw(current, square, result, complete) {
        const L = win.L;
        const map = win.map;
        const pane = win.CriticTour.pane();
        current.layer = L.layerGroup().addTo(map);
        for (const building of result.nearby) {
            L.geoJSON(building.geometry, { interactive: false, style: {
                className: building.existing ? 'square-critic-existing' : 'square-critic-proposed', weight: 1
            } }).addTo(current.layer);
        }
        const footprint = L.geoJSON(square.geometry, { interactive: false,
            style: { className: 'square-critic-ground', stroke: false } }).addTo(current.layer);
        current.lines = result.sides.map(side => side.segments.map(segment => L.polyline(segment.coordinates.map(latLng), {
            weight: 4, interactive: false, pane, className: segment.wall ? 'square-critic-edge-wall'
                : complete ? 'square-critic-edge-gap' : 'square-critic-edge-unknown'
        }).addTo(current.layer)));
        const first = result.sides[0].segments[0].coordinates[0];
        const face = node('img');
        face.src = portrait;
        face.alt = '';
        current.marker = L.marker(latLng(first), { interactive: false, keyboard: false, pane, alt: '',
            icon: L.divIcon({ html: face, className: 'square-critic-marker', iconSize: [32, 32] }) }).addTo(current.layer);
        const small = win.matchMedia('(max-width: 767px)').matches;
        const mapBox = map.getContainer().getBoundingClientRect();
        const panelBox = ui.panel.getBoundingClientRect();
        map.fitBounds(footprint.getBounds(), {
            maxZoom: 20, animate: false, paddingTopLeft: [38, 80],
            paddingBottomRight: small ? [38, mapBox.bottom - panelBox.top + 24] : [mapBox.right - panelBox.left + 24, 70]
        });
        current.frame = true;
    }

    function highlight(current, i) {
        current.lines.forEach((lines, index) => lines.forEach(line => line.setStyle({ weight: index === i ? 7 : 4 })));
    }

    function placeMarker(current, side, fraction) {
        const [a, b] = [side.segments[0].coordinates[0], side.segments.at(-1).coordinates[1]];
        current.marker.setLatLng(latLng(a.map((value, i) => value + (b[i] - value) * fraction)));
    }

    function walk(current, result) {
        if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) return revealScore();
        ui.skip.hidden = false;
        let start, previousSide;
        function step(time) {
            start ??= time;
            const fraction = Math.min((time - start) / 1800, 1);
            let distance = fraction * result.perimeterM;
            for (const [i, side] of result.sides.entries()) {
                if (distance <= side.lengthM || i === result.sides.length - 1) {
                    if (previousSide !== i) {
                        highlight(current, i);
                        status(win.CriticTour.t('cat', { number: i + 1 }));
                    }
                    previousSide = i;
                    placeMarker(current, side, Math.min(1, distance / side.lengthM));
                    break;
                }
                distance -= side.lengthM;
            }
            if (fraction < 1) current.walk = win.requestAnimationFrame(step);
            else { highlight(current, -1); revealScore(); }
        }
        current.walk = win.requestAnimationFrame(step);
    }

    function revealScore() {
        ui.skip.hidden = true;
        ui.scoreCard.hidden = false;
        const partial = ui.legend.hasAttribute('data-partial');
        status(partial ? t('partial') : `${ui.score.textContent} · ${ui.verdict.textContent}`, !partial);
    }

    function showResult(current, result, complete) {
        const format = (value, digits = 0) => new Intl.NumberFormat(win.i18n.getLocale?.(), { maximumFractionDigits: digits }).format(value);
        const share = value => format(complete ? value * 100 : Math.floor(value * 1000) / 10, 1);
        const wall = share(result.wallM / result.perimeterM);
        ui.total.textContent = t(complete ? 'total' : 'lowerBound', { wall });
        const score = win.SquareEnclosure.score(result, complete);
        ui.scoreCard.hidden = true;
        ui.score.textContent = t('score', { score: format(score.value) });
        ui.verdict.textContent = t(score.verdict);
        ui.gap.textContent = t(complete ? 'gap' : 'unknown');
        ui.legend.toggleAttribute('data-partial', !complete);
        status(complete ? ui.total.textContent : t('partial'), complete);
        ui.sides.replaceChildren(...result.sides.map((side, index) => {
            const row = node('button', 'btn square-critic-side');
            row.type = 'button';
            row.setAttribute('aria-pressed', 'false');
            const wall = share(side.wallM / side.lengthM);
            const coverage = t(complete ? 'sideWall' : 'sideMinimum', { wall });
            const details = [coverage];
            if (complete && side.longestGapM > 0) details.push(t('gapLength', { length: format(side.longestGapM, 1) }));
            if (side.heightToWidth !== null) details.push(t('ratio', { ratio: format(side.heightToWidth, 2), measured: share(side.heightCoverage) }));
            else if (side.wallM > 0) details.push(t('heightUnknown'));
            row.append(node('strong', '', t('side', { number: format(index + 1) })), node('span', '', details.join(' · ')));
            row.addEventListener('click', () => {
                win.cancelAnimationFrame(current.walk);
                for (const other of ui.sides.children) other.setAttribute('aria-pressed', String(other === row));
                highlight(current, index);
                placeMarker(current, side, 0.5);
                revealScore();
            });
            return row;
        }));
        ui.results.hidden = false;
    }

    async function inspect(current, index) {
        if (!current || session !== current) return;
        const square = current.squares[index];
        const request = ++current.request;
        clearMap(current);
        ui.results.hidden = true;
        status(t('loadingSquare'));
        ui.results.setAttribute('aria-busy', 'true');
        try {
            const area = win.SquareEnclosure.searchArea(square.geometry);
            let existing = [], complete = true;
            try {
                existing = await existingBuildings(area, current.records);
            } catch (error) {
                complete = false;
                console.warn('[square-critic] Surrounding building data unavailable', error);
            }
            if (session !== current || request !== current.request) return;
            const result = win.SquareEnclosure.measure(square.geometry, [...current.buildings, ...existing]);
            if (!result.sides.length) {
                status(t('unusable'));
                return;
            }
            showResult(current, result, complete);
            draw(current, square, result, complete);
            walk(current, result);
        } catch (error) {
            if (session === current && request === current.request) {
                clearMap(current);
                ui.results.hidden = true;
                status(t('failed', { reason: error.message }));
            }
        } finally {
            if (session === current && request === current.request) ui.results.removeAttribute('aria-busy');
        }
    }

    async function open(plan, row, returnTo = null) {
        close(false);
        ensurePanel();
        translate();
        const current = { plan, row, returnTo, request: 0, mode: win.__mapModeState?.desired || '2d',
            view: { center: win.map.getCenter(), zoom: win.map.getZoom() } };
        session = current;
        ui.plan.textContent = plan.content.title;
        status(t('loadingPlan'));
        ui.field.hidden = ui.results.hidden = true;
        ui.results.removeAttribute('aria-busy');
        ui.panel.hidden = false;
        current.unregister = win.ModalEscape.register(ui.panel, () => close());
        win.MapShell.closeSheets();
        win.ClickStack?.close();
        win.clearProposalPreview?.();
        ui.close.focus();
        try {
            const snapshot = await win.PlanWorkspace.resolve(plan);
            if (session !== current) return;
            current.records = win.PlanComposition.localRecords(snapshot, { apiBase: win.DesignSync.apiBase() });
            current.squares = current.records.filter(record => record.structureProposal?.kind === 'square')
                .map(record => ({ title: record.title, geometry: record.structureProposal.geometry }));
            if (!current.squares.length) {
                status(t('empty'));
                return;
            }
            current.buildings = plannedBuildings(current.records);
            if (current.mode !== '2d' && !await win.requestMapMode('2d')) throw new Error(t('mapUnavailable'));
            if (session !== current) return;
            ui.square.replaceChildren(...current.squares.map((square, index) => {
                const option = node('option', '', square.title || t('unnamed', { number: index + 1 }));
                option.value = String(index);
                return option;
            }));
            ui.field.hidden = false;
            await inspect(current, 0);
        } catch (error) {
            if (session === current) status(t('failed', { reason: error.message }));
        }
    }

    win.addEventListener('cityChanged', () => close(false));
    doc.addEventListener('mapshell:sheetopened', () => close(false));
    win.addEventListener('mapmodechange', event => {
        if (session && event.detail?.desired !== '2d') close(false);
    });
    win.SquareCritic = { open };
})(window);
