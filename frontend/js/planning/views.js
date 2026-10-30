// One comparison control, source selection and viewport feed for the map and model views.
// Source results are read-only overlays: viewing them never applies a parcel/fabric mutation.
(function (root) {
    'use strict';
    const core = root.PlanningScene, envelopes = root.PlanningEnvelopes;
    const sharedLabels = { focusParcel: 'threeMode.isolation.singleParcel', existing: 'threeMode.controls.built', proposed: 'threeMode.parcelPanel.proposed',
        solid: 'threeMode.controls.stateSolid', ghost: 'threeMode.controls.stateGhost', off: 'threeMode.controls.stateOff',
        surviving: 'threeMode.controls.stateSurviving', removed: 'threeMode.controls.stateRemoved',
        massing: 'threeMode.controls.representationMassing', buildout: 'threeMode.controls.representationBuildOut',
        both: 'threeMode.controls.representationBoth', all: 'activityFeed.all', retry: 'bets.retry', close: 'common.close' };
    const t = (key, params = {}) => root.i18n.t(sharedLabels[key] || `planningViews.${key}`, params);
    let store, items = [], payload = null, status = 'loading', layer, request = 0;
    let panel, inspector, lastSettings = null, lastSelectedId = null, ready = false, selectionLayer;
    let progress = null;
    // The massing shapes drawn on the map, for "what is under this point" (click-stack.md).
    let hitShapes = [];
    // What drawMap last drew per item id: { item, signature, group, hits }.
    const drawnItems = new Map();
    let sourceOptions = [], sourceId = '', scenarioId = '', focusedRecord = null, sourceGeneration = 0, referenceStatus = null;
    let restoreId = new URLSearchParams(location.search).get('planningSelection'), restoring = false, catalogReady = false, parcelPanel = null;
    // Per-item configuration pins chosen in the inspector; cleared with the source, housing type or city.
    let pins = {}, sourcesKey = '';
    const displaySelection = () => ({ variation: store?.get().permittedVariation || '', scenario: scenarioId || envelopes.ANY_CONFIGURATION, pins });
    const scenarioParam = () => scenarioId && scenarioId !== envelopes.ANY_CONFIGURATION ? scenarioId : '';
    const scenarioLabel = id => id ? t(`scenario.${id}`) : '';
    // The API supplies oriented volumes; turf joins their footprints for display.
    const geometryDeps = () => ({ geometry: root.turf });
    const realization = (item, form = store?.get().permittedForm) => ({ form, selection: displaySelection(), deps: geometryDeps() });
    function permittedFeatures(item) { return envelopes.realize(item, realization(item)); }
    const sideWord = (item, edge) => root.i18n.t(`modal.corridor.compass.${envelopes.edgeSide(item.derivation?.parcel, edge)}`);
    const lotNote = configuration => configuration?.lotArea?.status === 'fail' ? t('lotBelowMinimum', { minimum: area(configuration.lotArea.minimumM2) }) : '';
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
    function sceneItems() { return items; }
    function appearance(item) { return core.itemAppearance(item, store?.get()); }
    function selected() { return (focusedRecord?.id === store?.get().selectedId ? focusedRecord : null)
        || sceneItems().find(item => item.id === store?.get().selectedId) || null; }
    function notifyGeometry() { root.dispatchEvent(new CustomEvent('planninggeometrychange')); }
    function select(id) {
        if (!ready) return;
        if (id && !sceneItems().some(item => item.id === id) && focusedRecord?.id !== id) return;
        if (id) {
            const target = focusedRecord?.id === id ? focusedRecord : sceneItems().find(item => item.id === id);
            if (target?.role !== 'proposed') root.ProposalSelection?.clear();
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
        restoreId = null;
        store.select(id);
        renderInspector();
    }
    function selectRecord(record) { focusedRecord = record; referenceStatus = null; select(record?.id || null); }
    // Parcel provenance belongs to the inspected source record, not the global display settings.
    function parcelOf(item) {
        if (!item || item.role !== 'permitted') return null;
        return String(item.sourceEvidence?.parcelReference?.parcelId || item.source?.parcel || '') || null;
    }
    function inspectBuilding(feature, key, { hosted = false } = {}) {
        if (!hosted) return root.ClickStack?.showBuilding?.(feature, key) || false;
        const record = root.PlanningRepresentations.built(feature, { key: key || root.buildingPoolFeatureKey?.(feature),
            city: root.CityConfigManager.getCurrentCityId(), footprintM2: feature.geometry ? root.turf.area(feature) : null,
            title: root.ClickStackHits?.buildingLabel?.(feature) || null,
            sourceName: root.CityConfigManager.getBuildingSources?.().find(source => source.id === feature.properties?.source)?.name || null });
        if (record) { selectRecord(record); return true; }
        return false;
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
        if (!(context.source || sourceId)) return [];
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
        // Saved results exist only for cadastral parcels; a design-formed piece has none to ask for.
        if (root.PersistentStorage.isDerivedParcelId(parcel)) return;
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
                style: root.MapHighlight.style({ fill: false, className: 'planning-site-selection' }) }).addTo(selectionLayer);
        }
        // Each item is drawn into its own group, remembered with what it was drawn from. A redraw
        // replaces only the items whose record or appearance changed and removes the ones gone, so
        // a pan that brings a few parcels does not rebuild every massing on the map.
        const state = store.get();
        const colors = Object.fromEntries(core.roles.map(role => [role, color(role)]));
        const shown = new Set();
        hitShapes = [];
        for (const item of sceneItems()) {
            const display = appearance(item);
            if (display === 'off' || shown.has(item.id)) continue;
            shown.add(item.id);
            const signature = JSON.stringify([display, state.permittedMap, state.permittedForm, state.permittedVariation,
                scenarioId, pins[item.id] || null, item.id === state.selectedId, colors[item.role]]);
            const previous = drawnItems.get(item.id);
            if (previous && previous.item === item && previous.signature === signature) {
                hitShapes.push(...previous.hits);
                continue;
            }
            if (previous) layer.removeLayer(previous.group);
            const group = root.L.featureGroup().addTo(layer);
            const hits = drawItem(item, display, group);
            drawnItems.set(item.id, { item, signature, group, hits });
            hitShapes.push(...hits);
        }
        for (const [id, entry] of drawnItems) {
            if (shown.has(id)) continue;
            layer.removeLayer(entry.group);
            drawnItems.delete(id);
        }
    }
    // One item's massing shapes, added to `group`; returns its click-stack hit shapes.
    function drawItem(item, display, group) {
        const hits = [];
        let features;
        try { features = envelopes.mapFeatures(item, { detail: store.get().permittedMap, ...realization(item) }); }
        catch (error) { console.error('[planning] Could not project massing', item.id, error); return hits; }
        const hasBody = features.some(feature => feature.properties.geometryRole !== 'bound');
        for (const feature of features) {
            const active = item.id === store.get().selectedId;
            // The outer bound behind a shown configuration is a hull: outline plus a faint fill.
            const hull = feature.properties.geometryRole === 'bound' && hasBody;
            // A tier only an incentive's condition reaches is a fainter, sparser outline.
            const conditional = Boolean(feature.properties.condition);
            // The hull is not a second click target: the configuration inside carries the interaction.
            const shape = root.L.geoJSON(feature, { pane: 'planningSources', className: hull ? 'planning-bound-outline' : undefined, interactive: !hull,
                style: { color: active ? root.MapHighlight.color : color(item.role), weight: active ? 4 : hull || conditional ? 1 : 1.5, dashArray: conditional ? '2 6' : hull ? '4 4' : null,
                    fillColor: color(item.role), fillOpacity: conditional ? 0.03 : hull ? 0.06 : display === 'solid' ? 1 : 0.18,
                    opacity: conditional ? 0.6 : hull ? 0.8 : 1 } });
            const label = item.source.parcel || item.title;
            shape.addTo(group);
            // The assumed street side of the shown configuration, so a roll reads as a choice, not a glitch.
            if (feature.properties.frontEdge != null && item.derivation?.parcel) {
                const ring = item.derivation.parcel.coordinates[0], edge = feature.properties.frontEdge;
                root.L.polyline([ring[edge], ring[edge + 1]].map(p => [p[1], p[0]]), { pane: 'planningSources', interactive: false,
                    color: color(item.role), weight: 4, opacity: 0.9 }).addTo(group);
            }
            if (hull) continue;
            const inspect = () => { if (!root.__mapEditLock?.isHeld()) select(item.id); };
            // A massing click is a map click: the click stack shows it with everything else
            // under the point (click-stack.md) and selects it when its section expands.
            shape.on('click', event => {
                // Editing and measurement need this event to reach the map. A passive massing
                // overlay must not consume it before the active tool can place its geometry.
                if (root.__mapEditLock?.blocksSelection({ allowUrbanBlocks: true })) return;
                root.L.DomEvent.stopPropagation(event);
                if (!root.__mapEditLock?.isHeld()) root.ClickStack.handleClick(event.latlng, { allowUrbanBlocks: true });
            });
            hits.push({ item, feature });
            shape.eachLayer(part => {
                const node = part.getElement?.();
                if (!node) return;
                node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button');
                node.setAttribute('aria-label', t(item.areas?.length ? 'inspectArea' : 'inspectMassing', { parcel: label }));
                node.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); inspect(); }
                });
            });
        }
        return hits;
    }
    function isPhoto() { return root.__mapModeState?.desired === 'photo'; }
    function stateText() {
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
        const hostedBuilt = item?.role === 'existing' && inspector.classList.contains('is-hosted');
        inspector.hidden = !item || item.role === 'proposed' || (item.role === 'existing' && !hostedBuilt);
        inspector.replaceChildren();
        if (!item || item.role === 'proposed' || (item.role === 'existing' && !hostedBuilt)) return;
        const header = element('header', 'planning-inspector__header');
        const heading = element('div');
        const sourceResult = item.role === 'permitted';
        heading.append(element('p', 'planning-eyebrow', item.parcelEnvelope ? t('envelopeTitle')
            : t(item.areas?.length ? 'zoningArea' : sourceResult ? (item.volumes.length ? 'sourceProposal' : 'savedResult') : 'builtRecord')));
        if (item.title) heading.append(element('h2', 'click-stack__title', item.title));
        // A parcel's massing names its parcel; the title alone is the source edition and ratio.
        const parcelLabel = parcelOf(item);
        if (parcelLabel) heading.append(element('p', 'planning-inspector__parcel', `${t('focusParcel')} ${parcelLabel}`));
        const close = element('button', 'close-circle-btn', '×');
        close.type = 'button'; close.setAttribute('aria-label', t('close'));
        close.addEventListener('click', () => { select(null); document.getElementById('planning-views-button').focus(); });
        header.append(heading, close);
        inspector.append(header);
        const badges = element('div', 'planning-inspector__badges');
        badges.append(element('span', 'cb-badge', t(inspectorBadgeKey(item))));
        if (sourceResult && item.volumes.length) badges.append(element('span', 'cb-badge cb-badge--warning',
            t(item.assessment.meaning === 'existing-stock-estimate' ? 'stockBadge' : item.parcelEnvelope ? 'bound' : 'approximate')));
        if (item.assessment.refresh) badges.append(element('span', 'cb-badge cb-badge--warning', t('refreshPending')));
        inspector.append(badges);
        inspector.append(element('p', 'planning-inspector__description',
            t(item.assessment.meaning === 'existing-stock-estimate' ? 'stockEstimate'
                : item.assessment.meaning === 'public-screen' ? 'evidenceOnly'
                    : item.assessment.meaning === 'zoning-area' ? 'zoningAreaNote'
                        : item.parcelEnvelope ? 'envelopeNote'
                        : sourceResult ? (item.volumes.length ? 'oneOption' : 'savedNoShape')
                        : 'observedNote')));
        if (item.assessment.status && !item.parcelEnvelope) inspector.append(element('p', 'planning-inspector__description', resultLabel(item.assessment.status)));
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
        // An incentive's extra height is listed with its condition, apart from what the rules grant.
        if (item.metrics.conditional?.heightM != null) displayedMetrics.push([t('conditionalHeight'),
            `${root.CbFormat.formatLength(item.metrics.conditional.heightM, { maxFractionDigits: 1 })} · ${item.metrics.conditional.condition}`]);
        if (unitLimit != null) displayedMetrics.push([t('dwellingLimit'), number(unitLimit)]);
        if (item.metrics.footprintM2 != null) displayedMetrics.push([t('footprintArea'), area(item.metrics.footprintM2)]);
        for (const [label, value] of displayedMetrics) {
            const entry = element('div'); entry.append(element('dt', '', label), element('dd', '', value)); metrics.append(entry);
        }
        if (displayedMetrics.length) inspector.append(metrics);
        const heights = [...new Set(item.volumes.map(volume => volume.topM))].sort((a, b) => a - b);
        if (heights.length > 1) inspector.append(element('p', 'planning-inspector__description', t('heightParts', { heights: heights.map(height => root.CbFormat.formatLength(height)).join(' · ') })));
        const realization = permittedFeatures(item), shown = realization.configuration;
        if (item.configurations?.length) inspector.append(renderConfigurations(item, shown));
        if (realization.frontEdge != null) {
            inspector.append(element('p', 'planning-inspector__description', t('assumedSide', { side: sideWord(item, realization.frontEdge) })));
            const frontage = root.StreetFrontage?.basisText(item.sourceEvidence?.frontage);
            if (frontage) inspector.append(element('p', 'planning-inspector__description', frontage));
        }
        const assessment = element('div', 'planning-assessment');
        assessment.append(element('strong', '', t('conditionsTitle')), element('p', '', t('conditionsNote')));
        if (sourceResult && item.volumes.length) inspector.append(assessment);
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
        for (const reference of item.sourceEvidence?.sourceReferences || []) {
            const button = element('button', 'btn', t('referencedSource', { source: reference.providerId, revision: reference.revision.slice(0, 8) }));
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
        inspector.append(footer);
    }
    // Every source configuration, with the shown one marked. Picking one pins the housing type;
    // the dice varies the sample building without changing that choice.
    function renderConfigurations(item, shown) {
        const section = element('section', 'planning-configurations');
        section.append(element('h3', '', t('configurationsTitle')));
        const list = element('ul', 'planning-configurations__list');
        for (const configuration of item.configurations) {
            const row = element('li'); row.dataset.configuration = configuration.id;
            const button = element('button', 'btn planning-configurations__pick'); button.type = 'button';
            button.setAttribute('aria-pressed', String(shown?.id === configuration.id));
            button.setAttribute('aria-label', `${t('configurationShow')}: ${scenarioLabel(configuration.id)}`);
            button.append(element('strong', '', scenarioLabel(configuration.id)), element('span', '', resultLabel(configuration.treatment)));
            const measure = configuration.unavailableReason ? t(`envelopeUnavailable.${configuration.unavailableReason}`)
                : `${root.CbFormat.formatLength(configuration.metrics.heightM, { maxFractionDigits: 1 })} · ${area(configuration.metrics.footprintM2)}`;
            button.append(element('span', 'planning-configurations__measure', measure));
            if (lotNote(configuration)) button.append(element('span', 'cb-badge cb-badge--warning', lotNote(configuration)));
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
    // The Buildings and massing button's rim: a third of a circle in a role's colour for each role
    // still loading (planning/loading.js) while it is shown. Permitted also counts this module's
    // own viewport read.
    function paintLoading() {
        const button = document.getElementById('planning-views-button');
        if (!store || !button) return;
        let ring = button.querySelector('.planning-loading-ring');
        if (!ring) {
            const ns = 'http://www.w3.org/2000/svg';
            ring = document.createElementNS(ns, 'svg');
            ring.setAttribute('class', 'planning-loading-ring'); ring.setAttribute('viewBox', '0 0 40 40');
            ring.setAttribute('aria-hidden', 'true'); ring.setAttribute('focusable', 'false');
            for (const role of core.roles) {
                const arc = document.createElementNS(ns, 'circle');
                arc.setAttribute('class', `planning-loading-arc planning-loading-arc--${role}`);
                arc.setAttribute('cx', '20'); arc.setAttribute('cy', '20'); arc.setAttribute('r', '19'); arc.setAttribute('pathLength', '3');
                arc.dataset.role = role; ring.append(arc);
            }
            button.append(ring);
        }
        const view = policy();
        const shown = { existing: view.existing !== 'off', permitted: view.permitted !== 'off' || store.get().zoningAreas !== 'off', proposed: view.proposed !== 'off' };
        const loading = { ...root.PlanningLoading.state() };
        loading.permitted ||= status === 'loading';
        const arcs = core.loadingArcs(loading, shown);
        for (const arc of ring.querySelectorAll('.planning-loading-arc')) {
            const slot = arcs.find(entry => entry.role === arc.dataset.role)?.slot;
            if (slot === undefined) arc.removeAttribute('data-slot'); else arc.dataset.slot = String(slot);
        }
        ring.classList.toggle('is-loading', arcs.length > 0);
        button.setAttribute('aria-busy', String(arcs.length > 0));
    }
    function render() {
        paintLoading();
        if (!ready) return;
        panel.querySelector('.map-sheet-title').textContent = t('title');
        panel.querySelector('.planning-source-label').textContent = t('sourceEdition');
        const sourceSelect = panel.querySelector('.planning-source-select');
        sourceSelect.setAttribute('aria-label', t('sourceEdition'));
        sourceSelect.value = sourceId;
        sourceSelect.disabled = sourceOptions.length < 2;
        const descriptor = sourceOptions.find(source => source.id === sourceId);
        const noPermittedSource = catalogReady && !descriptor;
        sourceSelect.parentElement.hidden = !descriptor;
        const permittedRow = panel.querySelector('[data-role-label="permitted"]').closest('.planning-layer-row');
        permittedRow.classList.toggle('is-unavailable', !descriptor);
        permittedRow.setAttribute('aria-disabled', String(!descriptor));
        permittedRow.title = noPermittedSource ? t('noPermittedSource') : '';
        permittedRow.querySelectorAll('select').forEach(input => { input.disabled = !descriptor; });
        panel.querySelector('.planning-source-note').hidden = !descriptor;
        panel.querySelector('.planning-coverage').hidden = !descriptor;
        const mapContext = panel.querySelector('.planning-map-context');
        mapContext.hidden = !!root.__mapModeState?.desired && root.__mapModeState.desired !== '2d';
        mapContext.textContent = t('mapContext');
        panel.querySelector('.planning-source-note').textContent = descriptor?.parcelStudy ? t('envelopeNote') : descriptor?.capabilities.areas ? t('zoningAreaNote')
            : descriptor?.capabilities.volumes === false ? t('evidenceOnly') : '';
        panel.querySelector('.planning-zoning-label').textContent = t('zoningAreas');
        panel.querySelector('.planning-zoning-field').hidden = !descriptor?.capabilities.areas;
        const scenario = panel.querySelector('.planning-scenario-select');
        scenario.value = scenarioId; scenario.setAttribute('aria-label', t('scenarioLabel'));
        panel.querySelector('.planning-scenario-label').textContent = t('scenarioLabel');
        scenario.parentElement.hidden = !(descriptor?.scenarios?.length > 1);
        for (const option of scenario.options) option.textContent = t(`scenario.${option.value}`);
        // A change that re-reads the viewport shows its wait beside the control it came from.
        for (const field of [scenario, sourceSelect]) field.parentElement.setAttribute('aria-busy', String(status === 'loading'));
        for (const reroll of panel.querySelectorAll('[data-planning-reroll]')) {
            const role = reroll.dataset.planningReroll;
            reroll.title = t(`reroll.${role}`); reroll.setAttribute('aria-label', reroll.title);
            reroll.disabled = policy()[role] === 'off' || (role === 'permitted' && !descriptor?.parcelStudy);
        }
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
        // Keep the same representation control in every row. A source with one calculated option
        // offers only Illustration, without replacing the person's preference for richer sources.
        const permittedForm = panel.querySelector('[data-planning-setting="permittedForm"]');
        const permittedControl = core.permittedRepresentationControl(descriptor, store.get().permittedForm);
        if (Array.from(permittedForm.options, option => option.value).join(',') !== permittedControl.values.join(',')) {
            permittedForm.replaceChildren(...permittedControl.values.map(value => new Option(t(value), value)));
        }
        permittedForm.value = permittedControl.value;
        permittedForm.hidden = false;
        permittedForm.disabled = permittedControl.disabled;
        panel.querySelector('[data-planning-setting="permittedMap"]').hidden = !descriptor || root.__mapModeState?.desired === 'model' || isPhoto()
            || descriptor?.capabilities.volumes === false;
        panel.querySelector('.planning-view-status').hidden = noPermittedSource;
        panel.querySelector('.planning-view-status').textContent = noPermittedSource ? '' : stateText();
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
        panel.querySelector('.planning-inspect-hint').hidden = policy().permitted === 'off' || !items.length;
        const model = panel.querySelector('.planning-open-model');
        model.hidden = !isPhoto(); model.textContent = t('openModel');
        renderInspector();
    }
    function syncView() {
        const state = store.get();
        const view = policy();
        document.body.dataset.planningProposed = view.proposed;
        document.body.dataset.planningExisting = view.existing;
        document.body.dataset.planningPermitted = view.permitted;
        document.body.dataset.planningExistingScope = state.existingScope;
        const signature = JSON.stringify({ ...core.settings(state), proposedVariation: state.proposedVariation, permittedVariation: state.permittedVariation });
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
            if (previous.proposedForm !== state.proposedForm || previous.proposedVariation !== state.proposedVariation) {
                root.updateProposedBuildingsLayer?.({ announce: false });
            }
            root.dispatchEvent(new CustomEvent('planningviewchange', { detail: { settings: core.settings(state), policy: view } }));
        }
        drawMap(); render();
        if (lastSelectedId !== state.selectedId) {
            lastSelectedId = state.selectedId;
            const url = new URL(location.href);
            // A building or permitted volume is named here; a design by ?design= (selection-address.js).
            if (state.selectedId && !state.selectedId.startsWith('proposed:')) url.searchParams.set('planningSelection', state.selectedId);
            else url.searchParams.delete('planningSelection');
            if (sourceId) url.searchParams.set('planningSource', sourceId);
            if (scenarioId) url.searchParams.set('planningScenario', scenarioId);
            history.replaceState(history.state, '', url);
            root.dispatchEvent(new CustomEvent('planningselectionchange', { detail: { id: state.selectedId } }));
        }
        if (settingsChanged && (view.permitted !== 'off' || state.zoningAreas !== 'off')) refresh();
    }
    // Two viewport answers: envelopes do not depend on the housing type (every configuration ships
    // with the item), zoning areas do. A housing-type change therefore redraws the envelopes at
    // once and re-reads only the areas, when they are shown. Each answer comes from `viewCache`,
    // which keeps recent areas asked for (snapped to the viewport grid), so a pan inside an
    // answered area or back to one asks for nothing; Retry and a source re-read clear it.
    const viewCache = core.createViewportCache({ limit: 64, maxAgeMs: 10 * 60 * 1000 });
    // The API's area limits (backend/routes/planning.js validateBounds): a larger view is answered
    // 400 (over 1,000 lots), shown as "zoom in". Snapping never pushes a view over them; a view already over one asks
    // for nothing, since the answer is known.
    const MAX_AREA_KM2 = { envelopes: 0.5, areas: 4 };
    const MOVE_REFRESH_DELAY_MS = 300;
    let areaCache = { key: '', answer: null }, envelopeCache = { key: '', answer: null }, assembled = '';
    function invalidate() { areaCache = { key: '', answer: null }; envelopeCache = { key: '', answer: null }; assembled = ''; }
    // The area to ask for: the view snapped to whole cells, or the view itself where snapping would
    // cross the endpoint's area limit.
    function requestBox(kind, bbox) {
        const snapped = core.snapBbox(bbox);
        return core.bboxAreaKm2(snapped) <= MAX_AREA_KM2[kind] ? snapped : bbox;
    }
    function tooLarge(error) { return Object.assign(new Error('Planning view area is too large'), { status: 400, cause: error }); }
    async function refresh({ force = false } = {}) {
        if (!ready || !catalogReady || policy().permitted === 'off' && store.get().zoningAreas === 'off') return;
        if (root.map.getZoom() < 16) {
            viewCache.abortExcept([]); request++; invalidate(); items = []; status = 'zoom'; payload = null;
            if (!selected()) store.select(null);
            drawMap(); render(); notifyGeometry(); return;
        }
        const city = root.CityConfigManager.getCurrentCityId();
        const bounds = root.map.getBounds();
        const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
        if (force) viewCache.clear();
        // Bounds-registered sources come and go with the viewport; re-list them when it moves.
        if (!(await ensureSources(city, bbox))) return;
        const descriptor = sourceOptions.find(source => source.id === sourceId);
        const envelopeScope = descriptor?.parcelStudy && policy().permitted !== 'off' ? `envelopes:${city}:${sourceId}` : '';
        const areaScope = descriptor && (!descriptor.capabilities.areas || store.get().zoningAreas !== 'off') ? `areas:${city}:${sourceId}:${scenarioId}` : '';
        if (force) invalidate();
        if (!envelopeScope) envelopeCache = { key: '', answer: null };
        if (!areaScope) areaCache = { key: '', answer: null };
        const wanted = [];
        if (envelopeScope) wanted.push({ kind: 'envelopes', scope: envelopeScope });
        if (areaScope) wanted.push({ kind: 'areas', scope: areaScope });
        const generation = ++request;
        const fail = error => {
            if (generation !== request || error.name === 'AbortError') return;
            if (error.status === 400) {
                invalidate(); items = []; payload = null; status = 'zoom';
                if (!selected()) store.select(null);
                drawMap(); render(); notifyGeometry(); return;
            }
            console.error('[planning] Could not load source representations', error);
            invalidate(); items = []; payload = null; status = 'error';
            if (!selected()) store.select(null);
            drawMap(); render(); notifyGeometry();
        };
        const oversized = wanted.find(({ kind }) => core.bboxAreaKm2(bbox) > MAX_AREA_KM2[kind]);
        if (oversized) { viewCache.abortExcept([]); fail(tooLarge()); return; }
        const show = (kind, entry) => {
            if (kind === 'areas') areaCache = { key: entry.key, answer: entry.value };
            else envelopeCache = { key: entry.key, answer: entry.value };
        };
        const pending = wanted.filter(want => {
            const hit = viewCache.find(want.scope, bbox);
            if (hit) show(want.kind, hit);
            return !hit;
        });
        const composition = () => `${envelopeScope ? envelopeCache.key : ''}|${areaScope ? areaCache.key : ''}`;
        const assemble = () => {
            const answers = [areaCache.answer, envelopeCache.answer].filter(Boolean);
            const answer = envelopeCache.answer || areaCache.answer || { sources: descriptor ? [descriptor] : [], summaries: [], unavailable: [], omitted: 0, items: [] };
            payload = { ...answer, items: answers.flatMap(entry => entry.items) }; items = payload.items; status = 'ready'; assembled = composition();
            if (!selected()) store.select(null);
            drawMap(); render(); notifyGeometry();
        };
        if (!pending.length) { viewCache.abortExcept([]); if (assembled !== composition()) assemble(); return; }
        const url = new URL(`${root.getBackendBase()}/planning/representations`);
        url.searchParams.set('city', city);
        if (sourceId) url.searchParams.set('source', sourceId);
        const scenario = scenarioParam();
        const fetchArea = (kind, box) => signal => {
            const target = new URL(url); target.searchParams.set('bbox', box.join(','));
            if (kind === 'envelopes') target.pathname = '/planning/envelopes';
            else if (scenario) target.searchParams.set('scenario', scenario);
            return root.PlanningFeed.loadViewport(target, { city, signal,
                onProgress(value) { if (generation === request) { progress = value; render(); } } })
                .then(answer => (kind === 'envelopes' ? { ...answer, envelopes: true } : answer));
        };
        // A snapped area the source refuses (too many parcels in it) is asked again as the view
        // itself, which is what was asked before snapping; that answer is kept for that view only.
        const loadKind = async ({ kind, scope }) => {
            const box = requestBox(kind, bbox);
            try { return await viewCache.load(scope, box, fetchArea(kind, box)); }
            catch (error) {
                if (error.status !== 400 || box === bbox) throw error;
                return viewCache.load(scope, bbox, fetchArea(kind, bbox));
            }
        };
        // Only the requests this view still wants keep running; an older view's others stop.
        viewCache.abortExcept(pending.map(({ kind, scope }) => viewCache.keyOf(scope, requestBox(kind, bbox))));
        status = 'loading'; progress = null; render();
        try {
            await Promise.all(pending.map(want => loadKind(want).then(entry => { if (generation === request) show(want.kind, entry); })));
            if (generation !== request) return;
            assemble();
            restoreSelection();
        } catch (error) { fail(error); }
    }
    async function restoreSelection() {
        if (!restoreId || restoring) return;
        const id = restoreId;
        // A reload with the view in its address (?at=) reopens the selection without moving the camera.
        const keepView = !!root.SelectionAddress?.keepsView();
        if (keepView) root.ClickStack?.keepNextView();
        try { await reopenSelection(id); } finally { if (keepView) root.ClickStack?.keepNextView(false); }
    }
    async function reopenSelection(id) {
        const found = items.find(item => item.id === id);
        if (found) { select(found.id); return; }
        const city = root.CityConfigManager.getCurrentCityId();
        if (id.startsWith(`built:${city}:`)) {
            const key = id.slice(`built:${city}:`.length);
            const feature = root.buildingFeaturePool?.find(feature => root.buildingPoolFeatureKey(feature) === key);
            if (feature) inspectBuilding(feature, key);
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
        if (!Array.isArray(answer.sources)) throw new Error('Invalid planning sources response');
        const configured = root.CityConfigManager.getCityConfig(city)?.planning?.sourceIds || [];
        return configured.map(id => answer.sources.find(source => source.id === id)).filter(Boolean)
            .map((source, index) => ({ ...source, default: index === 0 }));
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
    // Listings are kept per rounded area, so panning back across a rounding edge re-lists nothing.
    const sourceListings = core.createViewportCache({ limit: 64, maxAgeMs: 10 * 60 * 1000 });
    async function ensureSources(city, bbox) {
        const rounded = bbox.map(value => Math.round(value * 100) / 100);
        const key = core.queryKey(city, rounded);
        if (key === sourcesKey) return true;
        const generation = ++sourceGeneration;
        try {
            const sources = (await sourceListings.load(city, rounded, () => listSources(city, bbox))).value;
            if (generation !== sourceGeneration) return false;
            sourcesKey = key;
            const previousSource = sourceId, previousScenario = scenarioId;
            if (JSON.stringify(sources.map(source => source.id)) !== JSON.stringify(sourceOptions.map(source => source.id))) applySources(sources);
            if (previousSource !== sourceId || previousScenario !== scenarioId) { pins = {}; invalidate(); render(); }
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
            // Kept like the moved-viewport listings, so returning to this area later re-lists nothing.
            const rounded = bbox ? bbox.map(value => Math.round(value * 100) / 100) : null;
            const sources = rounded ? (await sourceListings.load(city, rounded, () => listSources(city, bbox))).value : await listSources(city, bbox);
            if (generation !== sourceGeneration) return;
            sourcesKey = rounded ? core.queryKey(city, rounded) : '';
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
    // Configured sources offer every housing type plus "all" (chosen per parcel); other sources list their scenarios.
    function populateScenarios(requested) {
        const descriptor = sourceOptions.find(source => source.id === sourceId);
        const scenarios = descriptor?.scenarios || [descriptor?.scenario].filter(Boolean);
        const choices = descriptor?.parcelStudy && scenarios.length > 1 ? [envelopes.ANY_CONFIGURATION, ...scenarios] : scenarios;
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
        // The Display tab holds the layer controls; the Compare tab is three-compare.js's.
        const body = panel.querySelector('[data-planning-tab-panel="display"]') || panel.querySelector('.map-sheet-body');
        body.prepend(element('p', 'planning-map-context'));
        const sourceField = element('label', 'planning-source-field');
        sourceField.append(element('span', 'planning-source-label'));
        const sourceInput = element('select', 'planning-layer-select planning-source-select');
        sourceField.append(sourceInput); body.append(sourceField, element('p', 'planning-source-note'));
        const scenarioField = element('label', 'planning-source-field');
        scenarioField.append(element('span', 'planning-scenario-label'));
        const scenarioInput = element('select', 'planning-layer-select planning-scenario-select');
        scenarioField.append(scenarioInput); body.append(scenarioField);
        scenarioInput.addEventListener('change', () => {
            // Envelopes keep their selection: they carry every housing type and only redraw. A
            // selected zoning area is re-read for the new type and re-selected when it returns.
            const previousId = selected()?.areas?.length ? store.get().selectedId : null;
            scenarioId = scenarioInput.value; pins = {};
            areaCache = { key: '', answer: null }; assembled = ''; items = items.filter(item => item.parcelEnvelope);
            if (previousId) { focusedRecord = null; store.select(null); restoreId = previousId; }
            const url = new URL(location.href); url.searchParams.set('planningScenario', scenarioId); history.replaceState(history.state, '', url);
            drawMap(); render(); notifyGeometry(); refresh();
        });
        sourceInput.addEventListener('change', () => {
            const clearSourceSelection = selected()?.role === 'permitted';
            sourceId = sourceInput.value; pins = {}; scenarioId = ''; viewCache.abortExcept([]); request++; invalidate(); items = []; payload = null;
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
        for (const role of ['permitted', 'existing', 'proposed']) {
            const row = element('div', 'planning-layer-row');
            const label = element('span', 'planning-layer-label'); label.dataset.roleLabel = role;
            const swatch = element('span', `planning-swatch planning-swatch--${role}`); swatch.setAttribute('aria-hidden', 'true');
            const name = element('div', 'planning-layer-name'); name.append(swatch, label);
            const content = element('div', 'planning-layer-detail');
            content.append(control(details[role]));
            if (role === 'permitted') content.append(control('permittedForm'));
            const actions = element('div', 'planning-layer-actions');
            const reroll = panel.querySelector(`[data-planning-reroll="${role}"]`);
            if (reroll) actions.append(reroll);
            row.append(name, control(role), content, actions); controls.append(row);
        }
        const zoningField = element('label', 'planning-source-field planning-zoning-field');
        zoningField.append(element('span', 'planning-zoning-label'), control('zoningAreas')); body.append(zoningField);
        // Paint the shared busy ring before re-derivation, including with reduced motion, and
        // keep it until the resulting 3D frame has landed. Prevent overlapping rolls.
        for (const reroll of panel.querySelectorAll('[data-planning-reroll]')) {
            const role = reroll.dataset.planningReroll;
            reroll.addEventListener('click', async () => {
                if (root.BusyControl.isBusy(reroll)) return;
                try { await root.BusyControl.track(reroll, async () => {
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    store.reroll(role);
                    if (root.isThreeModeActive?.()) await root.ThreeSceneReady.wait({ requireExisting: false });
                    else await new Promise(requestAnimationFrame);
                }); } catch (error) { console.error('[planning] Could not finish housing type roll', error); }
            });
        }
        panel.querySelector('.planning-open-model').addEventListener('click', () => root.requestMapMode('model'));
        panel.querySelector('.planning-view-retry').addEventListener('click', () => refresh({ force: true }));
        root.map.createPane('planningSources');
        root.map.getPane('planningSources').classList.add('planning-sources-pane');
        layer = root.L.featureGroup().addTo(root.map);
        selectionLayer = root.L.featureGroup().addTo(root.map);
        ready = true;
        document.getElementById('planning-views-button').hidden = false;
        store.subscribe(syncView);
        // A pan is a burst of moveends: re-read once the map has settled, and not at all when it
        // moves again first. A request already in flight is cancelled by the next refresh that no
        // longer wants it.
        let moveTimer = null;
        const cancelMoveRefresh = () => { if (moveTimer) clearTimeout(moveTimer); moveTimer = null; };
        root.map.on('movestart', cancelMoveRefresh);
        root.map.on('moveend', () => {
            cancelMoveRefresh();
            moveTimer = setTimeout(() => { moveTimer = null; refresh(); }, MOVE_REFRESH_DELAY_MS);
        });
        root.map.on('click', () => select(null));
        root.addEventListener('cityChanged', () => {
            viewCache.clear(); sourceListings.clear(); request++; invalidate(); items = []; payload = null; status = 'loading';
            sourceOptions = []; sourceId = ''; scenarioId = ''; pins = {}; sourcesKey = ''; focusedRecord = null; restoreId = null; catalogReady = false; parcelPanel = null;
            store.select(null); drawMap(); render(); notifyGeometry(); loadSources();
        });
        root.addEventListener('proposedBuildingsUpdated', render);
        root.addEventListener('buildingsLayerUpdated', restoreSelection);
        root.addEventListener('i18n:translationsLoaded', render);
        root.addEventListener('mapmodechange', render);
        root.addEventListener('planningloadingchange', paintLoading);
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
    root.PlanningViews = { getState: () => store?.get() || { ...core.defaults, proposedVariation: '', permittedVariation: '' }, getPolicy: policy, getItems: sceneItems,
        getAppearance: appearance,
        getSelected: selected, isReady: () => ready, isInspecting: () => ready && !inspector.hidden,
        select, selectRecord, inspectBuilding, inspectProposal, showParcelEvidence, color, refresh,
        permittedFeatures, pinConfiguration, getScenario: () => scenarioId,
        // Drawn records covering a point, each once, in drawing order.
        itemsAt(latlng) {
            const point = root.turf.point([latlng.lng, latlng.lat]), seen = new Set();
            return hitShapes.filter(({ item, feature }) => {
                if (seen.has(item.id)) return false;
                try { if (!root.turf.booleanPointInPolygon(point, feature)) return false; } catch (_) { return false; }
                seen.add(item.id); return true;
            }).map(({ item }) => item);
        },
        selectAt: select,
        configure: (key, value) => store?.configure(key, value), reroll: role => store?.reroll(role) };
    root.whenMapCoreReady().then(init);
})(window);
