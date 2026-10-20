// One local parcel-study draft, displayed through the shared planning map, model and inspector.
// Editing this comparison never creates an authored proposal, changes cadastral land or implies approval.
(function (root) {
    'use strict';
    const core = root.PlanningParcelAssessment, storageKey = 'cb_planning_parcel_study_v1';
    const t = (key, values) => root.i18n.t(`planningStudy.${key}`, values);
    let state = null, generation = 0;
    const defaults = () => ({ frontEdge: 0, scale: 0.65, eastM: 0, northM: 0, heightM: 9 });
    function node(tag, text, className) {
        const value = document.createElement(tag);
        if (text !== undefined) value.textContent = text;
        if (className) value.className = className;
        return value;
    }
    function save() {
        if (!state || state.stale) return;
        try { root.PersistentStorage.setItem(storageKey, JSON.stringify({ schemaVersion: 'planning-parcel-study.v1',
            sourceReference: state.context.sourceReference, parcelReference: state.context.parcelReference,
            form: state.form, basis: state.basis, design: state.design })); state.saveError = false; }
        catch (error) { state.saveError = true; console.error('[planning-study] Draft save failed', error); }
    }
    function saved() {
        try {
            const value = JSON.parse(root.PersistentStorage.getItem(storageKey) || 'null');
            return value?.schemaVersion === 'planning-parcel-study.v1' ? value : null;
        } catch (_) { return null; }
    }
    function calculate(form = state.form) {
        const basis = state.basis || core.designFromForm(state.context, { ...defaults(), scale: 1 }, root.turf).geometry;
        const design = core.designFromForm(state.context, form, root.turf, basis);
        const result = core.assess(state.context, design, form.frontEdge, root.turf);
        Object.assign(state, { form, basis, design, result });
        save();
    }
    function items() {
        if (!state || state.context.source.source.city !== root.CityConfigManager.getCurrentCityId()) return [];
        const { context, result } = state, prefix = `study:${context.source.source.id}:${context.parcel.id}`;
        const base = { study: true, proposalId: null, source: context.source.source, constraints: [],
            sourceEvidence: { sourceReferences: [context.sourceReference], parcelReference: context.parcelReference },
            spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
            authority: { effect: 'unknown', applicability: 'unresolved' } };
        const envelope = result?.envelope, design = result?.design;
        const volume = (id, geometry, topM) => geometry && topM > 0 ? [{ id, geometry, baseM: 0, topM }] : [];
        return [
            { ...base, id: `${prefix}:envelope`, role: 'permitted', title: t('envelopeTitle'), site: envelope?.geometry || null,
                areas: envelope?.geometry && envelope.heightM === null ? [{ geometry: envelope.geometry }] : [],
                volumes: volume(`${prefix}:bound`, envelope?.geometry, envelope?.heightM),
                metrics: { footprintM2: envelope?.areaM2, heightM: envelope?.heightM }, assessment: { meaning: 'partial-envelope' } },
            { ...base, id: `${prefix}:design`, role: 'proposed', title: t('designTitle'), site: design?.geometry || null, areas: [],
                volumes: volume(`${prefix}:form`, design?.geometry, design?.topM),
                metrics: { footprintM2: design?.footprintM2, heightM: design?.topM }, assessment: { meaning: 'study-design' } }
        ];
    }
    async function load({ city, source, scenario, parcel, point }) {
        const current = ++generation, url = new URL(`${root.getBackendBase()}/planning/study`);
        for (const [key, value] of Object.entries({ city, source, scenario, parcel, point: point?.join(',') })) if (value) url.searchParams.set(key, value);
        const response = await fetch(url, { cache: 'no-store' });
        const context = await response.json();
        if (!response.ok) throw new Error(context.code || 'study-source-unavailable');
        if (current !== generation || city !== root.CityConfigManager.getCurrentCityId()) return;
        if (context.schemaVersion !== 'planning-parcel-study.v1') throw new Error('study-source-unavailable');
        const previous = saved(), match = core.referenceState(previous, context);
        state = { context, form: defaults(), basis: null, design: null, result: null, stale: match === 'changed', saveError: false };
        if (match === 'same') {
            state.form = previous.form;
            state.basis = previous.basis;
            state.design = previous.design;
            // Assess the saved geometry itself; do not silently regenerate an edited draft on reload.
            state.result = core.assess(context, state.design, state.form.frontEdge, root.turf);
        } else if (!state.stale) calculate();
        const address = new URL(location.href);
        address.searchParams.set('planningParcel', context.parcel.id);
        address.searchParams.set('planningSource', context.source.source.id);
        address.searchParams.set('planningScenario', context.source.source.scenario);
        history.replaceState(history.state, '', address);
        root.PlanningViews.refreshStudy();
        root.PlanningViews.select(items()[1].id);
    }
    function addSourceAction(container, item) {
        if (!item.source.parcelStudy) return;
        const section = node('section', undefined, 'planning-study-start');
        const button = node('button', t('start'), 'btn'); button.type = 'button';
        const hint = node('p', t('startHint'), 'planning-source-note');
        button.addEventListener('click', async () => {
            button.disabled = true; hint.textContent = t('loading');
            const point = root.PlanningViews.getSelectionPoint() || root.map.getCenter();
            try { await load({ city: item.source.city, source: item.source.id, scenario: item.source.scenario, point: [point.lng, point.lat] }); }
            catch (error) {
                console.error('[planning-study] Source read failed', error);
                const key = `planningStudy.errors.${error.message}`;
                hint.textContent = root.i18n.t(key) === key ? t('errors.study-source-unavailable') : root.i18n.t(key);
            } finally { button.disabled = false; }
        });
        section.append(button, hint); container.append(section);
    }
    function measure(value, unit) {
        if (value === null || value === undefined) return '—';
        const formatted = root.CbFormat.formatNumber(value, { maxFractionDigits: 2 });
        return `${formatted} ${unit === 'percent' ? '%' : unit === 'm2' ? 'm²' : unit}`;
    }
    function renderResults(container) {
        container.replaceChildren();
        if (!state?.result) return;
        const summary = node('p', t(state.result.status), 'planning-assessment');
        summary.dataset.studySummary = state.result.status;
        summary.setAttribute('role', 'status');
        container.append(summary);
        const list = node('dl', undefined, 'planning-study-checks');
        for (const check of state.result.checks) {
            const row = node('div'); row.dataset.check = check.key; row.dataset.status = check.status;
            row.append(node('dt', ['height', 'lotArea'].includes(check.key)
                ? root.i18n.t(`planningViews.constraint.${check.key}`) : t(`checks.${check.key}`)));
            const detail = node('dd');
            detail.append(node('strong', t(`status.${check.status}`)));
            if (check.key === 'use') detail.append(node('span', root.i18n.t(`planningViews.resultStatus.${check.treatment}`)));
            else detail.append(node('span', `${t('measured')}: ${measure(check.measured, check.unit)}${check.limit === null ? '' : ` · ${t('limit')}: ${measure(check.limit, check.unit)}`}`));
            if (check.evidence && check.evidence !== 'direct') {
                const key = `planningViews.evidence.${check.evidence}`;
                detail.append(node('span', root.i18n.t(key) === key ? t('missingDirectValue') : root.i18n.t(key)));
            }
            row.append(detail); list.append(row);
        }
        container.append(list);
        const unresolved = node('details', undefined, 'planning-evidence'); unresolved.open = true;
        unresolved.append(node('summary', t('unresolvedTitle')));
        const reasons = node('ul');
        for (const reason of state.result.unresolved) reasons.append(node('li', t(`unresolvedReasons.${reason}`, {
            area: measure(state.context.sourceCoverage.uncoveredM2, 'm2') })));
        unresolved.append(reasons); container.append(unresolved);
        container.append(node('p', t(state.saveError ? 'saveError' : 'saved'), 'planning-source-note'));
    }
    function renderInspector(container) {
        if (!state) return;
        container.append(node('p', t('scope'), 'planning-inspector__description'));
        container.append(node('p', `${state.context.source.title || state.context.source.source.label} · ${state.context.parcel.properties.parcelNumber} · ${root.i18n.t(`planningViews.scenario.${state.context.source.source.scenario}`)}`, 'planning-source-note'));
        if (state.stale) {
            container.append(node('p', t('changed'), 'planning-assessment'));
            const restart = node('button', t('restart'), 'btn'); restart.type = 'button';
            restart.addEventListener('click', () => { state.stale = false; state.form = defaults(); state.basis = null; calculate(); root.PlanningViews.refreshStudy(); });
            container.append(restart); return;
        }
        const controls = node('div', undefined, 'planning-study-controls');
        const input = (key, min, max, step, factor = 1) => {
            const label = node('label', t(key));
            const field = node('input'); field.type = 'number'; field.min = min; field.max = max; field.step = step;
            field.value = state.form[key] * factor; field.dataset.studyInput = key; field.dataset.factor = factor;
            field.addEventListener('input', () => {
                const inputs = [...controls.querySelectorAll('input')];
                for (const entry of inputs) entry.setAttribute('aria-invalid', String(!entry.value || !entry.checkValidity()));
                if (inputs.some(entry => !entry.value || !entry.checkValidity())) {
                    container.querySelector('[data-study-results]').replaceChildren(node('p', t('invalidInput'), 'planning-assessment'));
                    return;
                }
                const next = { ...state.form, ...Object.fromEntries(inputs.map(entry =>
                    [entry.dataset.studyInput, Number(entry.value) / Number(entry.dataset.factor)])),
                    frontEdge: Number(controls.querySelector('select').value) };
                try {
                    calculate(next);
                    root.PlanningViews.refreshStudy({ inspector: false });
                    renderResults(container.querySelector('[data-study-results]'));
                } catch (error) {
                    console.error('[planning-study] Design assessment failed', error);
                    container.querySelector('[data-study-results]').replaceChildren(node('p', t('invalidInput'), 'planning-assessment'));
                }
            });
            label.append(field); controls.append(label);
        };
        input('heightM', 0.1, 100, 0.1); input('scale', 10, 200, 1, 100);
        input('eastM', -100, 100, 0.5); input('northM', -100, 100, 0.5);
        const edgeLabel = node('label', t('frontEdge'));
        const edges = node('select'); edges.dataset.studyInput = 'frontEdge';
        for (let i = 0; i < state.context.parcel.geometry.coordinates[0].length - 1; i++) {
            const option = node('option', t('edge', { number: i + 1 })); option.value = i; edges.append(option);
        }
        edges.value = state.form.frontEdge;
        edges.addEventListener('change', () => {
            if ([...controls.querySelectorAll('input')].some(entry => !entry.value || !entry.checkValidity())) return;
            // Changing edge interpretation reassesses the same design; it does not move the design to make it pass.
            try {
                const frontEdge = Number(edges.value);
                const result = core.assess(state.context, state.design, frontEdge, root.turf);
                state.form.frontEdge = frontEdge; state.result = result; save();
                root.PlanningViews.refreshStudy({ inspector: false }); renderResults(container.querySelector('[data-study-results]'));
            } catch (error) {
                console.error('[planning-study] Edge assessment failed', error);
                container.querySelector('[data-study-results]').replaceChildren(node('p', t('invalidInput'), 'planning-assessment'));
            }
        });
        edgeLabel.append(edges); controls.append(edgeLabel);
        container.append(controls);
        const results = node('section'); results.dataset.studyResults = ''; container.append(results); renderResults(results);
        const evidence = node('details', undefined, 'planning-evidence'); evidence.append(node('summary', t('references')));
        for (const source of [state.context.source.source, state.context.parcelSource]) {
            const link = node('a', source.label, 'cb-link cb-link--external'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            const paragraph = node('p'); paragraph.append(link); evidence.append(paragraph);
        }
        evidence.append(node('pre', JSON.stringify({ sourceReference: state.context.sourceReference,
            parcelReference: state.context.parcelReference, sourceCoverage: state.context.sourceCoverage }, null, 2), 'planning-evidence__terms'));
        container.append(evidence);
        const reset = node('button', t('reset'), 'btn btn-sm'); reset.type = 'button';
        reset.addEventListener('click', () => { state.form = defaults(); state.basis = null; calculate(); root.PlanningViews.refreshStudy(); });
        container.append(reset);
    }
    root.PlanningParcelStudy = { getItems: items, addSourceAction, renderInspector,
        getContext: () => state?.context, getForm: () => state?.form,
        clear() {
            generation++; state = null;
            const url = new URL(location.href); url.searchParams.delete('planningParcel'); history.replaceState(history.state, '', url);
        }, load };
    root.whenAppBooted().then(async () => {
        const params = new URLSearchParams(location.search), parcel = params.get('planningParcel'), source = params.get('planningSource');
        if (!parcel || !source) return;
        try { await load({ city: root.CityConfigManager.getCurrentCityId(), source, scenario: params.get('planningScenario') || undefined, parcel }); }
        catch (error) { console.error('[planning-study] Study restore failed', error); root.showNotification?.(t(`errors.${error.message}`), 'error'); }
    });
})(window);
