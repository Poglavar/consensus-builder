// One comparison control, source selection and viewport feed for the map and model views.
// Source results are read-only overlays: viewing them never applies a parcel/fabric mutation.
(function (root) {
    'use strict';
    const core = root.PlanningScene;
    const sharedLabels = { existing: 'threeMode.controls.built', proposed: 'threeMode.parcelPanel.proposed',
        solid: 'threeMode.controls.stateSolid', ghost: 'threeMode.controls.stateGhost', off: 'threeMode.controls.stateOff',
        surviving: 'threeMode.controls.stateSurviving', removed: 'threeMode.controls.stateRemoved',
        massing: 'threeMode.controls.representationMassing', buildout: 'threeMode.controls.representationBuildOut',
        both: 'threeMode.controls.representationBoth', all: 'activityFeed.all', reroll: 'threeMode.controls.reroll', retry: 'bets.retry', close: 'common.close' };
    const t = (key, params = {}) => root.i18n.t(sharedLabels[key] || `planningViews.${key}`, params);
    let store, items = [], payload = null, status = 'loading', layer, controller, request = 0, loadedKey = '';
    let panel, inspector, lastSettings = null, lastSelectedId = null, ready = false, selectionLayer;
    let progress = null;
    let selectionPoint = null;
    let sourceOptions = [], sourceId = '', scenarioId = '', focusedRecord = null, sourceGeneration = 0, actionsOpen = false, referenceStatus = null;
    let restoreId = new URLSearchParams(location.search).get('planningSelection'), restoring = false, catalogReady = false, parcelPanel = null;
    // Per-item configuration pins chosen in the inspector; cleared with the source, housing type or city.
    let pins = {}, sourcesKey = '';
    const displaySelection = () => ({ variation: store?.get().variation || '', scenario: scenarioId || core.ANY_CONFIGURATION, pins });
    const scenarioParam = () => scenarioId && scenarioId !== core.ANY_CONFIGURATION ? scenarioId : '';
    const scenarioLabel = id => id ? t(`scenario.${id}`) : '';
    function permittedFeatures(item) { return core.permittedFeatures(item, store?.get(), displaySelection()); }
    // The housing type a study of this item should use: the shown configuration, else the pinned type, else the source default.
    function studyScenarioFor(item) {
        return permittedFeatures(item).configuration?.id || scenarioParam() || item.source.scenario
            || sourceOptions.find(source => source.id === item.source.id)?.scenario || undefined;
    }
    function pinConfiguration(itemId, configurationId) {
        pins = { ...pins, [itemId]: configurationId };
        drawMap(); renderInspector(); notifyGeometry();
    }
    const number = value => typeof value === 'number' && Number.isFinite(value)
        ? root.CbFormat.formatNumber(value, { maxFractionDigits: 0 }) : '—';
    const area = value => typeof value === 'number' && Number.isFinite(value)
        ? root.CbFormat.formatArea(value, { maxFractionDigits: 0 }) : '—';
    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function color(role) {
        return getComputedStyle(document.documentElement).getPropertyValue(`--cb-planning-${role}`).trim();
    }
    function policy() { return core.displayPolicy(store?.get()); }
    function sceneItems() {
        const study = root.PlanningParcelStudy?.getItems() || [];
        const reference = study[0]?.sourceEvidence?.parcelReference;
        return [...items.filter(item => !item.parcelEnvelope || item.sourceEvidence.parcelReference.parcelId !== reference?.parcelId
            || item.sourceEvidence.parcelReference.sourceId !== reference?.sourceId), ...study];
    }
    function appearance(item) { return core.itemAppearance(item, store?.get()); }
    function selected() { return (focusedRecord?.id === store?.get().selectedId ? focusedRecord : null)
        || sceneItems().find(item => item.id === store?.get().selectedId) || null; }
    function notifyGeometry() { root.dispatchEvent(new CustomEvent('planninggeometrychange')); }
    function select(id) {
        if (!ready) return;
        if (id && !sceneItems().some(item => item.id === id) && focusedRecord?.id !== id) return;
        if (id) {
            const target = focusedRecord?.id === id ? focusedRecord : sceneItems().find(item => item.id === id);
            if (target?.role !== 'proposed' || target.study) root.ProposalSelection?.clear();
            root.Parcels?.uiParcelPanel?.hideParcelInfoPanel?.({ preserveProposalSelection: target?.role === 'proposed' });
            root.hideProposalDetailsPanel?.(false, {
                preserveCorridorSegment: target?.role === 'proposed'
                    && root.corridorLastClickedSegment?.proposalKey === target.proposalId
            });
            root.hideRoadInfoPanel?.();
        }
        else if (selected()?.role === 'proposed') {
            root.ProposalSelection?.clear();
            root.hideProposalDetailsPanel?.();
        }
        actionsOpen = false;
        restoreId = null;
        store.select(id);
        renderInspector();
    }
    function selectRecord(record) { focusedRecord = record; referenceStatus = null; select(record?.id || null); }
    function inspectBuilding(feature, key) {
        const record = root.PlanningRepresentations.built(feature, { key: key || root.buildingPoolFeatureKey?.(feature),
            city: root.CityConfigManager.getCurrentCityId(), footprintM2: feature.geometry ? root.turf.area(feature) : null });
        if (record) selectRecord(record);
    }
    function inspectProposal(proposal) {
        const key = root.getProposalKey(proposal);
        const record = root.PlanningRepresentations.proposed(proposal, { key,
            city: root.CityConfigManager.getCurrentCityId(), applied: root.isProposalApplied?.(proposal) === true });
        if (record) {
            selectRecord(record);
            if (!root.ProposalSelection?.is(key)) root.ProposalSelection?.select(proposal);
        }
    }
    function resultLabel(value) {
        const key = `planningViews.resultStatus.${value}`;
        const label = root.i18n.t(key);
        return label === key ? String(value || '') : label;
    }
    function inspectorBadgeKey(item) {
        if (item.role !== 'permitted') return item.role;
        return ['public-screen', 'zoning-area', 'partial-envelope', 'outer-bound'].includes(item.assessment?.meaning) ? 'sourceEvidenceBadge' : 'obligatory';
    }
    async function parcelRecords(parcel, signal, context = {}) {
        const url = new URL(`${root.getBackendBase()}/planning/parcel`);
        url.searchParams.set('city', context.city || root.CityConfigManager.getCurrentCityId());
        url.searchParams.set('parcel', parcel);
        if (context.source || sourceId) url.searchParams.set('source', context.source || sourceId);
        const response = await fetch(url, { signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`Planning parcel HTTP ${response.status}`);
        const answer = await response.json();
        if (answer.parcel !== parcel || !Array.isArray(answer.items)) throw new Error('Invalid planning parcel response');
        return answer.items;
    }
    async function sourceRecord(reference) {
        const url = new URL(`${root.getBackendBase()}/planning/record`);
        for (const [key, value] of Object.entries({ city: reference.city, source: reference.providerId,
            recordId: reference.recordId, scenario: reference.scenario })) if (value) url.searchParams.set(key, value);
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Planning record HTTP ${response.status}`);
        const answer = await response.json();
        if (answer.recordId !== reference.recordId || !Array.isArray(answer.items)) throw new Error('Invalid source record response');
        return answer.items;
    }
    // Add only evidence actually returned by the cache. An absent row adds no diagnosis.
    async function showParcelEvidence(container, parcel) {
        if (!container || !parcel) return;
        parcelPanel = { container, parcel };
        container.querySelector('.planning-parcel-evidence')?.remove();
        const section = element('section', 'planning-parcel-evidence'); section.hidden = true;
        container.append(section);
        try {
            const records = await parcelRecords(parcel);
            if (!section.isConnected) return;
            for (const record of records) {
                section.hidden = false;
                section.append(element('h3', '', t('savedResult')),
                    element('p', '', `${record.source.label} · ${resultLabel(record.assessment.status)}`));
                if (record.assessment.reason) section.append(element('p', 'planning-cache-reason', record.assessment.reason));
                const inspect = element('button', 'btn', t('inspectResult'));
                inspect.type = 'button'; inspect.addEventListener('click', () => selectRecord(record));
                section.append(inspect);
            }
        } catch (error) {
            console.error('[planning] Could not read parcel evidence', error);
            if (section.isConnected) { section.hidden = false; section.append(element('p', '', t('error'))); }
        }
    }
    function drawMap() {
        if (!ready) return;
        selectionLayer.clearLayers();
        const selection = selected();
        if (selection?.site && (selection.role !== 'permitted' || !selection.volumes.length)) {
            root.L.geoJSON(selection.site, { pane: 'planningSources', interactive: false,
                style: { color: color(selection.role), weight: 3, fill: false, opacity: 1 } }).addTo(selectionLayer);
        }
        layer.clearLayers();
        const studyParcel = root.PlanningParcelStudy?.getContext()?.parcel;
        const frontEdge = root.PlanningParcelStudy?.getForm()?.frontEdge;
        if (studyParcel && sceneItems().some(item => item.study && policy()[item.role] !== 'off')) {
            root.L.geoJSON(studyParcel, { pane: 'planningSources', interactive: false,
                style: { color: color('existing'), fill: false, weight: 2 } }).addTo(layer);
            const ring = studyParcel.geometry.coordinates[0];
            if (ring[frontEdge]) root.L.polyline([ring[frontEdge], ring[frontEdge + 1]].map(p => [p[1], p[0]]),
                { pane: 'planningSources', color: color('proposed'), weight: 5 }).bindTooltip(root.i18n.t('planningStudy.frontEdge')).addTo(layer);
        }
        for (const item of sceneItems()) {
            const display = appearance(item);
            if (display === 'off') continue;
            let features;
            try { features = core.mapFeatures(item, store.get().permittedMap, root.turf, store.get(), displaySelection()); }
            catch (error) { console.error('[planning] Could not project massing', item.id, error); continue; }
            const hasBody = features.some(feature => feature.properties.geometryRole !== 'bound');
            for (const feature of features) {
                const active = item.id === store.get().selectedId;
                // The outer bound behind a shown configuration is a hull: outline plus a faint fill.
                const hull = feature.properties.geometryRole === 'bound' && hasBody;
                // The hull is not a second click target: the configuration inside carries the interaction.
                const shape = root.L.geoJSON(feature, { pane: 'planningSources', className: hull ? 'planning-bound-outline' : undefined, interactive: !hull,
                    style: { color: color(item.role), weight: hull ? 1 : active ? 3 : 1.5, dashArray: hull ? '4 4' : null,
                        fillColor: color(item.role), fillOpacity: hull ? 0.06 : display === 'solid' ? 1 : 0.18,
                        opacity: hull ? 0.8 : 1 } });
                const height = feature.properties.topM;
                const label = item.source.parcel || item.title;
                const configuration = feature.properties.configurationId ? scenarioLabel(feature.properties.configurationId) : hull ? t('bound') : '';
                const tooltip = item.assessment.meaning === 'existing-stock-estimate' ? `${label} · ${t('stockBadge')}`
                    : [label, configuration, height ? root.CbFormat.formatLength(height) : ''].filter(Boolean).join(' · ');
                shape.bindTooltip(tooltip, { sticky: true, direction: 'top' });
                if (item.parcelEnvelope && height && !hull && root.map.getZoom() >= 18) {
                    const center = shape.getBounds().getCenter();
                    root.L.marker(center, { pane: 'planningSources', interactive: false, keyboard: false,
                        icon: root.L.divIcon({ className: 'planning-envelope-height', html: root.CbFormat.formatLength(height), iconSize: null }) }).addTo(layer);
                }
                shape.addTo(layer);
                if (hull) continue;
                const inspect = () => { if (!root.__mapEditLock?.isHeld()) select(item.id); };
                shape.on('click', event => { root.L.DomEvent.stopPropagation(event); selectionPoint = { id: item.id, lat: event.latlng.lat, lng: event.latlng.lng }; inspect(); });
                shape.eachLayer(part => {
                    const node = part.getElement?.();
                    if (!node) return;
                    node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button');
                    node.setAttribute('aria-label', item.study ? `${root.i18n.t('planningStudy.title')}: ${label}`
                        : t(item.areas?.length ? 'inspectArea' : 'inspectMassing', { parcel: label }));
                    node.addEventListener('keydown', event => {
                        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); inspect(); }
                    });
                });
            }
        }
    }
    function isPhoto() { return root.__mapModeState?.desired === 'photo'; }
    function stateText() {
        if (isPhoto()) return t('photoNote');
        if (policy().permitted === 'off' && store.get().zoningAreas === 'off') return t('permittedOff');
        if (status === 'loading' && progress?.total) return t('loadingProgress', progress);
        if (status !== 'ready') return t(status);
        if (!payload?.sources?.length) return t('unavailable');
        if (payload.envelopes) return t('envelopesLoaded', { count: items.filter(item => item.parcelEnvelope).length,
            missing: payload.unavailable.length });
        if (!items.length) return t('empty');
        const text = t(payload.omitted ? 'partial' : payload.sources.some(source => source.capabilities.areas) ? 'areasLoaded' : 'loaded', { count: items.length });
        const pending = (payload.summaries || []).reduce((sum, entry) => sum + (entry.awaitingRefresh || 0), 0);
        return pending ? `${text} · ${t('refreshCount', { count: pending })}` : text;
    }
    function renderInspector() {
        const item = selected();
        inspector.hidden = !item || actionsOpen || isPhoto();
        inspector.replaceChildren();
        if (!item) return;
        const header = element('header', 'planning-inspector__header');
        const heading = element('div');
        const sourceResult = item.role === 'permitted';
        heading.append(element('p', 'planning-eyebrow', item.parcelEnvelope ? t('envelopeTitle')
            : t(item.areas?.length ? 'zoningArea' : sourceResult ? (item.volumes.length ? 'sourceProposal' : 'savedResult') : item.role === 'existing' ? 'builtRecord' : 'proposedRecord')), element('h2', '', item.title));
        const close = element('button', 'close-circle-btn', '×');
        close.type = 'button'; close.setAttribute('aria-label', t('close'));
        close.addEventListener('click', () => { select(null); document.getElementById('planning-views-button').focus(); });
        header.append(heading, close);
        inspector.append(header);
        if (item.study) {
            heading.querySelector('.planning-eyebrow').textContent = root.i18n.t('planningStudy.title');
            root.PlanningParcelStudy.renderInspector(inspector);
            return;
        }
        const badges = element('div', 'planning-inspector__badges');
        badges.append(element('span', 'cb-badge', t(inspectorBadgeKey(item))));
        if (sourceResult && item.volumes.length) badges.append(element('span', 'cb-badge cb-badge--warning',
            t(item.assessment.meaning === 'existing-stock-estimate' ? 'stockBadge' : item.parcelEnvelope ? 'bound' : 'approximate')));
        if (item.assessment.refresh) badges.append(element('span', 'cb-badge cb-badge--warning', t('refreshPending')));
        inspector.append(badges, element('p', 'planning-inspector__description',
            t(item.assessment.meaning === 'existing-stock-estimate' ? 'stockEstimate'
                : item.assessment.meaning === 'public-screen' ? 'evidenceOnly'
                    : item.assessment.meaning === 'zoning-area' ? 'zoningAreaNote'
                        : item.parcelEnvelope ? 'envelopeNote'
                        : sourceResult ? (item.volumes.length ? 'oneOption' : 'savedNoShape')
                        : item.role === 'existing' ? 'observedNote' : 'authoredNote')));
        if (item.role === 'proposed') {
            const proposal = root.proposalStorage?.getProposal(item.proposalId);
            const lifecycleKey = root.getProposalLifecycleKey(proposal);
            inspector.append(element('p', 'planning-inspector__description', root.getProposalLifecycleLabel(lifecycleKey)));
            const state = root.__proposalDisplayState.of(proposal);
            const hint = root.__proposalDisplayState.rungHint(state.rung, (key, fallback) => root.i18n.t(key) || fallback);
            if (hint) inspector.append(element('p', 'planning-inspector__description', hint));
        } else if (item.assessment.status && !item.parcelEnvelope) inspector.append(element('p', 'planning-inspector__description', resultLabel(item.assessment.status)));
        if (item.assessment.reason) inspector.append(element('p', 'planning-cache-reason', item.assessment.reason));
        if (item.assessment.current === false) inspector.append(element('p', 'planning-inspector__description', t('savedWithdrawn')));
        if (referenceStatus && referenceStatus !== 'same') inspector.append(element('p', 'planning-assessment', t('referenceChanged')));
        if (item.assessment.refresh) {
            const key = `planningViews.refreshCause.${item.assessment.refresh.code}`;
            const reason = root.i18n.t(key);
            inspector.append(element('p', 'planning-inspector__description', `${t('refreshNote')} ${reason === key ? t('refreshFailed') : reason}`));
        }
        const metrics = element('dl', 'planning-metrics');
        const unitLimit = item.constraints?.find(constraint => constraint.quantity === 'dwellings')?.value;
        const displayedMetrics = [];
        if (item.metrics.floorAreaM2 != null) displayedMetrics.push([t('floorArea'), area(item.metrics.floorAreaM2)]);
        if (item.metrics.heightM != null) displayedMetrics.push([t('height'), root.CbFormat.formatLength(item.metrics.heightM, { maxFractionDigits: 1 })]);
        if (unitLimit != null) displayedMetrics.push([t('dwellingLimit'), number(unitLimit)]);
        if (item.metrics.footprintM2 != null) displayedMetrics.push([t('footprintArea'), area(item.metrics.footprintM2)]);
        for (const [label, value] of displayedMetrics) {
            const entry = element('div'); entry.append(element('dt', '', label), element('dd', '', value)); metrics.append(entry);
        }
        if (displayedMetrics.length) inspector.append(metrics);
        const heights = [...new Set(item.volumes.map(volume => volume.topM))].sort((a, b) => a - b);
        if (heights.length > 1) inspector.append(element('p', 'planning-inspector__description', t('heightParts', { heights: heights.map(height => root.CbFormat.formatLength(height)).join(' · ') })));
        const shown = permittedFeatures(item).configuration;
        if (item.configurations?.length) inspector.append(renderConfigurations(item, shown));
        const assessment = element('div', 'planning-assessment');
        assessment.append(element('strong', '', t('conditionsTitle')), element('p', '', t('conditionsNote')));
        if (item.role === 'proposed' || (sourceResult && item.volumes.length)) inspector.append(assessment);
        const constraints = shown ? shown.constraints : item.constraints;
        if (constraints?.length) {
            const limits = element('dl', 'planning-limits');
            if (shown) limits.append(element('dt', 'planning-limits__scope', scenarioLabel(shown.id)), element('dd', '', ''));
            for (const constraint of constraints) {
                const digits = constraint.value === 0 ? 0 : Math.min(20, Math.max(6, 2 - Math.floor(Math.log10(Math.abs(constraint.value)))));
                const measured = root.CbFormat.formatNumber(constraint.value, { maxFractionDigits: digits });
                const value = constraint.unit === 'm2' ? area(constraint.value)
                    : constraint.unit === 'percent' ? `${measured}%`
                        : constraint.unit === 'count' ? number(constraint.value) : `${measured} ${constraint.unit}`;
                const evidence = constraint.evidence ? ` · ${t(`evidence.${constraint.evidence}`)}` : '';
                limits.append(element('dt', '', t(`constraint.${constraint.quantity}`)), element('dd', '', value + evidence));
            }
            inspector.append(limits);
        }
        const evidence = element('details', 'planning-evidence');
        evidence.append(element('summary', '', t('sourceDetails')));
        if (item.source.label) evidence.append(element('p', '', item.source.label));
        if (item.source.computedAt) evidence.append(element('p', '', t('computed', { date: root.CbFormat.formatDate(item.source.computedAt) })));
        if (item.source.fetchedAt) evidence.append(element('p', '', t('recorded', { date: root.CbFormat.formatDate(item.source.fetchedAt) })));
        if (item.source.solverVersion) evidence.append(element('p', '', t('solverVersion', { version: item.source.solverVersion })));
        if (item.source.parcel) evidence.append(element('p', '', item.source.parcel));
        if (item.proposal) evidence.append(element('pre', 'planning-evidence__terms', JSON.stringify(item.proposal, null, 2)));
        // Source terms remain inspectable even when an adapter has no executable constraint mapping.
        if (item.sourceEvidence) {
            const terms = element('pre', 'planning-evidence__terms', JSON.stringify(item.sourceEvidence, null, 2));
            evidence.append(element('p', '', t('sourceTerms')), terms);
        }
        inspector.append(evidence);
        root.PlanningParcelStudy?.addSourceAction(inspector, item);
        for (const reference of item.sourceEvidence?.sourceReferences || []) {
            const button = element('button', 'btn btn-sm', t('referencedSource', { source: reference.providerId, revision: reference.revision.slice(0, 8) }));
            button.type = 'button'; button.addEventListener('click', async () => {
                button.disabled = true;
                try {
                    const records = await sourceRecord(reference);
                    if (selected()?.id !== item.id) return;
                    const source = records.find(record => record.proposalId === reference.proposalId);
                    if (!source) { button.textContent = t('referenceUnavailable'); return; }
                    const comparison = root.PlanningSourceProposal.compareReference(reference, source.proposal);
                    selectRecord(source); referenceStatus = comparison; renderInspector();
                } catch (error) { console.error('[planning] Referenced source read failed', error); button.textContent = t('error'); }
                finally { button.disabled = false; }
            });
            inspector.append(button);
        }
        const footer = element('footer', 'planning-inspector__footer');
        if (item.source.url) {
            const link = element('a', 'cb-link cb-link--external', t('readSource'));
            link.href = item.source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            footer.append(link);
        }
        if (item.role === 'proposed') {
            const action = element('button', 'btn', t('proposalActions'));
            action.type = 'button'; action.addEventListener('click', async () => {
                const proposal = root.proposalStorage?.getProposal(item.proposalId);
                if (!proposal) return;
                if (root.__mapModeState?.desired === 'model') await root.requestMapMode('2d');
                actionsOpen = true; renderInspector();
                root.showProposalInfo(proposal, root.ProposalSelection?.getParcelId(), null, { planningActions: true });
            });
            footer.append(action);
        }
        inspector.append(footer);
    }
    // Every configuration the source records for this parcel, with the shown one marked. Picking
    // one pins it for this parcel only; the dice keeps rolling the others.
    function renderConfigurations(item, shown) {
        const section = element('section', 'planning-configurations');
        section.append(element('h3', '', t('configurationsTitle')));
        const list = element('ul', 'planning-configurations__list');
        for (const configuration of item.configurations) {
            const row = element('li'); row.dataset.configuration = configuration.id;
            const button = element('button', 'planning-configurations__pick'); button.type = 'button';
            button.setAttribute('aria-pressed', String(shown?.id === configuration.id));
            button.setAttribute('aria-label', `${t('configurationShow')}: ${scenarioLabel(configuration.id)}`);
            button.append(element('strong', '', scenarioLabel(configuration.id)), element('span', '', resultLabel(configuration.treatment)));
            const measure = configuration.unavailableReason ? t(`envelopeUnavailable.${configuration.unavailableReason}`)
                : `${root.CbFormat.formatLength(configuration.metrics.heightM, { maxFractionDigits: 1 })} · ${area(configuration.metrics.footprintM2)}`;
            button.append(element('span', 'planning-configurations__measure', measure));
            if (shown?.id === configuration.id) button.append(element('span', 'cb-badge', t('configurationShown')));
            button.addEventListener('click', () => pinConfiguration(item.id, configuration.id));
            row.append(button); list.append(row);
        }
        section.append(list);
        const excluded = Object.entries(item.sourceEvidence?.excludedConfigurations || {});
        if (excluded.length) section.append(element('p', 'planning-source-note', t('excludedConfigurations', {
            list: excluded.map(([scenario, treatment]) => `${scenarioLabel(scenario)} (${resultLabel(treatment)})`).join(', ') })));
        return section;
    }
    function render() {
        if (!ready) return;
        panel.querySelector('.map-sheet-title').textContent = t('title');
        panel.querySelector('.planning-source-label').textContent = t('sourceEdition');
        const sourceSelect = panel.querySelector('.planning-source-select');
        sourceSelect.setAttribute('aria-label', t('sourceEdition'));
        sourceSelect.value = sourceId;
        sourceSelect.disabled = sourceOptions.length < 2;
        const descriptor = sourceOptions.find(source => source.id === sourceId);
        panel.querySelector('.planning-source-note').textContent = descriptor?.parcelStudy ? t('envelopeNote') : descriptor?.capabilities.areas ? t('zoningAreaNote')
            : descriptor?.capabilities.volumes === false ? t('evidenceOnly') : '';
        panel.querySelector('.planning-zoning-label').textContent = t('zoningAreas');
        panel.querySelector('.planning-zoning-field').hidden = !descriptor?.capabilities.areas;
        const scenario = panel.querySelector('.planning-scenario-select');
        scenario.value = scenarioId; scenario.setAttribute('aria-label', t('scenarioLabel'));
        panel.querySelector('.planning-scenario-label').textContent = t('scenarioLabel');
        scenario.parentElement.hidden = !(descriptor?.scenarios?.length > 1);
        for (const option of scenario.options) option.textContent = t(`scenario.${option.value}`);
        const reroll = panel.querySelector('.planning-reroll');
        reroll.title = t('reroll'); reroll.setAttribute('aria-label', t('reroll'));
        reroll.disabled = policy().proposed === 'off' && (policy().permitted === 'off' || !descriptor?.parcelStudy);
        for (const role of core.roles) {
            panel.querySelector(`[data-role-label="${role}"]`).textContent = t(role);
            const select = panel.querySelector(`[data-planning-setting="${role}"]`);
            select.setAttribute('aria-label', t('displayLabel', { role: t(role) }));
        }
        panel.querySelectorAll('[data-planning-setting]').forEach(select => {
            select.value = store.get()[select.dataset.planningSetting];
            for (const option of select.options) option.textContent = t(option.value);
        });
        for (const key of ['existingScope', 'proposedForm', 'permittedForm', 'permittedMap', 'zoningAreas']) {
            panel.querySelector(`[data-planning-setting="${key}"]`).setAttribute('aria-label', t(key));
        }
        // Configured sources choose bound / configuration / both; one-option sources choose the 2D footprint detail.
        panel.querySelector('[data-planning-setting="permittedForm"]').hidden = !descriptor?.parcelStudy || isPhoto();
        panel.querySelector('[data-planning-setting="permittedMap"]').hidden = root.__mapModeState?.desired === 'model' || isPhoto()
            || descriptor?.capabilities.volumes === false;
        panel.querySelector('.planning-view-status').textContent = stateText();
        panel.querySelector('.planning-view-status').setAttribute('aria-busy', String(status === 'loading'));
        const retry = panel.querySelector('.planning-view-retry');
        retry.hidden = status !== 'error' || policy().permitted === 'off' && store.get().zoningAreas === 'off'; retry.textContent = t('retry');
        panel.querySelector('.planning-coverage summary').textContent = t('coverageTitle');
        panel.querySelector('.planning-coverage p').textContent = t(payload?.envelopes ? 'envelopeCoverage' : 'coverageNote');
        const summary = panel.querySelector('.planning-cache-summary');
        const summaries = payload?.summaries || [];
        summary.hidden = !summaries.length || policy().permitted === 'off';
        summary.textContent = t(payload?.envelopes ? 'envelopeSummary' : 'cacheSummary', { count: summaries.reduce((sum, entry) => sum + entry.cachedResults, 0),
            shapes: summaries.reduce((sum, entry) => sum + entry.withGeometry, 0),
            missing: summaries.reduce((sum, entry) => sum + entry.withoutGeometry, 0) });
        const counts = panel.querySelector('.planning-result-counts');
        counts.replaceChildren();
        for (const entry of summaries) for (const [status, count] of Object.entries(entry.statuses)) {
            const key = `planningViews.resultStatus.${status}`;
            const label = root.i18n.t(key);
            counts.append(element('dt', '', label === key ? t('otherResult') : label), element('dd', '', number(count)));
        }
        const unavailable = {};
        for (const entry of payload?.unavailable || []) unavailable[entry.reason] = (unavailable[entry.reason] || 0) + 1;
        for (const [reason, count] of Object.entries(unavailable)) {
            counts.append(element('dt', '', t(`envelopeUnavailable.${reason}`)), element('dd', '', number(count)));
        }
        panel.querySelector('.planning-inspect-hint').textContent = t('inspectHint');
        panel.querySelector('.planning-inspect-hint').hidden = policy().permitted === 'off' || !items.length || isPhoto();
        const model = panel.querySelector('.planning-open-model');
        model.hidden = !isPhoto(); model.textContent = t('openModel');
        renderInspector();
    }
    function syncView() {
        const state = store.get();
        const view = policy();
        document.body.dataset.planningProposed = view.proposed;
        document.body.dataset.planningExisting = view.existing;
        document.body.dataset.planningExistingScope = state.existingScope;
        const signature = JSON.stringify({ ...core.settings(state), variation: state.variation });
        const settingsChanged = lastSettings !== signature;
        if (settingsChanged) {
            const previous = lastSettings ? JSON.parse(lastSettings) : {};
            lastSettings = signature;
            try { root.PersistentStorage.setItem('cb_planning_display', JSON.stringify(core.settings(state))); } catch (_) { }
            const url = new URL(location.href); url.searchParams.delete('planning');
            for (const [key, value] of Object.entries(core.settings(state))) url.searchParams.set(key, value);
            history.replaceState(history.state, '', url);
            const proposed = document.getElementById('showProposedBuildings');
            if (proposed && !proposed.checked && view.proposed !== 'off') { proposed.checked = true; root.toggleLayer?.('proposedBuildings'); }
            const existing = document.getElementById('showBuildings');
            if (existing && !existing.checked && view.existing !== 'off') { existing.checked = true; root.toggleLayer?.('buildings'); }
            if (previous.existingScope !== state.existingScope) root.rebuildBuildingLayerFromPool?.();
            if (previous.proposedForm !== state.proposedForm || previous.variation !== state.variation) {
                root.updateProposedBuildingsLayer?.({ announce: false });
            }
            root.dispatchEvent(new CustomEvent('planningviewchange', { detail: { settings: core.settings(state), policy: view } }));
        }
        drawMap(); render();
        if (lastSelectedId !== state.selectedId) {
            lastSelectedId = state.selectedId;
            const url = new URL(location.href);
            if (state.selectedId) url.searchParams.set('planningSelection', state.selectedId);
            else url.searchParams.delete('planningSelection');
            if (sourceId) url.searchParams.set('planningSource', sourceId);
            if (scenarioId) url.searchParams.set('planningScenario', scenarioId);
            history.replaceState(history.state, '', url);
            root.dispatchEvent(new CustomEvent('planningselectionchange', { detail: { id: state.selectedId } }));
        }
        if (settingsChanged && (view.permitted !== 'off' || state.zoningAreas !== 'off')) refresh();
    }
    async function refresh({ force = false } = {}) {
        if (!ready || !catalogReady || policy().permitted === 'off' && store.get().zoningAreas === 'off') return;
        if (root.map.getZoom() < 16) {
            controller?.abort(); request++; loadedKey = ''; items = []; status = 'zoom'; payload = null;
            if (!selected()) store.select(null);
            drawMap(); render(); notifyGeometry(); return;
        }
        const city = root.CityConfigManager.getCurrentCityId();
        const bounds = root.map.getBounds();
        const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
        // Bounds-registered sources come and go with the viewport; re-list them when it moves.
        if (!(await ensureSources(city, bbox))) return;
        const descriptor = sourceOptions.find(source => source.id === sourceId);
        const massing = Boolean(descriptor?.parcelStudy && policy().permitted !== 'off');
        const zoning = store.get().zoningAreas !== 'off';
        const key = `${sourceId}:${scenarioId}:${massing}:${zoning}:${core.queryKey(city, bbox)}`;
        if (!force && key === loadedKey) return;
        loadedKey = key;
        controller?.abort(); controller = new AbortController();
        const generation = ++request;
        status = 'loading'; progress = null; render();
        try {
            const url = new URL(`${root.getBackendBase()}/planning/representations`);
            url.searchParams.set('city', city); url.searchParams.set('bbox', bbox.join(','));
            if (sourceId) url.searchParams.set('source', sourceId);
            if (scenarioParam()) url.searchParams.set('scenario', scenarioParam());
            const options = { city, signal: controller.signal,
                onProgress(value) { if (generation === request) { progress = value; render(); } } };
            const requests = [];
            if (!descriptor?.capabilities.areas || zoning) requests.push(root.PlanningFeed.loadViewport(url, options));
            if (massing) {
                const envelopeUrl = new URL(url); envelopeUrl.pathname = '/planning/envelopes';
                requests.push(root.PlanningFeed.loadViewport(envelopeUrl, options).then(answer => ({ ...answer, envelopes: true })));
            }
            const answers = await Promise.all(requests);
            const answer = answers.find(answer => answer.envelopes) || answers[0]
                || { sources: [descriptor], summaries: [], unavailable: [], omitted: 0, items: [] };
            answer.items = answers.flatMap(answer => answer.items);
            if (generation !== request) return;
            payload = answer; items = answer.items; status = 'ready';
            if (!selected()) store.select(null);
            drawMap(); render(); notifyGeometry();
            restoreSelection();
        } catch (error) {
            if (generation !== request || error.name === 'AbortError') return;
            if (error.status === 400) {
                items = []; payload = null; status = 'zoom';
                if (!selected()) store.select(null);
                drawMap(); render(); notifyGeometry(); return;
            }
            console.error('[planning] Could not load source representations', error);
            loadedKey = ''; items = []; payload = null; status = 'error';
            if (!selected()) store.select(null);
            drawMap(); render(); notifyGeometry();
        }
    }
    async function restoreSelection() {
        if (!restoreId || restoring) return;
        const id = restoreId;
        const found = items.find(item => item.id === id);
        if (found) { select(found.id); return; }
        const city = root.CityConfigManager.getCurrentCityId();
        if (id.startsWith(`built:${city}:`)) {
            const key = id.slice(`built:${city}:`.length);
            const feature = root.buildingFeaturePool?.find(feature => root.buildingPoolFeatureKey(feature) === key);
            if (feature) inspectBuilding(feature, key);
            return;
        }
        if (id.startsWith('proposed:')) {
            const proposal = root.proposalStorage?.getProposal(id.slice('proposed:'.length));
            if (proposal) root.ProposalSelection.select(proposal);
            return;
        }
        const provider = sourceOptions.find(source => id.startsWith(`${source.id}:`));
        if (!provider) return;
        restoring = true;
        try {
            const records = await sourceRecord({ recordId: id.slice(provider.id.length + 1), city, providerId: provider.id, scenario: scenarioParam() });
            if (restoreId === id) { const record = records.find(item => item.id === id); if (record) selectRecord(record); }
        } catch (error) { console.error('[planning] Could not restore source selection', error); }
        finally { restoring = false; }
    }
    function viewportBbox() {
        const bounds = root.map?.getBounds?.();
        return bounds ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] : null;
    }
    async function listSources(city, bbox) {
        const url = new URL(`${root.getBackendBase()}/planning/sources`);
        url.searchParams.set('city', city);
        if (bbox) url.searchParams.set('bbox', bbox.join(','));
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Planning sources HTTP ${response.status}`);
        const answer = await response.json();
        if (answer.city !== city || !Array.isArray(answer.sources)) throw new Error('Invalid planning sources response');
        return answer.sources;
    }
    function applySources(sources, requested) {
        sourceOptions = sources;
        const input = panel.querySelector('.planning-source-select'); input.replaceChildren();
        for (const source of sourceOptions) input.add(new Option(source.label, source.id));
        sourceId = sourceOptions.find(source => source.id === (requested || sourceId))?.id || sourceOptions.find(source => source.default)?.id || '';
        populateScenarios(scenarioId || new URLSearchParams(location.search).get('planningScenario'));
    }
    // Re-list sources for a moved viewport (about one kilometre of movement). Returns false when a
    // newer listing superseded this one; the listing itself is a cheap in-memory lookup server-side.
    async function ensureSources(city, bbox) {
        const key = core.queryKey(city, bbox.map(value => Math.round(value * 100) / 100));
        if (key === sourcesKey) return true;
        const generation = ++sourceGeneration;
        try {
            const sources = await listSources(city, bbox);
            if (generation !== sourceGeneration) return false;
            sourcesKey = key;
            const previousSource = sourceId, previousScenario = scenarioId;
            if (JSON.stringify(sources.map(source => source.id)) !== JSON.stringify(sourceOptions.map(source => source.id))) applySources(sources);
            if (previousSource !== sourceId || previousScenario !== scenarioId) { pins = {}; loadedKey = ''; render(); }
            return true;
        } catch (error) {
            if (generation !== sourceGeneration) return false;
            console.error('[planning] Could not read providers', error); status = 'error'; render();
            return false;
        }
    }
    async function loadSources() {
        const generation = ++sourceGeneration;
        const city = root.CityConfigManager.getCurrentCityId();
        const bbox = viewportBbox();
        try {
            const sources = await listSources(city, bbox);
            if (generation !== sourceGeneration) return;
            sourcesKey = bbox ? core.queryKey(city, bbox.map(value => Math.round(value * 100) / 100)) : '';
            catalogReady = true;
            scenarioId = '';
            applySources(sources, new URLSearchParams(location.search).get('planningSource'));
            render(); refresh({ force: true }); restoreSelection();
            if (parcelPanel?.container.isConnected) showParcelEvidence(parcelPanel.container, parcelPanel.parcel);
        } catch (error) {
            if (generation !== sourceGeneration) return;
            console.error('[planning] Could not read providers', error); status = 'error'; render();
        }
    }
    // Configured sources offer every housing type plus "all" (rolled per parcel); other sources list their scenarios.
    function populateScenarios(requested) {
        const descriptor = sourceOptions.find(source => source.id === sourceId);
        const scenarios = descriptor?.scenarios || [descriptor?.scenario].filter(Boolean);
        const choices = descriptor?.parcelStudy && scenarios.length > 1 ? [core.ANY_CONFIGURATION, ...scenarios] : scenarios;
        scenarioId = choices.includes(requested) ? requested : choices[0] || '';
        const input = panel.querySelector('.planning-scenario-select'); input.replaceChildren();
        for (const scenario of choices) input.add(new Option(t(`scenario.${scenario}`), scenario));
    }
    function init() {
        if (ready) return;
        let saved = {};
        try { saved = JSON.parse(root.PersistentStorage.getItem('cb_planning_display') || '{}'); } catch (_) { }
        const params = new URLSearchParams(location.search);
        for (const key of Object.keys(core.defaults)) if (params.has(key)) saved[key] = params.get(key);
        store = core.createStore(saved);
        panel = document.getElementById('planning-views');
        inspector = document.getElementById('planning-inspector');
        const body = panel.querySelector('.map-sheet-body');
        const sourceField = element('label', 'planning-source-field');
        sourceField.append(element('span', 'planning-source-label'));
        const sourceInput = element('select', 'planning-layer-select planning-source-select');
        sourceField.append(sourceInput); body.append(sourceField, element('p', 'planning-source-note'));
        const scenarioField = element('label', 'planning-source-field');
        scenarioField.append(element('span', 'planning-scenario-label'));
        const scenarioInput = element('select', 'planning-layer-select planning-scenario-select');
        scenarioField.append(scenarioInput); body.append(scenarioField);
        scenarioInput.addEventListener('change', () => {
            const wasStudy = selected()?.study;
            const previousId = !wasStudy && selected()?.role === 'permitted' ? store.get().selectedId : null;
            root.PlanningParcelStudy?.clear();
            if (wasStudy) store.select(null);
            scenarioId = scenarioInput.value; pins = {}; controller?.abort(); request++; loadedKey = ''; items = []; payload = null;
            if (previousId) { focusedRecord = null; store.select(null); restoreId = previousId; }
            const url = new URL(location.href); url.searchParams.set('planningScenario', scenarioId); history.replaceState(history.state, '', url);
            drawMap(); notifyGeometry(); refresh({ force: true });
        });
        sourceInput.addEventListener('change', () => {
            const clearSourceSelection = selected()?.role === 'permitted' || selected()?.study;
            root.PlanningParcelStudy?.clear();
            sourceId = sourceInput.value; pins = {}; scenarioId = ''; controller?.abort(); request++; loadedKey = ''; items = []; payload = null;
            populateScenarios();
            if (clearSourceSelection) { focusedRecord = null; store.select(null); }
            const url = new URL(location.href); url.searchParams.set('planningSource', sourceId);
            url.searchParams.set('planningScenario', scenarioId); history.replaceState(history.state, '', url);
            drawMap(); notifyGeometry(); refresh({ force: true });
            if (parcelPanel?.container.isConnected) showParcelEvidence(parcelPanel.container, parcelPanel.parcel);
        });
        const controls = panel.querySelector('.planning-layer-controls');
        const details = { existing: 'existingScope', permitted: 'permittedMap', proposed: 'proposedForm' };
        function control(key) {
            const input = element('select', 'planning-layer-select'); input.dataset.planningSetting = key;
            for (const value of core.choices[key]) input.add(new Option(t(value), value));
            input.addEventListener('change', () => store.configure(key, input.value));
            return input;
        }
        for (const role of core.roles) {
            const row = element('div', 'planning-layer-row');
            const label = element('span', 'planning-layer-label'); label.dataset.roleLabel = role;
            const swatch = element('span', `planning-swatch planning-swatch--${role}`); swatch.setAttribute('aria-hidden', 'true');
            const name = element('div', 'planning-layer-name'); name.append(swatch, label);
            row.append(name, control(role), control(details[role])); controls.append(row);
            if (role === 'permitted') row.append(control('permittedForm'));
        }
        const zoningField = element('label', 'planning-source-field planning-zoning-field');
        zoningField.append(element('span', 'planning-zoning-label'), control('zoningAreas')); body.append(zoningField);
        panel.querySelector('.planning-reroll').addEventListener('click', () => store.reroll());
        panel.querySelector('.planning-open-model').addEventListener('click', () => root.requestMapMode('model'));
        panel.querySelector('.planning-view-retry').addEventListener('click', () => refresh({ force: true }));
        root.map.createPane('planningSources');
        root.map.getPane('planningSources').classList.add('planning-sources-pane');
        layer = root.L.featureGroup().addTo(root.map);
        selectionLayer = root.L.featureGroup().addTo(root.map);
        ready = true;
        document.getElementById('planning-views-button').hidden = false;
        store.subscribe(syncView);
        root.map.on('moveend', () => refresh());
        root.map.on('click', () => select(null));
        root.addEventListener('cityChanged', () => {
            root.PlanningParcelStudy?.clear(); selectionPoint = null;
            controller?.abort(); request++; loadedKey = ''; items = []; payload = null; status = 'loading';
            sourceOptions = []; sourceId = ''; scenarioId = ''; pins = {}; sourcesKey = ''; focusedRecord = null; restoreId = null; catalogReady = false; parcelPanel = null;
            store.select(null); drawMap(); render(); notifyGeometry(); loadSources();
        });
        root.addEventListener('proposedBuildingsUpdated', render);
        root.addEventListener('buildingsLayerUpdated', restoreSelection);
        root.addEventListener('i18n:translationsLoaded', render);
        root.addEventListener('mapmodechange', render);
        root.addEventListener('keydown', event => {
            if (event.key === 'Escape' && selected() && !event.defaultPrevented) { select(null); event.preventDefault(); }
        });
        root.whenAppBooted().then(() => {
            root.ProposalSelection?.subscribe(proposal => {
                if (proposal) inspectProposal(proposal);
                else if (selected()?.role === 'proposed') { focusedRecord = null; store.select(null); }
            });
            restoreSelection();
        });
        syncView();
        loadSources();
    }
    root.PlanningViews = { getState: () => store?.get() || { ...core.defaults, variation: '' }, getPolicy: policy, getItems: sceneItems,
        getSelectionPoint: () => selectionPoint?.id === selected()?.id ? selectionPoint : null, getAppearance: appearance,
        refreshStudy({ inspector: updateInspector = true } = {}) { drawMap(); if (updateInspector) renderInspector(); notifyGeometry(); },
        getSelected: selected, isReady: () => ready, isInspecting: () => ready && !inspector.hidden,
        select, selectRecord, inspectBuilding, inspectProposal, showParcelEvidence, color, refresh,
        permittedFeatures, studyScenarioFor, pinConfiguration, getScenario: () => scenarioId,
        configure: (key, value) => store?.configure(key, value), reroll: () => store?.reroll() };
    root.whenMapCoreReady().then(init);
})(window);
