(function (win) {
    'use strict';
    const doc = win.document;
    const t = (key, values) => win.i18n.t(`beaverCritic.${key}`, values);
    const states = ['ready', 'blocked', 'unknown', 'later'];
    const colors = { ready: '#16785e', blocked: '#ac422d', unknown: '#667181', later: '#5866a1' };
    let session;
    function node(tag, className, text) {
        const el = doc.createElement(tag);
        if (className) el.className = className;
        if (text != null) el.textContent = text;
        return el;
    }

    function panelFor(plan) {
        const panel = node('section', 'beaver-critic-panel right-screen-panel');
        panel.id = 'beaver-critic-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-labelledby', 'beaver-critic-title');
        panel.innerHTML = `
            <header class="panel-header beaver-critic-header">
                <img src="/images/critic-beaver.webp" alt="" width="48" height="48">
                <div><h2 id="beaver-critic-title"></h2><p data-beaver="plan"></p></div>
                <button type="button" class="close-circle-btn" data-beaver="close">×</button>
            </header>
            <div class="panel-body beaver-critic-body">
                <p role="status" data-beaver="status"></p>
                <div class="beaver-critic-controls" data-beaver="controls" hidden>
                    <label class="beaver-critic-field">
                        <span data-beaver="monthLabel"></span><input type="month" data-beaver="month" required>
                    </label>
                    <label class="beaver-critic-toggle">
                        <input type="checkbox" data-beaver="delay"><span data-beaver="delayLabel"></span>
                    </label>
                    <output class="beaver-critic-score" data-beaver="score"></output>
                    <dl class="beaver-critic-results" data-beaver="totals"></dl>
                    <p data-beaver="impact"></p>
                    <p class="sheet-note" data-beaver="areaMissing" hidden></p>
                    <details class="beaver-critic-editor">
                        <summary data-beaver="assumptions"></summary>
                        <p class="sheet-note" data-beaver="method"></p>
                        <label class="beaver-critic-field">
                            <span data-beaver="searchLabel"></span><input type="search" data-beaver="search">
                        </label>
                        <div class="cb-actions">
                            <button type="button" class="btn btn-sm" data-beaver="selectVisible"></button>
                            <button type="button" class="btn btn-sm" data-beaver="clearSelection"></button>
                        </div>
                        <div class="beaver-critic-members" data-beaver="members"></div>
                        <fieldset class="beaver-critic-fields" data-beaver="fields">
                            <legend data-beaver="setFor"></legend>
                            <label class="beaver-critic-field">
                                <span data-beaver="accessLabel"></span><select data-beaver="access"></select>
                            </label>
                            <label class="beaver-critic-field">
                                <span data-beaver="servicingLabel"></span><select data-beaver="servicing"></select>
                            </label>
                            <label class="beaver-critic-field">
                                <span data-beaver="dateLabel"></span><select data-beaver="dateChoice"></select>
                            </label>
                            <label class="beaver-critic-field" data-beaver="testDate" hidden>
                                <span data-beaver="testDateLabel"></span><input type="month" data-beaver="completion">
                            </label>
                            <button type="button" class="btn btn-primary" data-beaver="apply"></button>
                        </fieldset>
                    </details>
                </div>
            </div>`;
        const ui = Object.fromEntries([...panel.querySelectorAll('[data-beaver]')].map(el => [el.dataset.beaver, el]));
        panel.querySelector('h2').textContent = t('title');
        ui.plan.textContent = plan.content.title;
        ui.close.setAttribute('aria-label', t('close'));
        for (const key of ['monthLabel', 'delayLabel', 'assumptions', 'method', 'searchLabel', 'selectVisible', 'clearSelection',
            'accessLabel', 'servicingLabel', 'dateLabel', 'testDateLabel', 'apply']) ui[key].textContent = t(key);
        const options = (select, keys) => keys.forEach(key => {
            const option = node('option', '', t(key));
            option.value = key;
            select.append(option);
        });
        options(ui.access, ['unchanged', 'unknown', 'independent', 'requires-connection']);
        options(ui.servicing, ['unchanged', 'unknown', 'ready']);
        options(ui.dateChoice, ['unchanged', 'planDates', 'testDates']);
        for (const input of [ui.month, ui.completion]) {
            input.min = win.PlanRecord.MONTHS.first;
            input.max = win.PlanRecord.MONTHS.last;
        }
        ui.status.textContent = t('loading');
        doc.body.append(panel);
        return { panel, ...ui };
    }

    function close(restore = true) {
        const current = session;
        if (!current) return;
        session = null;
        current.tour.abort();
        current.layer?.remove();
        current.unregister();
        current.ui.panel.remove();
        if (!restore) return;
        if (current.framed) win.map.setView(current.view.center, current.view.zoom, { animate: false });
        void win.PlanAnalysisControls.restoreCriticOrigin(win, doc, current, 'beaver')
            .catch(error => win.showStyledAlert(error.message));
    }

    function frame(current, bounds) {
        if (!bounds?.isValid()) return;
        const mapBox = win.map.getContainer().getBoundingClientRect();
        const panel = current.ui.panel.getBoundingClientRect();
        const mobile = win.matchMedia('(max-width: 767px)').matches;
        win.map.fitBounds(bounds, { maxZoom: 19, animate: false, paddingTopLeft: [30, 75],
            paddingBottomRight: mobile ? [30, mapBox.bottom - panel.top + 18] : [mapBox.right - panel.left + 20, 70] });
        current.framed = true;
    }

    function updateSelection(current) {
        const { ui, selected } = current;
        ui.setFor.textContent = t('setFor', { count: selected.size });
        ui.fields.disabled = selected.size === 0;
        ui.clearSelection.disabled = selected.size === 0;
        for (const [id, row] of current.rows) row.check.checked = selected.has(id);
    }

    function render(current, announce = false) {
        const { ui } = current;
        if (!ui.month.checkValidity()) {
            ui.status.classList.remove('sr-only');
            ui.status.textContent = t('monthInvalid');
            return;
        }
        const assessed = win.BeaverBuildout.evaluate(current.members, {
            month: ui.month.value, delayConnection: ui.delay.checked, assumptions: current.assumptions
        });
        const { totals, lostToDelay, readyShare } = assessed;
        const format = new Intl.NumberFormat(win.i18n.getLocale?.(), { maximumFractionDigits: 0 });
        const area = value => t('area', { value: format.format(value) });
        ui.score.textContent = readyShare === null ? t('readySpace', { area: area(totals.ready.spaceM2) })
            : t('score', { score: format.format(100 * readyShare) });
        ui.totals.replaceChildren(...states.map(status => {
            const entry = totals[status];
            const row = node('div', 'beaver-critic-total');
            row.dataset.status = status;
            row.append(node('dt', '', t(status)), node('dd', '', t('amounts', {
                floor: area(entry.floorM2), space: area(entry.spaceM2)
            })));
            return row;
        }));
        ui.impact.textContent = t('impact', { floor: area(lostToDelay.floorM2), space: area(lostToDelay.spaceM2) });
        ui.areaMissing.hidden = totals.all.unmeasuredBuildings === 0;
        ui.areaMissing.textContent = t('areaMissing', { count: totals.all.unmeasuredBuildings });
        for (const result of assessed.members) {
            const row = current.rows.get(result.cid);
            row.item.dataset.status = result.status;
            row.details.textContent = [t(result.reason), result.completionMonth].filter(Boolean).join(' · ');
            row.layer?.setStyle({ color: colors[result.status], fillColor: colors[result.status],
                dashArray: result.status === 'unknown' ? '3 4' : null });
        }
        ui.status.textContent = announce ? t('updated', { floor: area(totals.ready.floorM2), space: area(totals.ready.spaceM2) }) : '';
        ui.status.classList.toggle('sr-only', announce);
        return assessed;
    }

    function setupMembers(current) {
        const { ui } = current;
        for (const member of [...current.members].sort((a, b) => (a.title || a.cid).localeCompare(b.title || b.cid))) {
            const item = node('div', 'beaver-critic-member');
            const label = node('label', 'beaver-critic-toggle');
            const check = node('input');
            check.type = 'checkbox';
            const name = win.RecordLabel.label(member.title, member.cid);
            const details = node('small');
            label.append(check, node('span', '', name));
            const show = node('button', 'btn btn-sm', t('show'));
            show.type = 'button';
            show.setAttribute('aria-label', t('showDesign', { name }));
            item.append(label, details, show);
            ui.members.append(item);
            const layer = win.L.geoJSON(member.geometry, { interactive: false, style: { fillOpacity: .36, weight: 2 } });
            layer.addTo(current.layer);
            check.addEventListener('change', () => {
                if (check.checked) current.selected.add(member.cid);
                else current.selected.delete(member.cid);
                updateSelection(current);
            });
            show.addEventListener('click', () => frame(current, layer.getBounds()));
            current.rows.set(member.cid, { item, check, details, layer, name });
        }
        ui.search.addEventListener('input', () => {
            const query = ui.search.value.trim().toLocaleLowerCase();
            for (const row of current.rows.values()) row.item.hidden = !row.name.toLocaleLowerCase().includes(query);
            ui.selectVisible.disabled = ![...current.rows.values()].some(row => !row.item.hidden);
        });
        ui.selectVisible.addEventListener('click', () => {
            for (const [id, row] of current.rows) if (!row.item.hidden) current.selected.add(id);
            updateSelection(current);
        });
        ui.clearSelection.addEventListener('click', () => { current.selected.clear(); updateSelection(current); });
        ui.dateChoice.addEventListener('change', () => { ui.testDate.hidden = ui.dateChoice.value !== 'testDates'; });
        ui.apply.addEventListener('click', () => {
            if (ui.dateChoice.value === 'testDates' && !win.PlanRecord.semanticRules.month(ui.completion.value)) {
                ui.completion.focus();
                ui.status.classList.remove('sr-only');
                ui.status.textContent = t('monthInvalid');
                return;
            }
            for (const id of current.selected) {
                const value = current.assumptions[id] || {};
                if (ui.access.value !== 'unchanged') value.access = ui.access.value;
                if (ui.servicing.value !== 'unchanged') value.servicing = ui.servicing.value;
                if (ui.dateChoice.value === 'planDates') delete value.completionMonth;
                else if (ui.dateChoice.value === 'testDates') value.completionMonth = ui.completion.value;
                current.assumptions[id] = value;
            }
            render(current, true);
        });
        ui.month.addEventListener('change', () => render(current, true));
        ui.delay.addEventListener('change', () => render(current, true));
        updateSelection(current);
    }

    async function open(plan, row, returnTo = null) {
        close(false);
        const ui = panelFor(plan);
        const current = { plan, row, returnTo, ui, tour: new AbortController(), rows: new Map(), selected: new Set(), assumptions: Object.create(null),
            mode: win.__mapModeState?.desired || '2d', view: { center: win.map.getCenter(), zoom: win.map.getZoom() } };
        session = current;
        current.unregister = win.ModalEscape.register(ui.panel, () => close());
        ui.close.addEventListener('click', () => close());
        win.MapShell.closeSheets();
        win.ClickStack?.close();
        win.clearProposalPreview?.();
        ui.close.focus();
        try {
            const snapshot = await win.PlanWorkspace.resolve(plan);
            if (session !== current) return;
            current.members = win.BeaverBuildout.inventory(snapshot.content, snapshot.designs);
            if (!current.members.length) { ui.status.textContent = t('empty'); return; }
            if (current.mode !== '2d' && !await win.requestMapMode('2d')) throw new Error(t('mapUnavailable'));
            if (session !== current) return;
            current.layer = win.L.featureGroup().addTo(win.map);
            ui.month.value = current.members.map(member => member.planCompletionMonth).filter(Boolean).sort()[0]
                || new Date().toISOString().slice(0, 7);
            setupMembers(current);
            const { members } = render(current);
            const tour = win.CriticTour;
            const byCid = new Map(current.members.map(member => [member.cid, member]));
            const chronological = [...members].sort((a, b) => (a.completionMonth || '9999').localeCompare(b.completionMonth || '9999')
                || a.title.localeCompare(b.title));
            const steps = tour.sample(chronological).map(result => ({ geometry: byCid.get(result.cid).geometry, color: colors[result.status],
                label: tour.t('beaver', { name: result.title, detail: [result.completionMonth, t(result.reason)].filter(Boolean).join(' · ') }) }));
            await tour.play({ id: 'beaver', portrait: '/images/critic-beaver.webp', steps, panel: ui.panel, status: ui.status,
                close: ui.close, signal: current.tour.signal, frame: bounds => frame(current, bounds) });
            if (session !== current) return;
            ui.status.textContent = '';
            ui.controls.hidden = false;
            frame(current, current.layer.getBounds());
        } catch (error) {
            if (session === current) {
                current.layer?.remove();
                ui.controls.hidden = true;
                ui.status.textContent = t('failed', { reason: error.message });
            }
        }
    }

    win.addEventListener('cityChanged', () => close(false));
    doc.addEventListener('mapshell:sheetopened', () => close(false));
    win.addEventListener('mapmodechange', event => {
        if (session && event.detail?.desired !== '2d') close(false);
    });
    win.BeaverCritic = { open };
})(window);
