// One comparison control, source selection and viewport feed for the map and model views.
// Source results are read-only overlays: viewing them never applies a parcel/fabric mutation.
(function (root) {
    'use strict';
    const core = root.PlanningScene, envelopes = root.PlanningEnvelopes, labels = root.PlanningItemLabels;
    const sharedLabels = { focusParcel: 'threeMode.isolation.singleParcel', existing: 'threeMode.controls.built', proposed: 'threeMode.parcelPanel.proposed',
        solid: 'threeMode.controls.stateSolid', ghost: 'threeMode.controls.stateGhost', off: 'threeMode.controls.stateOff',
        surviving: 'threeMode.controls.stateSurviving', removed: 'threeMode.controls.stateRemoved',
        massing: 'threeMode.controls.representationMassing', buildout: 'threeMode.controls.representationBuildOut',
        both: 'threeMode.controls.representationBoth', all: 'activityFeed.all', retry: 'bets.retry', close: 'common.close' };
    const t = (key, params = {}) => root.i18n.t(sharedLabels[key] || `planningViews.${key}`, params);
    const readPermittedJson = response => root.PlanningLoading.readJson('permitted', response);
    let store, items = [], payload = null, status = 'loading', layer, request = 0;
    let panel, inspector, zoningPanel, lastSettings = null, lastSelectedId = null, ready = false, selectionLayer;
    let progress = null;
    // The massing shapes drawn on the map, for "what is under this point" (click-stack.md).
    let hitShapes = [];
    // What drawMap last drew per item id: { item, signature, group, hits }.
    const drawnItems = new Map();
    let sourceBoundaryLayer = null;
    let sourceOptions = [], sourceId = '', scenarioId = '', focusedRecord = null, sourceGeneration = 0, referenceStatus = null;
    let restoreId = new URLSearchParams(location.search).get('planningSelection'), restoring = false, catalogReady = false, parcelPanel = null;
    // Per-item configuration pins chosen in the inspector; cleared with the source, housing type or city.
    let pins = {}, sourcesKey = '';
    let overviewSourceId = '', overviewOnly = false, overview = null, overviewRead = null, overviewLayer = null, overviewDisplay = '';
    const overviewSource = source => root.ZoningOverview?.supports(source);
    const showingOverview = () => overview?.sourceId === sourceId && store.get().zoningAreas !== 'off'
        && (root.__mapModeState?.desired ?? '2d') === '2d';
    // A source that is a zoning map shows its zones when chosen, unless the address or the person
    // already chose whether zones show.
    let zoningChosen = new URLSearchParams(location.search).has('zoningAreas');
    function showZoningMap(previousSource) {
        const descriptor = sourceOptions.find(source => source.id === sourceId);
        if (!zoningChosen && sourceId !== previousSource && descriptor?.coverage === 'zoning-areas') store.configure('zoningAreas', 'ghost');
    }
    const displaySelection = () => ({ variation: store?.get().permittedVariation || '', scenario: scenarioId || envelopes.ANY_CONFIGURATION, pins });
    const scenarioParam = () => scenarioId && scenarioId !== envelopes.ANY_CONFIGURATION ? scenarioId : '';
    const scenarioLabel = id => id ? t(`scenario.${id}`) : '';
    // The API supplies oriented volumes; turf joins their footprints for display.
    const geometryDeps = () => ({ geometry: root.turf });
    const realization = (item, form = store?.get().permittedForm) => ({ form, selection: displaySelection(), deps: geometryDeps() });
    let coverRevision = -1, coverCity, siteIndex = null;
    const realizedItems = new WeakMap();
    function proposedSiteIndex() {
        const state = store?.get();
        if (state?.permittedScope !== 'surviving' || state.proposed === 'off') return null;
        const storage = root.proposalStorage;
        if (!storage || !root.__openGround || !root.__siteBinding) return null;
        const city = root.CityConfigManager.getCurrentCityId();
        if (coverCity === city && coverRevision === storage.revision) return siteIndex;
        coverCity = city;
        coverRevision = storage.revision;
        siteIndex = null;
        for (const record of storage.peekAllProposals()) {
            if (!root.isApplied(record) || (record.city && root.CityConfigManager.resolveCityParam(record.city) !== city)) continue;
            // A layout supplies the plots on which Permitted is recalculated. A physical design
            // occupies a site on those plots, including its yards and open ground.
            if (!record.buildingProposal && !record.structureProposal && !record.roadProposal && !record.geometry?.buildings?.length) continue;
            const site = root.__siteBinding.siteOf(record, { turf: root.turf });
            if (!site) continue;
            const feature = root.turf.feature(site, { proposalId: record.proposalId });
            siteIndex ||= root.__openGround.createBboxIndex();
            siteIndex.insert(feature, root.turf.bbox(feature));
        }
        return siteIndex;
    }
    function permittedFeatures(item, options = realization(item)) {
        const index = item.role === 'permitted' && item.volumes?.length ? proposedSiteIndex() : null;
        const key = JSON.stringify([options.form, options.selection.scenario, options.selection.pins[item.id], options.selection.variation]);
        const cached = realizedItems.get(item);
        if (cached?.key === key && cached.index === index) return cached.shapes;
        const shapes = envelopes.realize(item, options);
        if (index) {
            shapes.bound = envelopes.outsideSites(shapes.bound, index, root.turf, root.__parcelArrangement);
            shapes.body = envelopes.outsideSites(shapes.body, index, root.turf, root.__parcelArrangement);
        }
        realizedItems.set(item, { key, index, shapes });
        return shapes;
    }
    const sideWord = (item, edge) => root.i18n.t(`modal.corridor.compass.${envelopes.edgeSide(item.derivation?.parcel, edge)}`);
    const lotNote = configuration => configuration?.lotArea?.status === 'fail' ? t('lotBelowMinimum', { minimum: area(configuration.lotArea.minimumM2) }) : '';
    function pinConfiguration(itemId, configurationId) {
        outlineConfiguration(null);
        pins = { ...pins, [itemId]: configurationId };
        drawMap(); renderInspector(); notifyGeometry();
    }
    // A configuration row outlines the footprint it would show while it is hovered or focused
    // (docs/design-language.md, "Object lists"); picking it is what shows it. null lets go: the map
    // view's hover outline goes, the model view gets its click stack's own outline back.
    function configurationFeatures(item, configurationId) {
        const selection = { ...displaySelection(), pins: { ...pins, [item.id]: configurationId } };
        const deps = geometryDeps();
        return envelopes.mapFeatures(item, { deps, realized: permittedFeatures(item, { form: 'configuration', selection, deps }) });
    }
    function outlineConfiguration(features) {
        const three = !!root.isThreeModeActive?.();
        if (!features) {
            if (three) root.ThreeClickStack?.restoreFocus?.();
            else root.clearProposalHoverLayers?.();
        } else if (three) root.inspectThreeModeFeatures?.(features);
        else root.highlightFeaturesForHover?.(features);
    }
    const number = value => typeof value === 'number' && Number.isFinite(value)
        ? root.CbFormat.formatNumber(value, { maxFractionDigits: 0 }) : '—';
    const area = value => typeof value === 'number' && Number.isFinite(value)
        ? root.CbFormat.formatArea(value, { maxFractionDigits: 0 }) : '—';
    const isParcelTooSmall = item => item?.assessment?.reason === 'parcel-too-small';
    const smallParcelFacts = item => ({ areaM2: item?.sourceEvidence?.assessedParcelAreaM2,
        candidateAreaM2: item?.sourceEvidence?.assessedPlotAreaM2 ?? item?.sourceEvidence?.candidateBuildingPlotAreaM2,
        minimumM2: item?.sourceEvidence?.minBuildingPlotAreaM2 });
    const smallParcelLabel = item => {
        const { candidateAreaM2, areaM2, minimumM2 } = smallParcelFacts(item);
        return t('parcelTooSmallMapLabel', { area: area(candidateAreaM2 ?? areaM2), minimum: area(minimumM2) });
    };
    function sourceConditionNotes(item) {
        const evidence = item?.sourceEvidence || {}, notes = [];
        if (Number.isFinite(evidence.boundaryUncertaintyM)) notes.push(t('sourceBoundaryUncertainty', { meters: number(evidence.boundaryUncertaintyM) }));
        if (evidence.boundaryRelation === 'crosses') notes.push(t('sourceBoundaryCrosses'));
        if (evidence.boundaryRelation === 'boundary-uncertain') notes.push(t('sourceBoundaryUncertain'));
        if (evidence.requiresPreparcellation) notes.push(t('sourceRequiresPreparcellation'));
        else if (item?.assessment?.requiresLandAssembly) notes.push(t('sourceRequiresLandAssembly'));
        if (evidence.requiresUrbanDesignCompetition) notes.push(t('sourceRequiresCompetition'));
        if (evidence.plotFormationCondition) notes.push(t('sourceRequiresPlotFormation'));
        if (evidence.infrastructurePlotException?.condition === 'separate-infrastructure-plot') notes.push(t('sourceInfrastructureException'));
        return notes;
    }
    function citationLabel(citation) {
        if (citation.kind === 'provision') return t('sourceCitationArticle', { article: citation.article });
        if (citation.kind === 'procedure') return t('sourceCitationProcedure', { article: citation.article });
        if (citation.kind === 'drawing') return t('sourceCitationDrawing', { sheet: citation.sheet });
        return t('readSource');
    }
    function sourceLink(citation) {
        try { if (!['http:', 'https:'].includes(new URL(citation.url).protocol)) return null; } catch (_) { return null; }
        const link = element('a', 'cb-link cb-link--external', citationLabel(citation));
        link.href = citation.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        return link;
    }
    function traceValue(value, quantity = '') {
        if (!value || !Number.isFinite(value.value)) return '—';
        if (value.unit === 'm2') return area(value.value);
        if (value.unit === 'm') return root.CbFormat.formatLength(value.value, { maxFractionDigits: 1 });
        if (value.unit === 'ratio') return ['siteCoverage', 'naturalTerrain'].includes(quantity)
            ? `${root.CbFormat.formatNumber(value.value * 100, { maxFractionDigits: 1 })}%`
            : root.CbFormat.formatNumber(value.value, { maxFractionDigits: 3 });
        return value.unit === 'count' ? number(value.value) : `${number(value.value)}${value.unit ? ` ${value.unit}` : ''}`;
    }
    function traceLabel(row) {
        const key = `traceRow.${row.id}`;
        const label = t(key);
        return label === `planningViews.${key}` ? t(`constraint.${row.quantity}`) : label;
    }
    function traceInputLabel(key) {
        const label = t(`traceInput.${key}`);
        return label === `planningViews.traceInput.${key}` ? key : label;
    }
    function renderCalculationTrace(item) {
        const trace = item.sourceEvidence?.calculationTrace;
        if (!Array.isArray(trace) || !trace.length) return null;
        const section = element('section', 'planning-calculation-trace');
        section.append(element('h3', '', t('calculationTraceTitle')), element('p', 'planning-source-note', t('calculationTraceNote')));
        const list = element('ol', 'planning-calculation-trace__list');
        for (const row of trace) {
            const entry = element('li', 'planning-calculation-trace__row');
            const details = element('details');
            const summary = element('summary');
            summary.append(element('span', '', traceLabel(row)), element('span', `cb-badge planning-calculation-trace__status planning-calculation-trace__status--${row.status}`, t(`traceStatus.${row.status}`)));
            details.append(summary);
            const facts = element('dl', 'planning-limits');
            if (Array.isArray(row.inputs) && row.inputs.length) facts.append(element('dt', '', t('traceInputs')), element('dd', '', row.inputs.map(input => `${traceInputLabel(input.key)}: ${traceValue(input, row.quantity)}`).join(' · ')));
            if (row.result) facts.append(element('dt', '', t('traceResult')), element('dd', '', traceValue(row.result, row.quantity)));
            if (row.limit) facts.append(element('dt', '', t('traceLimit')), element('dd', '', `${t(`traceBound.${row.limit.bound || 'recorded'}`)} ${traceValue(row.limit, row.quantity)}`));
            if (row.expression) facts.append(element('dt', '', t('traceExpression')), element('dd', 'planning-calculation-trace__expression', row.expression));
            if (facts.childElementCount) details.append(facts);
            if (row.noteKey) details.append(element('p', 'planning-source-note', t(`traceNote.${row.noteKey}`)));
            const links = (row.citations || []).map(sourceLink).filter(Boolean);
            if (links.length) { const citations = element('p', 'planning-calculation-trace__citations'); citations.append(...links); details.append(citations); }
            entry.append(details); list.append(entry);
        }
        section.append(list);
        return section;
    }
    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function color(role) {
        return getComputedStyle(document.documentElement).getPropertyValue(`--cb-planning-${role}`).trim();
    }
    // A Permitted item is coloured by the use its source states for the land (planning/item-labels.js
    // colourRole, css/tokens.css), zoning area and massing alike; everything else by its role.
    function itemColor(item) { return color(labels.colourRole(item)) || color(item.role); }
    // A zone's or envelope's name in the reader's language (planning/item-labels.js); the source's own
    // wording is shown apart, quoted (sourceText).
    const fullT = (key, params) => root.i18n.t(key, params);
    const itemTitle = item => labels.title(item, fullT, item?.assessment ? resultLabel(item.assessment.status) : '');
    const unbuildableZone = labels.unbuildableZone;
    // Text in the source's own words: quoted and in italics (css .planning-source-text), in the source's
    // language, so it never reads as the app's own text.
    function sourceText(text, item) {
        const quote = element('q', 'planning-source-text', text);
        if (item?.source?.language) quote.lang = item.source.language;
        return quote;
    }
    function sourcePlanUrl(source) {
        if (!source?.url) return null;
        try {
            const url = new URL(source.url);
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
        } catch { return null; }
    }
    function sourceConfigurationUrl(source) {
        const url = new URL('/sources.html', location.href);
        url.searchParams.set('abstraction', 'planning');
        url.searchParams.set('source', source.id);
        url.searchParams.set('backend', root.getBackendBase());
        url.searchParams.set('city', root.CityConfigManager.getCurrentCityId());
        const context = new URLSearchParams(location.search);
        for (const key of ['at', 'lang']) if (context.has(key)) url.searchParams.set(key, context.get(key));
        url.hash = 'source-config-title';
        return url.href;
    }
    // Swatch rows (planning/item-labels.js legend/colourKey) as list items.
    function legendRows(rows) {
        return rows.map(row => {
            const entry = element('li');
            const swatch = element('span', `planning-swatch planning-swatch--${row.swatch}`); swatch.setAttribute('aria-hidden', 'true');
            entry.append(swatch, element('span', '', row.text));
            return entry;
        });
    }
    function warningColor() { return getComputedStyle(document.documentElement).getPropertyValue('--cb-danger').trim(); }
    function policy() { return core.displayPolicy(store?.get()); }
    function isBuiltVisible() { return (store?.get().existing ?? core.defaults.existing) !== 'off'; }
    function setBuiltVisible(shown) {
        if (store && shown !== isBuiltVisible()) store.configure('existing', shown ? 'ghost' : 'off');
    }
    function sceneItems() { return showingOverview() ? items.length ? [...items, ...overview.items] : overview.items : items; }
    function appearance(item) {
        const state = store?.get();
        const value = core.itemAppearance(item, state);
        if (value !== 'off' && state?.permittedScope === 'surviving' && state.proposed !== 'off'
            && item.role === 'permitted' && !item.areas?.length && item.volumes?.length) {
            const { bound, body } = permittedFeatures(item);
            if (!bound.length && !body.length) return 'off';
        }
        return value;
    }
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
        const item = selected();
        if (item?.overview && item.source.viewportZoning) {
            sourceRecord({ city: item.source.city, providerId: item.source.id, recordId: item.source.recordId, scenario: scenarioParam() })
                .then(records => {
                    const record = records.find(entry => entry.id === id);
                    if (!record || selected() !== item) return;
                    focusedRecord = record;
                    drawMap(); renderInspector();
                }).catch(error => console.error('[planning] Could not read the full zoning record', error));
        }
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
        if (record) { selectRecord(record); measureHeight(record, feature); return true; }
        return false;
    }
    // A built record whose source has no known height (rule-terms buildingHeight) is measured from
    // the height survey covering it (buildings/height-survey-client.js): the card says so meanwhile,
    // and the result replaces the record's height and names its survey, or says why there is none.
    // The state is kept per building (record id) and copied onto whichever record of it the
    // inspector shows when the answer arrives.
    const heightSurveys = new Map(), heightFeatures = new Map();
    function applyHeightSurvey(record, state) {
        if (!('sourceHeightM' in record)) record.sourceHeightM = record.metrics.heightM;
        record.heightSurvey = state;
        if (state.status === 'measured') record.metrics.heightM = state.heightM;
    }
    // Heights chosen as the building source's (Built → Heights): the card shows the source's height again.
    function dropHeightSurvey(record) {
        if (!record?.heightSurvey) return;
        record.metrics.heightM = record.sourceHeightM;
        delete record.heightSurvey;
    }
    function measureHeight(record, feature) {
        const client = root.HeightSurveyClient, survey = client?.surveyFor(feature);
        if (!survey) return;
        heightFeatures.set(record.id, feature);
        if (!client.usesSurvey()) return;
        const named = { id: survey.id, name: survey.name };
        applyHeightSurvey(record, heightSurveys.get(record.id)?.status === 'measured' ? heightSurveys.get(record.id) : { status: 'measuring', survey: named });
        if (selected()?.id === record.id) renderInspector();
        client.measureOne(feature, record.source.recordId).then(result => {
            const measured = typeof result?.heightM === 'number' && Number.isFinite(result.heightM);
            const state = { status: measured ? 'measured' : 'none', survey: named, ...result };
            heightSurveys.set(record.id, state);
            applyHeightSurvey(record, state);
            const shown = selected();
            if (shown?.id !== record.id) return;
            applyHeightSurvey(shown, state);
            renderInspector();
        }).catch(error => console.error(`[${new Date().toISOString()}] [planning] Building height could not be measured`, error));
    }
    // Built → Heights: shown where a height survey covers the map's centre, its options named after
    // that survey and the city's building sources.
    function renderHeightsChoice() {
        const field = panel.querySelector('.planning-existing-heights');
        if (!field) return;
        const centre = root.map?.getCenter?.();
        const survey = centre ? root.HeightSurveyClient?.surveyAtPoint([centre.lng, centre.lat]) : null;
        field.hidden = !survey;
        if (!survey) return;
        field.querySelector('.planning-existing-heights-label').textContent = t('existingHeights');
        const sources = (root.CityConfigManager.getBuildingSources?.() || []).map(source => source.name).filter(Boolean);
        const select = field.querySelector('select');
        select.setAttribute('aria-label', t('existingHeights'));
        select.querySelector('option[value="survey"]').textContent = survey.name;
        select.querySelector('option[value="source"]').textContent = sources.length ? sources.join(', ') : t('source');
    }
    // Why a survey gave no height, literal keys so the locale coverage test sees each one.
    const HEIGHT_SURVEY_NONE = {
        'no-building-seen': 'heightSurveyNoBuilding', 'too-few-cells': 'heightSurveyTooSmall', 'smaller-than-a-cell': 'heightSurveyTooSmall',
        'low-confidence': 'heightSurveyUnclear', 'no-survey-data': 'heightSurveyNoData', 'implausibly-tall': 'heightSurveyImplausible',
        'survey-unavailable': 'heightSurveyUnavailable'
    };
    function heightSurveyLine(item) {
        const state = item.heightSurvey, survey = state?.survey?.name || '';
        if (!state) return null;
        if (state.status === 'measuring') return t('heightSurveyMeasuring', { survey });
        if (state.status === 'measured') {
            const parts = [t('heightSurveyMeasured', { survey })];
            if (state.surveyedFrom) parts.push(t('heightSurveyFlown', { date: root.CbFormat.formatDate(new Date(`${state.surveyedFrom}T00:00:00Z`), { timeZone: 'UTC' }) }));
            if (typeof state.eaveM === 'number') parts.push(t('heightSurveyEave', { eave: root.CbFormat.formatLength(state.eaveM, { maxFractionDigits: 1 }) }));
            return parts.join(' · ');
        }
        const key = HEIGHT_SURVEY_NONE[state.rejection];
        return key ? t(key, { survey }) : null;
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
        return ['public-screen', 'zoning-area', 'partial-envelope', 'outer-bound', 'source-rule-warning', 'source-rule-precondition'].includes(item.assessment?.meaning) ? 'sourceEvidenceBadge' : 'obligatory';
    }
    async function parcelRecords(parcel, signal, context = {}) {
        if (!(context.source || sourceId)) return [];
        const url = new URL(`${root.getBackendBase()}/planning/parcel`);
        url.searchParams.set('city', context.city || root.CityConfigManager.getCurrentCityId());
        url.searchParams.set('parcel', parcel);
        if (context.source || sourceId) url.searchParams.set('source', context.source || sourceId);
        const response = await fetch(url, { signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`Planning parcel HTTP ${response.status}`);
        const answer = await readPermittedJson(response);
        if (answer.parcel !== parcel || !Array.isArray(answer.items)) throw new Error('Invalid planning parcel response');
        return answer.items;
    }
    const recordReads = new Map();
    const fullRecords = new WeakSet();
    function sourceRecord(reference) {
        const url = new URL(`${root.getBackendBase()}/planning/record`);
        for (const [key, value] of Object.entries({ city: reference.city, source: reference.providerId,
            recordId: reference.recordId, scenario: reference.scenario })) if (value) url.searchParams.set(key, value);
        const key = url.href;
        if (recordReads.has(key)) return recordReads.get(key);
        const read = root.PlanningLoading.track('permitted', fetch(url, { cache: 'no-store' }).then(async response => {
            if (!response.ok) throw new Error(`Planning record HTTP ${response.status}`);
            const answer = await readPermittedJson(response);
            if (answer.recordId !== reference.recordId || !Array.isArray(answer.items)) throw new Error('Invalid source record response');
            for (const record of answer.items) fullRecords.add(record);
            return answer.items;
        })).finally(() => recordReads.delete(key));
        recordReads.set(key, read);
        return read;
    }
    function areaSiteAction(item, areaRef) {
        const action = element('div', 'planning-area-site');
        const button = element('button', 'btn btn-primary');
        button.type = 'button';
        const message = element('p', 'planning-inspector__description');
        message.setAttribute('role', 'status');
        action.append(button, message);
        button.addEventListener('click', async () => {
            if (root.BusyControl.isBusy(button)) return;
            const current = selected(), city = root.CityConfigManager.getCurrentCityId(), scenario = scenarioParam();
            if (current?.id !== item.id) return;
            message.textContent = '';
            try {
                await root.BusyControl.track(button, async () => {
                    const exact = fullRecords.has(current) && current.assessment?.meaning === 'zoning-area' ? current
                        : (await sourceRecord({ city, providerId: areaRef.source, recordId: areaRef.recordId, scenario: current.source.scenario || scenario }))
                            .find(record => record.assessment?.meaning === 'zoning-area' && record.source.id === areaRef.source
                                && record.source.recordId === areaRef.recordId && record.areas?.length);
                    if (!action.isConnected || selected()?.id !== item.id || city !== root.CityConfigManager.getCurrentCityId() || scenario !== scenarioParam()) return;
                    const site = root.PlanningSourceProposal.designSite(exact);
                    if (!site) throw new Error('The source has no full zoning-area geometry');
                    if (root.__mapModeState?.desired && root.__mapModeState.desired !== '2d' && !await root.requestMapMode('2d')) {
                        throw new Error('The site editor requires the 2D map');
                    }
                    if (root.SiteTool.start(site) && selected()) select(null);
                });
            } catch (error) {
                console.error('[planning] Could not open the zoning area as a site', error);
                message.textContent = t('siteOpenFailed');
            }
        });
        return action;
    }
    function openMassingForm() {
        if (!root.MapShell.openSheet(panel, { focus: false })) return;
        panel.querySelector('[data-planning-tab="display"]').click();
        const form = panel.querySelector('[data-planning-setting="permittedForm"]');
        form.closest('details').open = true;
        form.focus();
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
        drawOverview();
        selectionLayer.clearLayers();
        drawSourceBoundary();
        const selection = selected();
        const selectionSite = envelopes.sourceSiteGeometry(selection);
        if (selectionSite && (selection.role !== 'permitted' || !selection.volumes.length)) {
            root.L.geoJSON(selectionSite, { pane: 'planningSources', interactive: false,
                style: root.MapHighlight.style({ fill: false, className: 'planning-site-selection' }) }).addTo(selectionLayer);
        }
        // Each item is drawn into its own group, remembered with what it was drawn from. A redraw
        // replaces only the items whose record or appearance changed and removes the ones gone, so
        // a pan that brings a few parcels does not rebuild every massing on the map.
        const state = store.get();
        const cover = proposedSiteIndex();
        const colors = new Map();
        const drawnColor = item => {
            const role = labels.colourRole(item);
            if (!colors.has(role)) colors.set(role, itemColor(item));
            return colors.get(role);
        };
        const shown = new Set();
        hitShapes = [];
        for (const item of items) {
            const display = appearance(item);
            if (display === 'off' || shown.has(item.id)) continue;
            shown.add(item.id);
            const signature = JSON.stringify([display, state.permittedMap, state.permittedForm, state.permittedVariation,
                scenarioId, pins[item.id] || null, item.id === state.selectedId, drawnColor(item)]);
            const previous = drawnItems.get(item.id);
            const massingCover = item.role === 'permitted' && item.volumes?.length ? cover : null;
            if (previous && previous.item === item && previous.signature === signature && previous.cover === massingCover) {
                hitShapes.push(...previous.hits);
                continue;
            }
            if (previous) layer.removeLayer(previous.group);
            const group = root.L.featureGroup().addTo(layer);
            const hits = drawItem(item, display, group);
            drawnItems.set(item.id, { item, signature, cover: massingCover, group, hits });
            hitShapes.push(...hits);
        }
        for (const [id, entry] of drawnItems) {
            if (shown.has(id)) continue;
            layer.removeLayer(entry.group);
            drawnItems.delete(id);
        }
        sourceBoundaryLayer?.bringToFront?.();
    }
    // A plan unit is source evidence, not a selectable parcel result. It stays visible even when
    // this viewport happens to contain no returned parcels.
    function drawSourceBoundary() {
        if (!sourceBoundaryLayer) sourceBoundaryLayer = root.L.featureGroup().addTo(layer);
        sourceBoundaryLayer.clearLayers();
        const descriptor = sourceOptions.find(source => source.id === sourceId);
        const geometry = descriptor?.coverageGeometry;
        if (policy().permitted === 'off' || !['Polygon', 'MultiPolygon'].includes(geometry?.type)) return;
        const outline = root.L.geoJSON({ type: 'Feature', geometry }, { pane: 'planningSources', interactive: false,
            style: { color: color('permitted'), weight: 3, dashArray: '8 5', fill: false, fillOpacity: 0, opacity: 0.95 } });
        outline.addTo(sourceBoundaryLayer);
        if (!descriptor.geometryLabel) return;
        try {
            const point = root.turf.pointOnFeature({ type: 'Feature', geometry });
            const label = document.createElement('span');
            label.textContent = descriptor.geometryLabel;
            const icon = root.L.divIcon({ className: 'planning-source-boundary-label', html: label,
                iconSize: [48, 24], iconAnchor: [24, 12] });
            root.L.marker([point.geometry.coordinates[1], point.geometry.coordinates[0]], { pane: 'planningSources', interactive: false, icon }).addTo(sourceBoundaryLayer);
        } catch (_) { /* The outline remains sufficient source evidence. */ }
    }
    function drawOverview() {
        if (!showingOverview()) {
            if (overviewLayer && root.map.hasLayer(overviewLayer)) root.map.removeLayer(overviewLayer);
            return;
        }
        if (!overviewLayer) {
            const renderer = root.L.canvas({ pane: 'planningSources' });
            const colours = new Map();
            const geometry = { type: 'FeatureCollection', features: overview.entries.map(({ feature, item }) => {
                const role = labels.colourRole(item);
                if (!colours.has(role)) colours.set(role, itemColor(item));
                feature.properties.colour = colours.get(role);
                return feature;
            }) };
            overviewLayer = root.L.geoJSON(geometry, { pane: 'planningSources', renderer, interactive: false,
                style: feature => ({ stroke: false, fillColor: feature.properties.colour }) });
        }
        const display = store.get().zoningAreas;
        if (display !== overviewDisplay) {
            overviewDisplay = display;
            overviewLayer.setStyle({ fillOpacity: display === 'solid' ? 1 : 0.40 });
        }
        if (!root.map.hasLayer(overviewLayer)) overviewLayer.addTo(root.map);
    }
    // One item's massing shapes, added to `group`; returns its click-stack hit shapes.
    function drawItem(item, display, group) {
        const hits = [];
        let features;
        try { features = envelopes.mapFeatures(item, { detail: store.get().permittedMap, deps: geometryDeps(), realized: permittedFeatures(item) }); }
        catch (error) { console.error('[planning] Could not project massing', item.id, error); return hits; }
        const hasBody = features.some(feature => feature.properties.geometryRole !== 'bound');
        for (const feature of features) {
            const active = item.id === store.get().selectedId;
            // The outer bound behind a shown configuration is a hull: outline plus a faint fill.
            const warningFeature = feature.properties.geometryRole === 'source-warning';
            const evidenceFeature = feature.properties.geometryRole === 'source-evidence';
            const hull = feature.properties.geometryRole === 'bound' && hasBody;
            // A tier only an incentive's condition reaches is a fainter, sparser outline.
            const conditional = Boolean(feature.properties.condition);
            // The hull is not a second click target: the configuration inside carries the interaction.
            const shape = root.L.geoJSON(feature, { pane: 'planningSources', className: warningFeature ? 'planning-parcel-warning' : evidenceFeature ? 'planning-source-evidence' : hull ? 'planning-bound-outline' : undefined, interactive: !hull,
                style: { color: active ? root.MapHighlight.color : warningFeature ? warningColor() : itemColor(item),
                    weight: active ? 4 : warningFeature || evidenceFeature ? 2 : hull || conditional ? 1 : 1.5,
                    dashArray: warningFeature ? '5 4' : evidenceFeature ? '4 4' : conditional ? '2 6' : hull ? '4 4' : unbuildableZone(item) ? '6 4' : null,
                    fillColor: warningFeature ? warningColor() : itemColor(item),
                    fillOpacity: warningFeature ? (display === 'solid' ? 0.35 : 0.2) : evidenceFeature ? (display === 'solid' ? 0.16 : 0.08) : conditional ? 0.03 : hull ? 0.06 : display === 'solid' ? 1 : 0.18,
                    opacity: conditional ? 0.6 : hull ? 0.8 : 1 } });
            const label = item.source.parcel || itemTitle(item);
            shape.addTo(group);
            // The assumed street side of the shown configuration, so a roll reads as a choice, not a glitch.
            if (feature.properties.frontEdge != null && item.derivation?.parcel) {
                const ring = item.derivation.parcel.coordinates[0], edge = feature.properties.frontEdge;
                const line = root.turf.lineString([ring[edge], ring[edge + 1]]);
                const cover = proposedSiteIndex();
                if (!cover || [...cover.query(root.turf.bbox(line))].every(site => root.turf.booleanDisjoint(line, site))) {
                    root.L.polyline(line.geometry.coordinates.map(p => [p[1], p[0]]), { pane: 'planningSources', interactive: false,
                        color: itemColor(item), weight: 4, opacity: 0.9 }).addTo(group);
                }
            }
            if (warningFeature) {
                shape.bindTooltip(`⚠ ${smallParcelLabel(item)}`, { className: 'planning-parcel-warning-tooltip', direction: 'top', sticky: true });
                try {
                    const point = root.turf.pointOnFeature({ type: 'Feature', geometry: feature.geometry });
                    const icon = root.L.divIcon({ className: 'planning-parcel-warning-icon', html: '<span aria-hidden="true">⚠</span>', iconSize: [24, 24], iconAnchor: [12, 12] });
                    root.L.marker([point.geometry.coordinates[1], point.geometry.coordinates[0]], { pane: 'planningSources', interactive: false, icon }).addTo(group);
                } catch (_) { /* The polygon remains the visible, inspectable warning. */ }
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
                node.setAttribute('aria-label', warningFeature ? `${smallParcelLabel(item)}. ${t('inspectResult')}`
                    : evidenceFeature ? `${itemTitle(item)}. ${t('inspectResult')}`
                    : t(item.assessment?.meaning === 'restriction' ? 'inspectDesignation' : item.areas?.length ? 'inspectArea' : 'inspectMassing', { parcel: label }));
                node.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault(); event.stopPropagation();
                        // Match pointer activation so a narrow-screen hosted inspector opens.
                        let latlng = part.getBounds?.().getCenter?.();
                        try {
                            const point = root.turf.pointOnFeature(feature).geometry.coordinates;
                            latlng = root.L.latLng(point[1], point[0]);
                        } catch (_) { /* Bounds centre is the safe fallback. */ }
                        if (latlng && root.ClickStack?.handleClick) root.ClickStack.handleClick(latlng, { allowUrbanBlocks: true });
                        else inspect();
                    }
                });
            });
        }
        return hits;
    }
    function isPhoto() { return root.__mapModeState?.desired === 'photo'; }
    function stateText() {
        if (policy().permitted === 'off' && store.get().zoningAreas === 'off') return t('permittedOff');
        if (status === 'loading' && progress?.total) return t('loadingCells', progress);
        if (status !== 'ready') return t(status);
        if (overviewOnly && showingOverview()) {
            const count = t('areasLoaded', { count: overview.items.length });
            return overview.detailZoom == null ? count : `${count} · ${t('zoomInForMore')}`;
        }
        if (!payload?.sources?.length && payload?.restrictions) return t('designationsLoaded', { count: items.length }) + restrictionNote();
        if (!payload?.sources?.length) return t('unavailable');
        const failedNote = (failedCells ? ` · ${t('cellsFailed')}` : '') + (frozen || massingWaits ? ` · ${t('zoomInForMore')}` : '') + restrictionNote();
        if (payload.envelopes) return t('envelopesLoaded', { count: items.filter(item => item.parcelEnvelope).length,
            missing: payload.unavailable.length }) + failedNote;
        if (!items.length) return t('empty');
        const text = t(payload.omitted ? 'partial' : payload.sources.some(source => source.capabilities.areas) ? 'areasLoaded' : 'loaded', { count: items.length });
        const pending = (payload.summaries || []).reduce((sum, entry) => sum + (entry.awaitingRefresh || 0), 0);
        return (pending ? `${text} · ${t('refreshCount', { count: pending })}` : text) + failedNote;
    }
    function renderInspector() {
        const item = selected();
        const hosted = inspector.classList.contains('is-hosted');
        const hostedBuilt = item?.role === 'existing' && hosted;
        const previousLegend = inspector.dataset.planningItem === item?.id
            ? inspector.querySelector('.planning-map-colours') : null;
        const previousSiteAction = inspector.dataset.planningItem === item?.id ? inspector.querySelector('.planning-area-site') : null;
        const siteActionFocused = previousSiteAction?.contains(document.activeElement);
        const formActionFocused = inspector.dataset.planningItem === item?.id && document.activeElement?.classList.contains('planning-change-massing');
        const legendOpen = previousLegend?.open === true;
        const legendFocused = previousLegend && previousLegend.firstElementChild === document.activeElement;
        inspector.hidden = !item || item.role === 'proposed' || (item.role === 'existing' && !hostedBuilt);
        inspector.dataset.planningItem = inspector.hidden ? '' : item.id;
        inspector.replaceChildren();
        if (!item || item.role === 'proposed' || (item.role === 'existing' && !hostedBuilt)) return;
        const header = element('header', 'planning-inspector__header');
        const heading = element('div');
        const sourceResult = item.role === 'permitted';
        heading.append(element('p', 'planning-eyebrow', item.assessment?.meaning === 'restriction' ? t('designation') : item.parcelEnvelope ? t('envelopeTitle')
            : t(item.areas?.length ? (item.landBasis === 'zone' ? 'governmentPlanPlot' : 'zoningArea') : sourceResult ? (item.volumes.length ? 'sourceProposal' : 'savedResult') : 'builtRecord')));
        // The hosted stack already supplies the object's title and parcel reference.
        if (!hosted && item.title) heading.append(element('h2', 'click-stack__title', itemTitle(item)));
        const wording = labels.sourceWording(item, fullT, resultLabel(item.assessment?.status));
        // A hosted envelope's header names its parcel (click-stack-hits.js), so its translated name goes here.
        if (hosted && wording && item.source?.parcel) heading.append(element('p', 'planning-inspector__name', itemTitle(item)));
        if (wording) {
            const line = element('p', 'planning-source-wording', `${t('sourceWording')} `);
            line.append(sourceText(wording, item)); heading.append(line);
        }
        // A parcel's massing names its parcel; the title alone is the source edition and ratio.
        const parcelLabel = parcelOf(item);
        if (!hosted && parcelLabel) heading.append(element('p', 'planning-inspector__parcel', `${t('focusParcel')} ${parcelLabel}`));
        const close = element('button', 'close-circle-btn', '×');
        close.type = 'button'; close.setAttribute('aria-label', t('close'));
        close.addEventListener('click', () => { select(null); document.getElementById('planning-views-button').focus(); });
        header.append(heading, close);
        inspector.append(header);
        const page = (key, label) => {
            const node = element('div', 'planning-inspector__page');
            node.dataset.stackPageKey = key;
            node.dataset.stackPageLabel = label;
            inspector.append(node);
            return node;
        };
        const info = page('info', root.i18n.t('clickStackNavigation.info'));
        const areaRef = root.PlanningSourceProposal.designSiteArea(item);
        if (areaRef) {
            const action = previousSiteAction || areaSiteAction(item, areaRef);
            const button = action.querySelector('button');
            button.textContent = t(item.parcelEnvelope ? 'usePlanAreaAsSite' : 'useAreaAsSite');
            info.append(action);
            if (siteActionFocused) button.focus({ preventScroll: true });
        }
        const options = sourceResult && item.configurations?.length ? page('options', root.i18n.t('planningViews.tabs.options')) : null;
        const rules = sourceResult ? page('rules', root.i18n.t('proposalDrafts.approval.policyType')) : null;
        const badges = element('div', 'planning-inspector__badges');
        badges.append(element('span', `cb-badge${isParcelTooSmall(item) ? ' cb-badge--danger' : ''}`,
            isParcelTooSmall(item) ? t('parcelTooSmall') : t(inspectorBadgeKey(item))));
        if (sourceResult && item.volumes.length) badges.append(element('span', 'cb-badge cb-badge--warning',
            t(item.assessment.meaning === 'existing-stock-estimate' ? 'stockBadge' : item.parcelEnvelope ? 'bound' : 'approximate')));
        if (item.assessment.refresh) badges.append(element('span', 'cb-badge cb-badge--warning', t('refreshPending')));
        info.append(badges);
        const heightOnly = labels.heightOnlyPlot(item);
        info.append(element('p', `planning-inspector__description${isParcelTooSmall(item) ? ' planning-inspector__description--warning' : ''}`,
            isParcelTooSmall(item) ? t('parcelTooSmallDescription', { candidateArea: area(smallParcelFacts(item).candidateAreaM2 ?? smallParcelFacts(item).areaM2),
                parcelArea: area(smallParcelFacts(item).areaM2), minimum: area(smallParcelFacts(item).minimumM2) })
                : t(item.assessment.meaning === 'existing-stock-estimate' ? 'stockEstimate'
                : item.assessment.meaning === 'public-screen' ? 'evidenceOnly'
                    : item.assessment.meaning === 'restriction' ? 'restrictionNote'
                    : item.assessment.meaning === 'zoning-area' ? 'zoningAreaNote'
                        : heightOnly ? 'heightOnlyPlot' : item.parcelEnvelope ? 'envelopeNote'
                        : sourceResult ? (item.volumes.length ? 'oneOption' : 'savedNoShape')
                        : 'observedNote', heightOnly ? { illustration: t('configuration') } : undefined)));
        // Explain which boundary the adapter uses for its Permitted massing calculation.
        if (item.landBasis === 'zone' && !heightOnly) info.append(element('p', 'planning-inspector__description', t('landBasisZone')));
        if (item.configurations?.some(configuration => configuration.volumes?.length)) {
            const changeForm = element('button', 'cb-link planning-change-massing', t('changeMassingView'));
            changeForm.type = 'button';
            changeForm.setAttribute('aria-controls', panel.id);
            changeForm.addEventListener('click', openMassingForm);
            info.append(changeForm);
            if (formActionFocused) changeForm.focus({ preventScroll: true });
        }
        if (item.assessment.status && !item.parcelEnvelope) info.append(element('p', 'planning-inspector__description', resultLabel(item.assessment.status)));
        const reason = isParcelTooSmall(item) || ['plan-boundary-uncertain', 'b1-reparcelation-and-competition-required'].includes(item.assessment.reason)
            ? null : labels.reason(item, fullT);
        if (reason) {
            const line = element('p', 'planning-cache-reason');
            line.append(reason.source ? sourceText(reason.text, item) : reason.text); info.append(line);
        }
        for (const note of sourceConditionNotes(item)) info.append(element('p', 'planning-inspector__description', note));
        // The planning designations over the item (restrictions.js), each with its source record.
        if (item.restrictions?.length && root.PermittedAdvisor) {
            const list = element('ul', 'planning-restrictions');
            for (const entry of item.restrictions) list.append(root.PermittedAdvisor.restrictionItem(entry, 'planning-restrictions__item'));
            info.append(element('h3', 'cb-kicker', t('restrictionsTitle')), list);
        }
        // What the colours this item is drawn in mean, and the whole map's key below it.
        const key = labels.colourKey(item, fullT);
        if (key.length) {
            const colours = element('ul', 'planning-zone-legend planning-colour-key');
            colours.setAttribute('aria-label', t('colourKey')); colours.append(...legendRows(key));
            const all = element('details', 'planning-evidence planning-map-colours');
            all.open = legendOpen;
            const summary = element('summary', '', t('mapColours'));
            all.append(summary);
            const list = element('ul', 'planning-zone-legend'); list.append(...legendRows(labels.legend(sceneItems().filter(entry => appearance(entry) !== 'off'), fullT)));
            all.append(list);
            info.append(colours, all);
            if (legendFocused) summary.focus({ preventScroll: true });
        }
        if (item.assessment.current === false) info.append(element('p', 'planning-inspector__description', t('savedWithdrawn')));
        if (referenceStatus && referenceStatus !== 'same') info.append(element('p', 'planning-assessment', t('referenceChanged')));
        if (item.assessment.refresh) {
            const key = `planningViews.refreshCause.${item.assessment.refresh.code}`;
            const reason = root.i18n.t(key);
            info.append(element('p', 'planning-inspector__description', `${t('refreshNote')} ${reason === key ? t('refreshFailed') : reason}`));
        }
        const metrics = element('dl', 'planning-metrics');
        const unitLimit = item.constraints?.find(constraint => constraint.quantity === 'dwellings')?.value;
        const displayedMetrics = [];
        if (item.metrics.floorAreaM2 != null) displayedMetrics.push([t('floorArea'), area(item.metrics.floorAreaM2)]);
        if (item.metrics.heightM != null) displayedMetrics.push([t(item.parcelEnvelope ? 'envelopeHeight' : 'height'), root.CbFormat.formatLength(item.metrics.heightM, { maxFractionDigits: 1 })]);
        // An incentive's extra height is listed with its condition, apart from what the rules grant.
        if (item.metrics.conditional?.heightM != null) {
            const condition = labels.condition(item.metrics.conditional, fullT);
            const value = element('span', '', root.CbFormat.formatLength(item.metrics.conditional.heightM, { maxFractionDigits: 1 }));
            if (condition) value.append(' · ', condition.source ? sourceText(condition.text, item) : condition.text);
            displayedMetrics.push([t('conditionalHeight'), value]);
        }
        if (unitLimit != null) displayedMetrics.push([t('dwellingLimit'), number(unitLimit)]);
        if (item.metrics.footprintM2 != null) displayedMetrics.push([t(item.parcelEnvelope ? 'envelopeFootprint' : 'footprintArea'), area(item.metrics.footprintM2)]);
        const candidatePlotAreaM2 = item.sourceEvidence?.assessedPlotAreaM2 ?? item.sourceEvidence?.candidateBuildingPlotAreaM2;
        if (Number.isFinite(candidatePlotAreaM2)) {
            if (!isParcelTooSmall(item)) displayedMetrics.push([t('parcelArea'), area(smallParcelFacts(item).areaM2)]);
            displayedMetrics.push([t('candidateBuildingPlotArea', { block: item.sourceEvidence?.block || '' }), area(candidatePlotAreaM2)]);
        }
        if (item.volumes?.length && Number.isFinite(item.sourceEvidence?.assumedStoreyHeightM)) displayedMetrics.push([
            t('assumedStoreyHeight'), root.CbFormat.formatLength(item.sourceEvidence.assumedStoreyHeightM, { maxFractionDigits: 1 })
        ]);
        if (isParcelTooSmall(item)) {
            const { areaM2, minimumM2 } = smallParcelFacts(item);
            displayedMetrics.push([t('parcelArea'), area(areaM2)], [t('minimumBuildingPlotArea'), area(minimumM2)]);
        }
        for (const [label, value] of displayedMetrics) {
            const entry = element('div'), cell = element('dd'); cell.append(value);
            entry.append(element('dt', '', label), cell); metrics.append(entry);
        }
        if (displayedMetrics.length) info.append(metrics);
        const surveyLine = item.heightSurvey ? heightSurveyLine(item) : null;
        if (surveyLine) {
            const line = element('p', 'planning-inspector__description', surveyLine);
            line.setAttribute('role', 'status');
            info.append(line);
        }
        const heights = [...new Set(item.volumes.map(volume => volume.topM))].sort((a, b) => a - b);
        if (heights.length > 1) info.append(element('p', 'planning-inspector__description', t('heightParts', { heights: heights.map(height => root.CbFormat.formatLength(height)).join(' · ') })));
        const realization = permittedFeatures(item), shown = realization.configuration;
        if (options) options.append(renderConfigurations(item, shown));
        if (realization.frontEdge != null) {
            (rules || info).append(element('p', 'planning-inspector__description', t('assumedSide', { side: sideWord(item, realization.frontEdge) })));
            const frontage = root.StreetFrontage?.basisText(item.sourceEvidence?.frontage);
            if (frontage) (rules || info).append(element('p', 'planning-inspector__description', frontage));
        }
        const assessment = element('div', 'planning-assessment');
        assessment.append(element('strong', '', t('conditionsTitle')), element('p', '', t('conditionsNote')));
        if (sourceResult && item.volumes.length) (rules || info).append(assessment);
        const trace = renderCalculationTrace(item);
        if (trace) (rules || info).append(trace);
        const constraints = trace ? [] : (shown ? shown.constraints : item.constraints);
        if (constraints?.length) {
            const limits = element('dl', 'planning-limits');
            if (shown) limits.append(element('dt', 'planning-limits__scope', shown.title || scenarioLabel(shown.id)), element('dd', '', ''));
            for (const constraint of constraints) {
                const digits = constraint.value === 0 ? 0 : Math.min(20, Math.max(6, 2 - Math.floor(Math.log10(Math.abs(constraint.value)))));
                const measured = root.CbFormat.formatNumber(constraint.value, { maxFractionDigits: digits });
                const value = constraint.unit === 'm2' ? area(constraint.value)
                    : constraint.unit === 'percent' ? `${measured}%`
                        : constraint.unit === 'count' ? number(constraint.value) : `${measured} ${constraint.unit}`;
                const evidence = constraint.evidence ? ` · ${t(`evidence.${constraint.evidence}`)}` : '';
                const formula = constraint.evidence === 'derived' && constraint.derivation ? ` · ${constraint.derivation}` : '';
                limits.append(element('dt', '', t(`constraint.${constraint.quantity}`)), element('dd', '', value + evidence + formula));
            }
            (rules || info).append(limits);
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
            const citations = (item.sourceEvidence.citations || []).map(sourceLink).filter(Boolean);
            if (citations.length) {
                const list = element('ul', 'planning-source-citations');
                for (const link of citations) {
                    const row = element('li'); row.append(link); list.append(row);
                }
                evidence.append(list);
            }
        }
        info.append(evidence);
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
            evidence.append(button);
        }
        const footer = element('footer', 'planning-inspector__footer');
        const sourceUrl = sourcePlanUrl(item.source);
        if (sourceUrl) {
            const link = element('a', 'cb-link cb-link--external', t('publishedReference'));
            link.href = sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
            footer.append(link);
        }
        evidence.append(footer);
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
            const label = configuration.title || scenarioLabel(configuration.id);
            button.setAttribute('aria-label', `${t('configurationShow')}: ${label}`);
            button.append(element('strong', '', label), element('span', '', resultLabel(configuration.treatment)));
            const measure = configuration.unavailableReason ? t(`envelopeUnavailable.${configuration.unavailableReason}`)
                : `${root.CbFormat.formatLength(configuration.metrics.heightM, { maxFractionDigits: 1 })} · ${area(configuration.metrics.footprintM2)}`;
            button.append(element('span', 'planning-configurations__measure', measure));
            if (lotNote(configuration)) button.append(element('span', 'cb-badge cb-badge--warning', lotNote(configuration)));
            if (shown?.id === configuration.id) button.append(element('span', 'cb-badge', t('configurationShown')));
            button.addEventListener('click', () => pinConfiguration(item.id, configuration.id));
            row.append(button); list.append(row);
        }
        const rowOf = event => event.target.closest?.('li[data-configuration]');
        const enter = event => {
            const row = rowOf(event);
            if (row && !row.contains(event.relatedTarget)) outlineConfiguration(configurationFeatures(item, row.dataset.configuration));
        };
        const leave = event => {
            const row = rowOf(event);
            if (row && !row.contains(event.relatedTarget)) outlineConfiguration(null);
        };
        list.addEventListener('mouseover', enter); list.addEventListener('focusin', enter);
        list.addEventListener('mouseout', leave); list.addEventListener('focusout', leave);
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
        const view = policy();
        const shown = { existing: view.existing !== 'off', permitted: view.permitted !== 'off' || store.get().zoningAreas !== 'off', proposed: view.proposed !== 'off' };
        const loading = root.PlanningLoading.state();
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
        const arcs = core.loadingArcs(loading, shown);
        for (const arc of ring.querySelectorAll('.planning-loading-arc')) {
            const slot = arcs.find(entry => entry.role === arc.dataset.role)?.slot;
            if (slot === undefined) arc.removeAttribute('data-slot'); else arc.dataset.slot = String(slot);
            const role = arc.dataset.role;
            const bar = panel.querySelector(`[data-planning-loading="${role}"]`);
            if (bar) {
                const counter = bar.parentElement.querySelector('.planning-loading-count');
                const bytes = root.PlanningLoading.bytesLoaded(role);
                const showCount = slot !== undefined && bytes > 0;
                bar.hidden = slot === undefined;
                counter.hidden = !showCount;
                if (showCount) {
                    const size = root.CbFormat.formatReceivedBytes(bytes);
                    const received = t('receivedData', { size });
                    if (counter.textContent !== size) counter.textContent = size;
                    bar.setAttribute('aria-valuetext', received);
                    counter.title = received;
                } else bar.removeAttribute('aria-valuetext');
            }
        }
        ring.classList.toggle('is-loading', arcs.length > 0);
        button.setAttribute('aria-busy', String(arcs.length > 0));
    }
    function render({ updateInspector = true } = {}) {
        // A viewport batch can contain several pages and retry individual cells. Keep one
        // continuous total across those response bodies, including time between reads.
        root.PlanningLoading.set('permitted', 'viewport', status === 'loading' && (policy().permitted !== 'off' || store?.get().zoningAreas !== 'off'));
        paintLoading();
        if (!ready) return;
        const zoning = zoningPanel;
        panel.querySelector('.map-sheet-title').textContent = t('title');
        panel.querySelector('.planning-source-label').textContent = t('sourceEdition');
        const sourceSelect = panel.querySelector('.planning-source-select');
        sourceSelect.setAttribute('aria-label', t('sourceEdition'));
        sourceSelect.value = sourceId;
        const descriptor = sourceOptions.find(source => source.id === sourceId);
        const noPermittedSource = catalogReady && !descriptor;
        sourceSelect.parentElement.hidden = !descriptor;
        const permittedRow = panel.querySelector('[data-role-label="permitted"]').closest('.planning-layer-row');
        permittedRow.classList.toggle('is-unavailable', !descriptor);
        permittedRow.setAttribute('aria-disabled', String(!descriptor));
        permittedRow.title = noPermittedSource ? t('noPermittedSource') : '';
        permittedRow.querySelectorAll('select').forEach(input => { input.disabled = !descriptor; });
        const configurationLink = permittedRow.querySelector('.planning-source-configuration');
        configurationLink.textContent = t('calculationSource');
        configurationLink.hidden = !descriptor;
        if (descriptor) configurationLink.href = sourceConfigurationUrl(descriptor);
        else configurationLink.removeAttribute('href');
        const reference = permittedRow.querySelector('.planning-published-reference');
        const referenceLabel = t('publishedReference');
        reference.querySelector('span').textContent = referenceLabel;
        const sourceLink = reference.querySelector('a');
        const sourceUrl = sourcePlanUrl(descriptor);
        reference.hidden = !sourceUrl;
        if (sourceUrl) {
            if (sourceLink.getAttribute('href') !== sourceUrl) {
                sourceLink.href = sourceUrl;
                sourceLink.textContent = sourceUrl;
            }
            sourceLink.setAttribute('aria-label', `${referenceLabel} (${sourceUrl})`);
        } else {
            sourceLink.removeAttribute('href');
            sourceLink.removeAttribute('aria-label');
            sourceLink.textContent = '';
        }
        const hasZoning = !!descriptor?.capabilities.areas || overviewSource(descriptor);
        zoning.closest('details').hidden = catalogReady && !hasZoning && status !== 'error';
        const mapContext = panel.querySelector('.planning-map-context');
        mapContext.hidden = !!root.__mapModeState?.desired && root.__mapModeState.desired !== '2d';
        mapContext.textContent = t('mapContext');
        zoning.querySelector('.planning-source-note').textContent = hasZoning ? descriptor.label : '';
        zoning.querySelector('.planning-zoning-label').textContent = t('zoningAreas');
        zoning.querySelector('.planning-zoning-field').hidden = !hasZoning;
        // The layer's key follows the uses and edge markings visible on the map.
        const legend = zoning.querySelector('.planning-zone-legend');
        legend.replaceChildren(...legendRows(labels.legend(sceneItems().filter(item => item.areas?.length && appearance(item) !== 'off'), fullT)));
        legend.hidden = !legend.children.length;
        legend.setAttribute('aria-label', t('zoneLegend'));
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
        const permittedNote = descriptor?.parcelStudy ? 'roleSource.envelopes' : descriptor?.capabilities?.volumes
            ? 'roleSource.saved' : hasZoning ? 'roleSource.zoningOnly' : 'roleSource.evidence';
        const centre = root.map?.getCenter?.();
        const buildingNames = (root.CityConfigManager.getBuildingSources?.(centre?.lat, centre?.lng) || [])
            .filter(source => source.use).map(source => source.name || source.id);
        const sourceNotes = { existing: [t('roleSource.built'), buildingNames.join(' · ')].filter(Boolean).join(' '),
            permitted: t(descriptor ? permittedNote : 'noPermittedSource'), proposed: t('roleSource.proposed') };
        for (const role of core.roles) {
            const note = panel.querySelector(`[data-role-source="${role}"]`);
            if (note) note.textContent = sourceNotes[role];
        }
        [...panel.querySelectorAll('[data-planning-setting]'), ...zoning.querySelectorAll('[data-planning-setting]')].forEach(select => {
            select.value = store.get()[select.dataset.planningSetting];
            for (const option of select.options) option.textContent = t(option.value);
        });
        for (const key of ['existingScope', 'permittedScope', 'proposedForm', 'permittedForm', 'permittedMap']) {
            panel.querySelector(`[data-planning-setting="${key}"]`).setAttribute('aria-label', t(key));
        }
        panel.querySelector('.planning-permitted-scope-label').textContent = t('permittedScope');
        renderHeightsChoice();
        const coverageHelp = panel.querySelector('#planning-coverage-help');
        coverageHelp.textContent = t('survivingCoverageHelp');
        coverageHelp.hidden = store.get().permittedScope !== 'surviving';
        zoning.querySelector('[data-planning-setting="zoningAreas"]').setAttribute('aria-label', t('zoningAreas'));
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
        zoning.querySelector('.planning-view-status').hidden = noPermittedSource;
        zoning.querySelector('.planning-view-status').textContent = noPermittedSource ? '' : stateText();
        zoning.querySelector('.planning-view-status').setAttribute('aria-busy', String(status === 'loading'));
        const fit = zoning.querySelector('.planning-fit-plan');
        if (fit) {
            fit.hidden = !overviewSource(descriptor) || root.isThreeModeActive?.() === true;
            fit.textContent = t('fitPlan');
        }
        const retry = zoning.querySelector('.planning-view-retry');
        retry.hidden = !(status === 'error' || status === 'ready' && failedCells) || policy().permitted === 'off' && store.get().zoningAreas === 'off'; retry.textContent = t('retry');
        panel.querySelector('.planning-inspect-hint').textContent = t('inspectHint');
        panel.querySelector('.planning-inspect-hint').hidden = policy().permitted === 'off' && store.get().zoningAreas === 'off' || !sceneItems().length;
        const model = panel.querySelector('.planning-open-model');
        model.hidden = !isPhoto(); model.textContent = t('openModel');
        if (updateInspector) renderInspector();
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
            const wasBuiltVisible = (previous.existing ?? core.defaults.existing) !== 'off';
            if (wasBuiltVisible !== isBuiltVisible()) {
                root.syncBuiltLayerVisibility?.();
                document.dispatchEvent(new CustomEvent('building-layers-changed'));
            }
            if (previous.existingScope !== state.existingScope) root.rebuildBuildingLayerFromPool?.();
            if (previous.existingHeights && previous.existingHeights !== state.existingHeights) {
                const shown = selected();
                if (shown?.role === 'existing' && heightFeatures.has(shown.id)) {
                    if (state.existingHeights === 'survey') measureHeight(shown, heightFeatures.get(shown.id));
                    else dropHeightSurvey(shown);
                }
            }
            if (previous.proposedForm !== state.proposedForm || previous.proposedVariation !== state.proposedVariation) {
                root.updateProposedBuildingsLayer?.({ announce: false });
            }
            root.dispatchEvent(new CustomEvent('planningviewchange', { detail: { settings: core.settings(state), policy: view } }));
            if (!wasBuiltVisible && isBuiltVisible()) root.applyOutlinedSourceScope?.();
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
        // Both layers off: nothing of theirs is shown, so no cell is left to mark as failed.
        else if (settingsChanged) markFailed();
    }
    // Permitted massing loads by cells (planning/scene.js viewCells), as buildings do: the cells under
    // the view, nearest its centre first, a few in flight, each drawn as it lands and kept in
    // `viewCache`, so a view of any size fills in and a pan asks only for cells not yet held. Two
    // answers per cell: envelopes do not depend on the housing type (every configuration ships with
    // the item), zoning areas do, so a housing-type change redraws the envelopes at once and re-reads
    // only the areas, when they are shown. A source re-read clears the cache.
    const viewCache = core.createViewportCache({ limit: 2048, maxAgeMs: 10 * 60 * 1000 });
    const knownPlanPieces = new Map(), changedPieces = new Set();
    let fabricTimer = null;
    function rememberPlanPiece(piece) {
        const entry = { bbox: root.PlanPlots.bbox(piece), parcelIds: [piece.properties.parcelId, ...(piece.properties.cadastreParcelIds || [])] };
        knownPlanPieces.set(piece.properties.parcelId, entry);
        return entry;
    }
    const zoningViewportCache = core.createViewportCache({ limit: 12, maxAgeMs: 10 * 60 * 1000 });
    // Upstream parcel services slow down under parallel reads (Bogotá's times cells out at four), so
    // two cells at a time, and a cell that fails is asked once more, alone, after the rest.
    const CELL_CONCURRENCY = 2;
    const MOVE_REFRESH_DELAY_MS = 300;
    // A zone's pieces from neighbouring cells, joined back into its one shape (scene.js mergeAnswers).
    function joinAreas(areas) {
        try {
            let shape = root.turf.feature(areas[0].geometry);
            for (const area of areas.slice(1)) shape = root.turf.union(shape, root.turf.feature(area.geometry)) || shape;
            return [{ ...areas[0], geometry: shape.geometry }];
        } catch (error) {
            console.error('[planning] Could not join a zone\'s cell pieces', areas[0]?.id, error);
            return areas;
        }
    }
    // What is drawn: the scopes and cells of the answers assembled, and how many cells failed.
    let assembled = '', failedCells = 0;
    function invalidate() { assembled = ''; failedCells = 0; }
    // The cells that could not be loaded even after their retry, hatched (planning/failed-cells.js):
    // the map lays the hatch over the ground, the model view on its ground. Ground still loading is
    // not marked; the status line counts it. `frozen` is the model view zoomed out past the loading
    // gate, where what was drawn stays and nothing more loads.
    const failedGrid = root.PlanningFailedCells;
    let hatch = null, hatchSignature = '', hatchLayer = null, frozen = false;
    function hatchImage(grid) {
        const style = getComputedStyle(document.documentElement);
        const hex = style.getPropertyValue('--cb-planning-failed-hatch').trim().replace('#', '');
        const image = failedGrid.paint(grid, { color: [0, 2, 4].map(at => parseInt(hex.slice(at, at + 2), 16)),
            opacity: Number(style.getPropertyValue('--cb-planning-failed-hatch-opacity')) });
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
        return { bounds: grid.bounds, canvas };
    }
    function drawHatch() {
        if (!hatch) { hatchLayer?.remove(); hatchLayer = null; return; }
        const [west, south, east, north] = hatch.bounds, bounds = [[south, west], [north, east]], url = hatch.canvas.toDataURL();
        if (hatchLayer) { hatchLayer.setUrl(url); hatchLayer.setBounds(bounds); }
        else hatchLayer = root.L.imageOverlay(url, bounds, { pane: 'planningFailed', interactive: false, className: 'planning-failed-cells' }).addTo(root.map);
    }
    // Hatch exactly these cells (keys from failedGrid.cellKey); none clears the hatch.
    function markFailed(keys = []) {
        const grid = failedGrid.grid(keys, core.PLANNING_CELL_DEGREES);
        const signature = failedGrid.signature(grid);
        if (signature === hatchSignature) return;
        hatchSignature = signature;
        hatch = grid && hatchImage(grid);
        drawHatch();
        root.dispatchEvent(new CustomEvent('planningfailedcellschange'));
    }
    // The cells drawn now (scene.js retainDrawn): a cell stays until its replacement lands or it
    // leaves the range around the view, so a camera tilt or pan never takes down what is in range.
    const drawn = new Map();
    // The 2D zoom from which zoning areas load, and the one from which massing does too: a zone is one
    // light request per cell, a massing a parcel read and a solve per lot.
    const ZONING_ZOOM = 15, MASSING_ZOOM = 16;
    // Zoning areas are drawn while massing waits for a closer zoom (stateText says so).
    let massingWaits = false;
    // The model view below its loading gate: what is drawn stays, nothing new loads.
    function freeze() {
        viewCache.abortExcept([]); zoningViewportCache.abortExcept([]); request++;
        if (status === 'loading') status = 'ready';
        frozen = true;
        render();
    }
    function resetOverview(id = '') {
        if (id === overviewSourceId) return;
        if (overviewLayer && root.map.hasLayer(overviewLayer)) root.map.removeLayer(overviewLayer);
        overviewSourceId = id;
        overview = null; overviewRead = null; overviewLayer = null; overviewDisplay = ''; overviewOnly = false;
    }
    async function refreshOverview(descriptor, { only }) {
        resetOverview(descriptor.id);
        const becameOnly = only && !overviewOnly;
        overviewOnly = only;
        if (becameOnly) {
            request++;
            viewCache.abortExcept([]); zoningViewportCache.abortExcept([]);
            invalidate(); drawn.clear(); items = []; payload = null; progress = null;
            markFailed();
            status = overview ? 'ready' : 'loading'; drawMap(); render({ updateInspector: false }); notifyGeometry();
        }
        if (overview || overviewRead) return;
        if (only) { status = 'loading'; render({ updateInspector: false }); }
        const pending = root.PlanningLoading.track('permitted', root.ZoningOverview.load(descriptor));
        overviewRead = pending;
        try {
            const data = await pending;
            if (overviewRead !== pending || sourceId !== descriptor.id) return;
            overview = data;
            if (overviewOnly) status = 'ready';
            drawMap(); render();
            restoreSelection();
        } catch (error) {
            if (overviewRead !== pending) return;
            console.error('[planning] Could not load the zoning overview', error);
            if (overviewOnly) { status = 'error'; render(); }
        } finally {
            if (overviewRead === pending) overviewRead = null;
        }
    }
    async function refresh({ force = false } = {}) {
        if (!ready || !catalogReady) return;
        if (policy().permitted === 'off' && store.get().zoningAreas === 'off') { resetOverview(); markFailed(); return; }
        // The 2D map's view in 2D; in 3D, the 2D view the camera stands for, around its target (load-view.js).
        const view = root.LoadView.current();
        const currentSource = sourceOptions.find(source => source.id === sourceId);
        const useOverview = view?.mode === '2d' && store.get().zoningAreas !== 'off' && overviewSource(currentSource)
            && view.zoom < (currentSource.zoningOverview.detailZoom ?? Infinity);
        if (useOverview) {
            frozen = false;
            const only = view.zoom < MASSING_ZOOM || policy().permitted === 'off';
            const load = refreshOverview(currentSource, { only });
            if (only) return load;
        } else resetOverview();
        // In 3D a camera tilted toward straight down reads as a lower zoom: what is drawn stays (it is
        // all still in range), only new cells stop loading below the lowest gate of what is shown
        // (zoning areas load from ZONING_ZOOM). The 2D map below the gate draws none.
        const drawn3d = view?.mode === '3d' && drawn.size > 0;
        if (drawn3d && view.zoom < (store.get().zoningAreas !== 'off' ? ZONING_ZOOM : MASSING_ZOOM)) { freeze(); return; }
        frozen = false;
        const zoningOnly = view && view.zoom >= ZONING_ZOOM && view.zoom < MASSING_ZOOM && store.get().zoningAreas !== 'off';
        if (!view || (view.zoom < MASSING_ZOOM && !zoningOnly)) {
            massingWaits = false;
            markFailed();
            viewCache.abortExcept([]); zoningViewportCache.abortExcept([]); request++; invalidate(); drawn.clear(); items = []; status = 'zoom'; payload = null;
            if (!selected()) store.select(null);
            drawMap(); render(); notifyGeometry(); return;
        }
        const city = root.CityConfigManager.getCurrentCityId();
        const bbox = view.bbox;
        if (force) { viewCache.clear(); zoningViewportCache.clear(); invalidate(); }
        // Bounds-registered sources come and go with the viewport; re-list them when it moves.
        const wholePlanZoning = currentSource?.viewportZoning && overviewSource(currentSource);
        if (!wholePlanZoning && !(await ensureSources(city, bbox))) return;
        // The city's planning designations (restrictions.js) are read for the view beside the source
        // cells; the map reads only those that cut the envelope. They land on their own and redraw.
        loadRestrictions(city, bbox);
        const descriptor = sourceOptions.find(source => source.id === sourceId);
        const canLoadEnvelopes = Boolean(descriptor?.parcelStudy || descriptor?.planPlotCalculation === true);
        const envelopeScope = canLoadEnvelopes && policy().permitted !== 'off' && !zoningOnly ? `envelopes:${city}:${sourceId}` : '';
        massingWaits = Boolean(zoningOnly && canLoadEnvelopes && policy().permitted !== 'off');
        // A source without zoning areas answers representations with massing, which waits as envelopes do.
        const areaScope = descriptor && (descriptor.capabilities.areas ? store.get().zoningAreas !== 'off' : !zoningOnly && !descriptor.planPlotCalculation)
            ? `areas:${city}:${sourceId}:${scenarioId}` : '';
        if (zoningOnly && !areaScope && drawn3d) { freeze(); return; }
        if (zoningOnly && !areaScope) {
            massingWaits = false;
            viewCache.abortExcept([]); zoningViewportCache.abortExcept([]); request++; invalidate(); drawn.clear(); items = []; status = 'zoom'; payload = null;
            markFailed(); if (!selected()) store.select(null);
            drawMap(); render(); notifyGeometry(); return;
        }
        const viewportZoning = Boolean(areaScope && descriptor?.viewportZoning);
        const cells = envelopeScope || areaScope && !viewportZoning ? core.viewCells(bbox, view.centre) : [];
        const jobs = [];
        for (const [kind, scope] of [['envelopes', envelopeScope], ['areas', areaScope]]) {
            if (!scope) continue;
            const wholeView = kind === 'areas' && viewportZoning;
            const bounds = wholeView ? bbox.map(value => Number(value.toFixed(6))) : null;
            const requested = wholeView ? [{ bbox: bounds, key: bounds.join(','), distanceM: -1 }] : cells;
            for (const cell of requested) jobs.push({ kind, scope, cell, wholeView, key: `${scope}|${cell.key}` });
        }
        const generation = ++request;
        // Only this view's cells keep loading; an older view's others stop.
        for (const [wholeView, cache] of [[false, viewCache], [true, zoningViewportCache]]) {
            cache.abortExcept(jobs.filter(job => job.wholeView === wholeView).map(job => cache.keyOf(job.scope, job.cell.bbox)));
        }
        const cacheFor = job => job.wholeView ? zoningViewportCache : viewCache;
        const answers = new Map();
        const pending = jobs.filter(job => {
            const hit = cacheFor(job).find(job.scope, job.cell.bbox);
            if (hit) answers.set(job.key, hit.value);
            return !hit;
        });
        const composition = jobs.map(job => job.key).sort().join(';');
        let failed = 0;
        const failedKeys = new Set();
        const range = core.rangeAround(bbox, view.mode === '3d' ? { centre: view.centre, reachM: view.reachM } : {});
        // The model view between the gates keeps the massing it drew in range and loads no more of it.
        const paused = drawn3d && zoningOnly && canLoadEnvelopes && policy().permitted !== 'off' ? [`envelopes:${city}:${sourceId}`] : [];
        const assemble = () => {
            const wholeView = jobs.find(job => job.wholeView);
            if (wholeView && answers.has(wholeView.key)) {
                for (const [key, previous] of drawn) {
                    if (previous.scope === wholeView.scope && key !== wholeView.key) drawn.delete(key);
                }
            }
            const ordered = core.retainDrawn(drawn, { jobs, answers, range, keep: paused });
            markFailed([...failedKeys]);
            // Envelopes lead: their answer says how the status line counts.
            const merged = core.mergeAnswers([...ordered.filter(answer => answer.envelopes), ...ordered.filter(answer => !answer.envelopes)], { joinAreas });
            payload = withRestrictions(merged || { sources: descriptor ? [descriptor] : [], summaries: [], unavailable: [], omitted: 0, items: [] }, descriptor, city);
            items = payload.items; assembled = composition; failedCells = failed;
            if (!selected()) store.select(null);
            drawMap(); render(); notifyGeometry();
        };
        reassemble = assemble;
        if (!pending.length) {
            if (assembled !== composition || status !== 'ready') { status = 'ready'; assemble(); }
            // The same cells under a moved view, all of them loaded: none is failed.
            else markFailed();
            return;
        }
        const url = new URL(`${root.getBackendBase()}/planning/representations`);
        url.searchParams.set('city', city);
        if (sourceId) url.searchParams.set('source', sourceId);
        const scenario = scenarioParam();
        const fetchCell = ({ kind, cell, wholeView }) => signal => {
            const box = cell.bbox;
            const target = new URL(url); target.searchParams.set('bbox', box.join(','));
            if (kind === 'envelopes') target.pathname = '/planning/envelopes';
            else if (scenario) target.searchParams.set('scenario', scenario);
            if (wholeView) target.searchParams.set('limit', '1000');
            const pieces = kind === 'envelopes' && root.PlanPlots && root.LiveParcelFabric ? root.PlanPlots.forBox(root.LiveParcelFabric, box) : [];
            const options = { cessions: new Map() };
            const plots = pieces.map(piece => {
                if (root.PlanPlots.isPlanPiece(piece)) rememberPlanPiece(piece);
                return root.PlanPlots.toPlot(root.LiveParcelFabric, piece, options);
            });
            return root.PlanningFeed.loadViewport(target, { city, signal, readJson: readPermittedJson, body: plots.length ? { city, source: sourceId, scenario: scenario || undefined, bbox: box, plots } : undefined })
                .then(answer => (kind === 'envelopes' ? { ...answer, envelopes: true } : answer));
        };
        status = 'loading'; progress = { count: jobs.length - pending.length, total: jobs.length };
        if (answers.size) assemble(); else render({ updateInspector: false });
        // Redraw when the first cell lands and then at each quarter, as the 3D buildings do.
        let done = jobs.length - pending.length, nextDrawAt = done + 1, firstError = null;
        const queue = [...pending].sort((a, b) => a.cell.distanceM - b.cell.distanceM), retries = [];
        const loadJob = async job => {
            try { answers.set(job.key, (await cacheFor(job).load(job.scope, job.cell.bbox, fetchCell(job))).value); return true; }
            catch (error) {
                if (generation !== request || error.name === 'AbortError') return null;
                firstError ||= error; return false;
            }
        };
        const worker = async () => {
            while (queue.length && generation === request) {
                const job = queue.shift();
                const loaded = await loadJob(job);
                if (loaded === null || generation !== request) return;
                if (!loaded) { retries.push(job); continue; }
                done++; progress = { count: done, total: jobs.length };
                if (done >= nextDrawAt && done < jobs.length) {
                    nextDrawAt = Math.max(done + 1, Math.ceil(jobs.length * (Math.floor(done / jobs.length * 4) + 1) / 4));
                    assemble();
                } else render({ updateInspector: false });
            }
        };
        await Promise.all(Array.from({ length: Math.min(CELL_CONCURRENCY, queue.length) }, worker));
        if (generation !== request) return;
        for (const job of retries) {
            const loaded = await loadJob(job);
            if (loaded === null || generation !== request) return;
            if (loaded) { done++; progress = { count: done, total: jobs.length }; assemble(); }
            else {
                failed++;
                if (!job.wholeView) failedKeys.add(failedGrid.cellKey(job.cell.bbox, core.PLANNING_CELL_DEGREES));
            }
        }
        if (firstError) console.error(`[planning] ${failed} of ${jobs.length} cells could not be loaded`, firstError);
        // Nothing loaded: a source refusing every cell (400) is asked for less by zooming in.
        // What was drawn in range stays; with nothing drawn the layer is empty.
        if (failed && failed === jobs.length) {
            invalidate(); status = firstError?.status === 400 ? 'zoom' : 'error';
            assemble(); return;
        }
        status = 'ready'; assemble();
        restoreSelection();
    }
    // ---- planning designations (restrictions stage) --------------------------------------------
    // The latest designation read for the view, by city; `reassemble` redraws the current view with it.
    let restrictionView = null, restrictionRequest = 0, reassemble = null;
    function loadRestrictions(city, bbox) {
        const feed = root.PlanningRestrictionFeed;
        if (!feed?.ruleSetIds(city).length) { restrictionView = null; return; }
        const id = ++restrictionRequest;
        feed.load(city, bbox, { effects: ['prohibit'] }).then(reads => {
            if (id !== restrictionRequest || !reads) return;
            restrictionView = { city, reads, error: null };
            reassemble?.();
        }).catch(error => {
            if (id !== restrictionRequest) return;
            console.error(`[${new Date().toISOString()}] [planning] Planning designations could not be read`, error);
            restrictionView = { city, reads: [], error };
            reassemble?.();
        });
    }
    // The answer with the restrictions stage applied: prohibited areas cut from the source's items,
    // or, with no source here, the prohibited areas themselves ("unknown base").
    // Results are kept while the read and the map's buildings stay the same, so a redraw finds the
    // same item objects and draws nothing again (drawMap compares items by identity).
    let restrictionMemo = null;
    const cutItems = new WeakMap();
    function withRestrictions(answer, descriptor, city) {
        const view = restrictionView?.city === city ? restrictionView : null;
        if (!view) return answer;
        const pool = root.buildingFeaturePool;
        if (restrictionMemo?.reads !== view.reads || restrictionMemo.pool !== pool) {
            const box = view.reads[0]?.bbox;
            restrictionMemo = { reads: view.reads, pool, base: null,
                resolved: box ? root.PlanningRestrictionFeed.resolve(view.reads, box) : { restrictions: [], partial: false } };
        }
        const { restrictions, partial } = restrictionMemo.resolved;
        const ruleSets = view.reads.map(read => read.ruleSet);
        const items = descriptor ? answer.items.map(item => {
            const known = cutItems.get(item);
            if (known?.restrictions === restrictions) return known.item;
            const [result] = root.PlanningRestrictions.applyToItems([item], restrictions, { geometryOps: root.turf });
            cutItems.set(item, { restrictions, item: result });
            return result;
        }) : (restrictionMemo.base ??= root.PlanningRestrictions.unknownBaseItems(restrictions, ruleSets));
        return { ...answer, items, restrictions: { partial, failed: Boolean(view.error), baseRule: descriptor ? null : 'unknown', ruleSets } };
    }
    // A listed building given as a point takes its footprint from the buildings the map holds: when
    // they arrive, the designations are placed again.
    let buildingRedraw = 0;
    root.addEventListener('buildingPoolUpdated', () => {
        if (!restrictionView || buildingRedraw) return;
        buildingRedraw = requestAnimationFrame(() => { buildingRedraw = 0; reassemble?.(); });
    });
    function restrictionNote() {
        const state = payload?.restrictions;
        if (!state) return '';
        return (state.partial ? ` · ${t('designationsPartial')}` : '') + (state.failed ? ` · ${t('designationsFailed')}` : '');
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
    function viewportBbox() { return root.LoadView?.current()?.bbox || null; }
    function listSources(city, bbox) {
        const url = new URL(`${root.getBackendBase()}/planning/sources`);
        url.searchParams.set('city', city);
        if (bbox) url.searchParams.set('bbox', bbox.join(','));
        return root.PlanningLoading.track('permitted', fetch(url, { cache: 'no-store' }).then(async response => {
            if (!response.ok) throw new Error(`Planning sources HTTP ${response.status}`);
            const answer = await readPermittedJson(response);
            if (!Array.isArray(answer.sources)) throw new Error('Invalid planning sources response');
            const configured = root.CityConfigManager.getCityConfig(city)?.planning?.sourceIds || [];
            return configured.map(id => answer.sources.find(source => source.id === id)).filter(Boolean)
                .map((source, index) => ({ ...source, default: index === 0 }));
        }));
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
            // An ID alone is not a display contract: parcelStudy changes the permitted choices.
            if (core.sourceCatalogSignature(sources) !== core.sourceCatalogSignature(sourceOptions)) applySources(sources);
            if (previousSource !== sourceId || previousScenario !== scenarioId) { pins = {}; invalidate(); render(); }
            showZoningMap(previousSource);
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
            const previousSource = sourceId;
            applySources(sources, new URLSearchParams(location.search).get('planningSource'));
            showZoningMap(previousSource);
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
        zoningPanel = document.getElementById('layers-zoning-controls');
        inspector = document.getElementById('planning-inspector');
        // The Display tab holds the layer controls; the Compare tab is three-compare.js's.
        const body = panel.querySelector('[data-planning-tab-panel="display"]') || panel.querySelector('.map-sheet-body');
        // The selected plan and housing scenario govern Permitted massing. The zoning
        // layer uses the same plan and carries its own visibility, extent and colour key.
        for (const selector of ['.planning-view-status', '.planning-view-retry']) {
            const node = body.querySelector(selector); if (node) zoningPanel.append(node);
        }
        body.prepend(element('p', 'planning-map-context'));
        const sourceField = element('label', 'planning-source-field');
        sourceField.append(element('span', 'planning-source-label'));
        const sourceInput = element('select', 'planning-layer-select planning-source-select');
        sourceField.append(sourceInput); zoningPanel.prepend(element('p', 'planning-source-note'));
        const configurationLink = element('a', 'cb-link cb-link--external planning-source-configuration');
        configurationLink.hidden = true; configurationLink.target = '_blank'; configurationLink.rel = 'noopener noreferrer';
        const reference = element('div', 'planning-published-reference');
        reference.hidden = true;
        const sourceLink = element('a', 'cb-link cb-link--external planning-source-url');
        sourceLink.target = '_blank'; sourceLink.rel = 'noopener noreferrer'; sourceLink.dir = 'ltr';
        reference.append(element('span'), ' ', sourceLink);
        const scenarioField = element('label', 'planning-source-field');
        scenarioField.append(element('span', 'planning-scenario-label'));
        const scenarioInput = element('select', 'planning-layer-select planning-scenario-select');
        scenarioField.append(scenarioInput);
        scenarioInput.addEventListener('change', () => {
            // Envelopes keep their selection: they carry every housing type and only redraw. A
            // selected zoning area is re-read for the new type and re-selected when it returns.
            const previousId = selected()?.areas?.length ? store.get().selectedId : null;
            scenarioId = scenarioInput.value; pins = {};
            assembled = ''; items = items.filter(item => item.parcelEnvelope);
            if (previousId) { focusedRecord = null; store.select(null); restoreId = previousId; }
            const url = new URL(location.href); url.searchParams.set('planningScenario', scenarioId); history.replaceState(history.state, '', url);
            drawMap(); render(); notifyGeometry(); refresh();
        });
        sourceInput.addEventListener('change', () => {
            if (sourceInput.value === sourceId) return;
            const clearSourceSelection = selected()?.role === 'permitted';
            const previousSource = sourceId;
            sourceId = sourceInput.value; pins = {}; scenarioId = ''; viewCache.abortExcept([]); request++; invalidate(); items = []; payload = null;
            populateScenarios();
            showZoningMap(previousSource);
            if (clearSourceSelection) { focusedRecord = null; store.select(null); }
            const url = new URL(location.href); url.searchParams.set('planningSource', sourceId);
            url.searchParams.set('planningScenario', scenarioId); history.replaceState(history.state, '', url);
            drawMap(); render(); notifyGeometry(); refresh({ force: true });
            if (parcelPanel?.container.isConnected) showParcelEvidence(parcelPanel.container, parcelPanel.parcel);
        });
        const controls = panel.querySelector('.planning-layer-controls');
        function control(key, input = element('select', 'planning-layer-select')) {
            input.dataset.planningSetting = key;
            for (const value of core.choices[key]) input.add(new Option(t(value), value));
            input.addEventListener('change', () => {
                // A source with just Illustration keeps the saved preference for other editions.
                if (input.options.length > 1) store.configure(key, input.value);
            });
            return input;
        }
        for (const role of ['permitted', 'existing', 'proposed']) {
            const row = element('div', 'planning-layer-row'); row.dataset.role = role;
            const disclosure = element('details', 'planning-role-disclosure');
            const summary = element('summary', 'planning-layer-summary');
            const label = element('span', 'planning-layer-label'); label.dataset.roleLabel = role; label.id = `planning-role-label-${role}`;
            const swatch = element('span', `planning-swatch planning-swatch--${role}`); swatch.setAttribute('aria-hidden', 'true');
            const name = element('span', 'planning-layer-name'); name.append(swatch, label);
            const loadingBar = element('span', `planning-loading-bar planning-loading-bar--${role}`);
            loadingBar.dataset.planningLoading = role; loadingBar.hidden = true; loadingBar.setAttribute('role', 'progressbar');
            loadingBar.setAttribute('aria-labelledby', label.id);
            const counter = element('span', 'planning-loading-count');
            counter.hidden = true; counter.setAttribute('aria-hidden', 'true');
            const heading = element('span', 'planning-layer-heading');
            heading.append(name, counter);
            const content = element('div', 'planning-layer-detail');
            const roleControl = control(role, document.getElementById(`planning-${role}-appearance`));
            summary.append(heading);
            if (role === 'existing') {
                const scope = control('existingScope');
                scope.id = 'planning-existing-scope';
                // Heights: a height survey's (named by it) or the building source's, where a survey covers the map.
                const heights = element('label', 'planning-source-field planning-existing-heights');
                heights.hidden = true;
                heights.append(element('span', 'planning-existing-heights-label'), control('existingHeights'));
                content.append(scope, heights, document.getElementById('planning-built-sources'));
            } else {
                const formRow = element('div', 'planning-form-row');
                formRow.append(control(`${role}Form`), panel.querySelector(`[data-planning-reroll="${role}"]`));
                content.append(formRow);
            }
            if (role === 'permitted') {
                const coverage = element('label', 'planning-source-field');
                const scope = control('permittedScope');
                const help = element('p', 'planning-layer-source-note');
                help.id = 'planning-coverage-help'; scope.setAttribute('aria-describedby', help.id);
                coverage.append(element('span', 'planning-permitted-scope-label'), scope);
                content.append(coverage, help, sourceField, configurationLink, reference, scenarioField, control('permittedMap'));
            }
            const sourceNote = element('p', 'planning-layer-source-note'); sourceNote.dataset.roleSource = role; content.append(sourceNote);
            disclosure.append(summary, content); row.append(disclosure, roleControl, loadingBar); controls.append(row);
        }
        const zoningField = element('label', 'planning-source-field planning-zoning-field');
        const zoningVisibility = control('zoningAreas');
        zoningVisibility.id = 'planning-zoning-areas';
        zoningField.append(element('span', 'planning-zoning-label'), zoningVisibility); zoningPanel.append(zoningField);
        const fit = element('button', 'btn planning-fit-plan', t('fitPlan'));
        fit.type = 'button'; fit.hidden = true;
        zoningField.after(fit);
        fit.addEventListener('click', async () => {
            if (root.BusyControl.isBusy(fit)) return;
            const source = sourceOptions.find(option => option.id === sourceId);
            try {
                await root.BusyControl.track(fit, async () => {
                    const { bbox: [west, south, east, north] } = await root.ZoningOverview.load(source);
                    if (source.id !== sourceId || root.isThreeModeActive?.()) return;
                    root.MapShell?.closeSheet({ restoreFocus: true });
                    root.map.fitBounds([[south, west], [north, east]], {
                        paddingTopLeft: [24, 52], paddingBottomRight: [24, 74], maxZoom: 14, animate: false
                    });
                    if (store.get().zoningAreas === 'off') {
                        zoningChosen = true;
                        store.configure('zoningAreas', 'ghost');
                    }
                });
            } catch (error) {
                console.error('[planning] Could not fit the zoning overview', error);
                root.updateStatus?.(t('error'));
            }
        });
        const legend = element('ul', 'planning-zone-legend'); legend.hidden = true; zoningPanel.append(legend);
        zoningField.querySelector('select').addEventListener('change', () => { zoningChosen = true; });
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
        // A failed cell is never kept, so asking again reads only the cells that failed.
        const retry = zoningPanel.querySelector('.planning-view-retry');
        retry.addEventListener('click', () => {
            if (!root.BusyControl.isBusy(retry)) root.BusyControl.track(retry, () => { assembled = ''; return refresh(); });
        });
        root.map.createPane('planningFailed');
        root.map.getPane('planningFailed').classList.add('planning-failed-pane');
        root.map.createPane('planningSources');
        root.map.getPane('planningSources').classList.add('planning-sources-pane');
        layer = root.L.featureGroup().addTo(root.map);
        selectionLayer = root.L.featureGroup().addTo(root.map);
        ready = true;
        // Fabric changes invalidate only envelope cells whose plot cover or frontage can change.
        // Keep the last geometry for removed pieces: publish removes it before notifying us.
        const onFabricDelta = delta => {
            if (!root.PlanPlots) return;
            for (const id of new Set([...delta.addedIds, ...delta.updatedIds, ...delta.removedIds])) {
                const previous = knownPlanPieces.get(id);
                if (previous) { changedPieces.add(previous); knownPlanPieces.delete(id); }
                const piece = root.LiveParcelFabric.peek(id);
                if (root.PlanPlots.isPlanPiece(piece)) changedPieces.add(rememberPlanPiece(piece));
            }
            if (!changedPieces.size) return;
            request++;
            clearTimeout(fabricTimer);
            fabricTimer = setTimeout(() => {
                const dirty = [...changedPieces];
                changedPieces.clear();
                const cityPrefix = `envelopes:${root.CityConfigManager.getCurrentCityId()}:`;
                const affected = entry => entry.scope.startsWith(cityPrefix) && dirty.some(change =>
                    root.PlanPlots.intersects(change.bbox, root.PlanPlots.expand(entry.bbox)));
                viewCache.evict(affected);
                const stale = new Set(dirty.flatMap(change => change.parcelIds));
                for (const [key, cell] of drawn) if (affected(cell)) {
                    for (const item of cell.value.items || []) stale.add(item.id);
                    drawn.delete(key);
                }
                items = items.filter(item => !stale.has(item.id) && !stale.has(item.source?.parcel));
                if (payload) payload = { ...payload, items };
                invalidate(); drawMap(); render(); notifyGeometry(); refresh();
            }, 150);
        };
        root.LiveParcelFabric?.subscribe?.(onFabricDelta);
        document.getElementById('planning-views-button').hidden = false;
        document.getElementById('layers-open-buildings').hidden = false;
        store.subscribe(syncView);
        // A pan is a burst of moveends: re-read once the map has settled, and not at all when it
        // moves again first. A request already in flight is cancelled by the next refresh that no
        // longer wants it.
        let moveTimer = null;
        const cancelMoveRefresh = () => { if (moveTimer) clearTimeout(moveTimer); moveTimer = null; };
        root.map.on('movestart', cancelMoveRefresh);
        const scheduleMoveRefresh = () => {
            cancelMoveRefresh();
            moveTimer = setTimeout(() => { moveTimer = null; refresh(); }, MOVE_REFRESH_DELAY_MS);
        };
        root.map.on('moveend', scheduleMoveRefresh);
        // The 3D camera settling, or the map changing mode, moves the area too (load-view.js).
        root.addEventListener('loadviewchange', scheduleMoveRefresh);
        root.map.on('click', () => select(null));
        root.addEventListener('cityChanged', () => {
            clearTimeout(fabricTimer); knownPlanPieces.clear(); changedPieces.clear();
            viewCache.clear(); zoningViewportCache.clear(); sourceListings.clear(); request++; invalidate();
            resetOverview(); items = []; payload = null; status = 'loading';
            sourceOptions = []; sourceId = ''; scenarioId = ''; pins = {}; sourcesKey = ''; focusedRecord = null; restoreId = null; catalogReady = false; parcelPanel = null;
            store.select(null); drawMap(); render(); notifyGeometry(); loadSources();
        });
        root.addEventListener('proposedBuildingsUpdated', render);
        document.addEventListener('proposalStorageChanged', () => {
            if (store.get().permittedScope !== 'surviving' || policy().proposed === 'off') return;
            drawMap(); notifyGeometry();
        });
        root.addEventListener('buildingsLayerUpdated', restoreSelection);
        root.addEventListener('i18n:translationsLoaded', render);
        root.addEventListener('mapmodechange', render);
        // Built → Heights appears once the height surveys are read, and follows the map to where one covers it.
        root.HeightSurveyClient?.ready?.then(() => renderHeightsChoice());
        root.map.on('moveend', renderHeightsChoice);
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
        isBuiltVisible, setBuiltVisible,
        getAppearance: appearance,
        getSelected: selected, isReady: () => ready, isInspecting: () => ready && !inspector.hidden,
        select, selectRecord, inspectBuilding, inspectProposal, showParcelEvidence, color, itemColor, itemTitle, warningColor, refresh,
        permittedFeatures, pinConfiguration, getScenario: () => scenarioId, getSource: () => sourceId,
        getSourceDescriptor: () => sourceOptions.find(source => source.id === sourceId) || null,
        // The hatch over cells that failed to load, as { bounds: [west, south, east, north], canvas }, or null.
        getFailedCells: () => hatch,
        // Drawn records covering a point, each once, in drawing order.
        itemsAt(latlng) {
            const point = root.turf.point([latlng.lng, latlng.lat]), seen = new Set();
            const detailed = hitShapes.filter(({ item, feature }) => {
                if (seen.has(item.id)) return false;
                try { if (!root.turf.booleanPointInPolygon(point, feature)) return false; } catch (_) { return false; }
                seen.add(item.id); return true;
            }).map(({ item }) => item);
            return showingOverview() ? [...detailed, ...root.ZoningOverview.hitsAt(overview.entries, point, root.turf)] : detailed;
        },
        selectAt: select,
        configure: (key, value) => store?.configure(key, value), reroll: role => store?.reroll(role) };
    root.whenMapCoreReady().then(init);
})(window);
