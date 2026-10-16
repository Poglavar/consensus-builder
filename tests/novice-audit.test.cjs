const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
function browser(extra = {}) {
    const context = vm.createContext({ console: quiet, setTimeout, clearTimeout, AbortController, URLSearchParams, Date, ...extra });
    context.window = context;
    return context;
}
function load(context, file) { vm.runInContext(read('frontend/js/' + file), context, { filename: file }); }
const plain = value => JSON.parse(JSON.stringify(value));
const site = { type: 'MultiPolygon', coordinates: [[[[15, 45], [15.001, 45], [15.001, 45.001], [15, 45]]]] };

function designShell(coverage, extra = {}) {
    const calls = { draft: 0, opened: 0, bindings: 0, messages: [] };
    const context = browser({
        CityConfigManager: { getCurrentCityId: () => 'new_york' },
        LiveParcelFabric: { get: id => ({ type: 'Feature', properties: { parcelId: id }, geometry: site }) },
        __siteDraft: { siteFromFeatures: () => site },
        resolveBackendBaseUrl: () => 'https://example.invalid', fetch() {},
        __publishBinding: { createFetchBinding: () => async () => {
            calls.bindings++;
            if (coverage instanceof Error) throw coverage;
            return { coverage, source: 'server:test', parcels: [] };
        } },
        proposalDraftStore: { createDraft: input => { calls.draft++; calls.draftInput = input; return { id: 'draft-1', ...input }; } },
        openProposalDraftDesign: async () => { calls.opened++; return true; },
        updateStatus: text => calls.messages.push(text), showStyledAlert: text => calls.messages.push(text),
        ...extra
    });
    load(context, 'proposal-editor-shell.js');
    return { context, calls };
}

test('F1: unsupported New York Block is explained before creating a draft or opening an editor', async () => {
    const { context, calls } = designShell('unknown');
    const selection = ['US-NY-6201001001220001'];
    assert.equal(await context.startInstantProposalDesign('buildings', selection), false);
    assert.equal(calls.draft, 0); assert.equal(calls.opened, 0);
    assert.deepEqual(selection, ['US-NY-6201001001220001']);
    assert.match(calls.messages[0], /could not be verified/);
});
test('F1: supported Block opens, including site-first creation', async () => {
    const { context, calls } = designShell('complete');
    assert.equal(await context.startInstantProposalDesign('buildings', ['HR-339164-2536']), true);
    assert.equal(calls.draft, 1); assert.equal(calls.opened, 1);
    assert.equal(calls.draftInput.fields.binding, undefined, 'preflight never grants a save-time binding');
    assert.deepEqual(plain(calls.draftInput.editorPayload), {});
    assert.equal(await context.startInstantSiteDesign('buildings', { site }, ['design-site']), true);
    assert.equal(calls.draft, 2); assert.equal(calls.opened, 2);
});
test('F1: unavailable binding service preserves site, and Detached keeps its independent path', async () => {
    const { context, calls } = designShell(new Error('offline'));
    const input = { site: plain(site) };
    assert.equal(await context.startInstantSiteDesign('buildings', input, ['design-site']), false);
    assert.deepEqual(input, { site });
    assert.equal(calls.draft, 0);
    assert.equal(await context.startInstantProposalDesign('parcelBased', ['US-NY-6201001001220001']), true);
    assert.equal(calls.bindings, 1);
});
test('F1: failed save-time binding retains the draft and immutable source', async () => {
    const retained = { id: 'draft-1', adapterKey: 'buildings', fields: { site }, editorPayload: { placement: { free: true, site } }, sourceSnapshot: { proposalId: 'original' } };
    const before = JSON.stringify(retained);
    let updates = 0;
    const { context } = designShell('unknown', {
        proposalDraftStore: { getDraft: () => retained, updateDraft: () => { updates++; } }
    });
    load(context, 'proposals/site-draft.js');
    load(context, 'proposal-editor-adapters.js');
    await assert.rejects(context.rebindFreePlacementDraft('draft-1'), /cannot verify/);
    assert.equal(updates, 0); assert.equal(JSON.stringify(retained), before);
});

test('F1/F5: edited geometry, source relation and terms survive draft storage reload', () => {
    const c = browser(); load(c, 'proposal-drafts.js');
    const data = new Map();
    const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
    const store = c.createProposalDraftStore({ storage, idFactory: () => 'saved-draft' });
    const original = { proposalId: 'p-tbf5hk3wji', title: 'Square · parcel 2541', applied: true, offer: 1234, offerCurrency: 'EUR' };
    const before = JSON.stringify(original);
    store.createDraft({ goal: 'square', sourceProposalId: original.proposalId, sourceSnapshot: original,
        fields: { site, name: original.title, offer: original.offer, offerCurrency: original.offerCurrency },
        editorPayload: { geometry: site, decorations: { benches: [{ x: 1, y: 2 }] } } });
    store.flush();
    const reloaded = c.createProposalDraftStore({ storage }).getDraft('saved-draft');
    assert.equal(reloaded.sourceProposalId, original.proposalId);
    assert.deepEqual(plain(reloaded.editorPayload.decorations.benches), [{ x: 1, y: 2 }]);
    assert.equal(reloaded.fields.offer, 1234); assert.equal(reloaded.fields.offerCurrency, 'EUR');
    assert.equal(JSON.stringify(original), before);
});

const proj4 = require('../frontend/vendor/proj4-2.22.0/proj4.js');
function geometryContext() {
    const context = browser({ proj4 });
    load(context, 'metric-frame.js'); load(context, 'corridor-geometry.js');
    return context;
}
function auditTrack() {
    // Invert Leaflet's EPSG:3857 pixel coordinates at z19. The viewport offset is immaterial;
    // use the first click at the reported latitude and preserve the audited screen deltas.
    const size = 256 * 2 ** 19, firstLat = 45.80604, firstLng = 15.97834;
    const y = (1 - Math.asinh(Math.tan(firstLat * Math.PI / 180)) / Math.PI) / 2 * size;
    return [[0, 0], [0, 175], [-65, 205]].map(([dx, dy]) => ({
        lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + dy) / size))) * 180 / Math.PI,
        lng: firstLng + dx / size * 360
    }));
}
test('F2: audited screen clicks reconstruct ~51.3m and a measured radius below 300m', () => {
    const c = geometryContext(), points = auditTrack();
    const frame = c.__metricFrame.frameFor(points);
    const xy = points.map(p => frame.latLngToMetric(p.lat, p.lng));
    const length = Math.hypot(xy[1][0] - xy[0][0], xy[1][1] - xy[0][1]) + Math.hypot(xy[2][0] - xy[1][0], xy[2][1] - xy[1][1]);
    assert.ok(length > 51 && length < 52, String(length));
    const radius = c.CorridorGeometry.calculateCurvatureRadius(...points);
    assert.ok(radius > 15 && radius < 40, String(radius));
    const result = c.CorridorGeometry.checkCurvatureConstraint(points.slice(0, 2), points[2], 300);
    assert.equal(result.valid, false); assert.equal(result.violatesConstraint, true);
    assert.ok(c.CorridorGeometry.findCurvatureViolation([points], 300));
});
test('F2: straight and broad tracks pass, reversals and seeded tight tracks fail', () => {
    const c = geometryContext(), g = c.CorridorGeometry;
    const f = c.__metricFrame.frameFor(auditTrack());
    const point = (x, y) => { const [lat, lng] = f.metricToLatLng(x, y); return { lat, lng }; };
    const straight = [point(0, 0), point(100, 0), point(200, 0)];
    const broad = [point(0, 0), point(100, 0), point(200, 5)];
    assert.equal(g.findCurvatureViolation([straight, broad], 300), null);
    assert.ok(g.findCurvatureViolation([[point(0, 0), point(100, 0), point(10, 0)]], 300));
    assert.ok(g.findCurvatureViolation([[point(0, 0), point(100, 0), point(0, 0)]], 300));
    assert.equal(g.findCurvatureViolation([straight, auditTrack()], 300).segmentIndex, 1);
});

function roadContext() {
    const elements = new Map();
    for (const id of ['road-length', 'road-area', 'road-parcel-count', 'road-parcel-area']) elements.set(id, { textContent: 'stale' });
    const c = browser({
        document: { readyState: 'loading', getElementById: id => elements.get(id) || null, addEventListener() {}, dispatchEvent() {} },
        RoadFinalizationState: { createSingleFlightGate: () => ({ isRunning: () => false }) },
        CbFormat: { formatLength: n => `${n} m`, formatArea: n => `${n} m²`, formatNumber: String },
        map: {}, L: { DomEvent: { stopPropagation() {} } }, updateStatus() {}
    });
    load(c, 'road-drawing.js');
    vm.runInContext('updateRoadAcquiringDifficulty = () => {};', c);
    return { c, elements };
}
for (const [from, to] of [['road', 'track'], ['track', 'road']]) {
    test(`F3: ${from} → ${to} clears displayed and cached length/area`, () => {
        const { c, elements } = roadContext();
        vm.runInContext(`corridorDrawKind = '${from}'; committedRoadMetrics = {length:48.8,area:486}; roadWidth = 10;`, c);
        vm.runInContext(`corridorDrawKind = '${to}'; resetRoadMetricPlaceholders();`, c);
        assert.equal(elements.get('road-length').textContent, '0 m');
        assert.equal(elements.get('road-area').textContent, '0 m²');
        assert.equal(vm.runInContext('committedRoadMetrics.length + committedRoadMetrics.area', c), 0);
        assert.equal(vm.runInContext('roadWidth', c), 10);
    });
}

for (const kind of ['road', 'track']) {
    test(`F3: opening a fresh ${kind} resets stale UI before any points`, async () => {
        const { c, elements } = roadContext();
        c.document.body = { classList: { contains: () => false } };
        c.map = { getContainer: () => ({ style: {}, classList: { add() {} } }), on() {} };
        c.PersistentStorage = { getItem: () => null };
        c.corridorDefaultTrackProfile = () => ({ lanes: [{ width: 3.5 }] });
        c.corridorProfileFromLegacy = width => ({ lanes: [{ width }] });
        c.corridorProfileWidth = p => p.lanes.reduce((sum, lane) => sum + lane.width, 0);
        vm.runInContext(`canStartRoadDrawingInCurrentMode = () => true;
            disableMultiSelectForDrawing = () => {}; setRoadPanelLabelsForMode = () => {};
            clearMapSelectionsForDrawing = () => {}; autoShowBuildingsForRoadDrawing = () => {};
            updateRoadCrossSectionButton = () => {}; updateUndoButtonState = () => {}; holdRoadDoubleClickZoom = () => {};
            showTrackSpeedPicker = async () => ({speed:50,minRadius:300});
            committedRoadMetrics = {length:48.8,area:486}; corridorDrawKind = '${kind}';`, c);
        c.toggleRoadDrawTool(); await Promise.resolve();
        assert.equal(elements.get('road-length').textContent, '0 m');
        assert.equal(elements.get('road-area').textContent, '0 m²');
        assert.equal(vm.runInContext('roadWidth', c), kind === 'track' ? 3.5 : 7.5);
    });
}
test('F2: snapped tight point is refused without changing the drawing', async () => {
    const { c } = roadContext();
    c.__metricFrame = geometryContext().__metricFrame;
    load(c, 'corridor-geometry.js');
    c.points = auditTrack();
    c.RoadStrokeState = { isDoubleClickFollowUp: () => false };
    c.snap = { latlng: c.points[2] };
    const messages = []; c.updateStatus = text => messages.push(text);
    vm.runInContext(`roadHasStarted = true; roadPoints = points.slice(0,2); roadSegments = [roadPoints];
        corridorDrawingIsTrack = () => true; trackMinCurvatureRadius = 300;
        roadSnapSuppressed = () => false; findRoadSnapTarget = () => snap; clearRoadSnapMarker = () => {};`, c);
    await c.handleRoadClick({ latlng: c.points[2] });
    assert.equal(vm.runInContext('roadPoints.length', c), 2);
    assert.match(messages[0], /three-point radius/);
});
test('F2: seeded tight route cannot save and retains its geometry', async () => {
    const { c } = roadContext();
    c.CorridorGeometry = geometryContext().CorridorGeometry; c.points = auditTrack();
    let suspended = false; c.suspendRoadDrawingInteractivity = () => { suspended = true; };
    let normalized = false;
    c.normalizeCorridorGraph = segments => {
        normalized = true;
        segments.splice(0, 1, c.points.slice(0, 2), c.points.slice(1));
        throw new Error('Rejected bend reached topology mutation');
    };
    vm.runInContext(`roadSegments = [points]; roadSegmentIds = ['s1']; roadPoints = [];
        corridorDrawingIsTrack = () => true; trackMinCurvatureRadius = 300;
        corridorProtectedEdgeKeySet = () => new Set();`, c);
    assert.equal(await c.finishRoadDrawingOnce(), false);
    assert.equal(suspended, false);
    assert.equal(normalized, false, 'a rejected bend never reaches topology mutation');
    assert.deepEqual(plain(vm.runInContext('roadSegments', c)), [auditTrack()]);
});

test('F4: same public allocation key appears once; distinct owners retain keys and shares', () => {
    const c = browser({ escapeHtml: x => String(x) }); load(c, 'reparcellization-ui-state.js');
    const a = { ownerKey: 'recorded-public-owner', displayName: 'Public land', share: 0.3 };
    const b = { ownerKey: 'another-public-owner', displayName: 'Public land', share: 0.7 };
    const pub = { ownerKey: 'public-land', displayName: 'Public land', savedMetadata: 'retained' };
    const before = JSON.stringify([a, b, pub]);
    const api = c.__reparcellizationUiState;
    const choices = api.assignableOwnerChoices([a, b, pub], { ownerKey: 'public-land', displayName: 'Public land' });
    assert.equal(choices.length, 3);
    assert.equal(choices[2].savedMetadata, 'retained');
    const labels = choices.map(o => api.ownerChoiceLabel(o, 'public-land', (_k, fallback) => fallback));
    assert.equal(new Set(labels).size, 3);
    assert.match(labels[2], /not a recorded owner/);
    assert.equal(JSON.stringify([a, b, pub]), before);
});
test('F5: variants remain distinguishable after JSON reload without renaming the source', () => {
    const display = require('../frontend/js/proposals/display-text.js');
    const source = { proposalId: 'p-tbf5hk3wji', title: 'Square · parcel 2541', applied: true, offer: 1234 };
    const variant = { ...source, proposalId: 'p-tbf5hk3wji-mvar9lvi', sourceProposalId: source.proposalId };
    const before = JSON.stringify(source);
    const reloaded = plain(variant);
    assert.notEqual(display.title(source.title, source), display.title(reloaded.title, reloaded));
    assert.match(display.title(reloaded.title, reloaded), /Variant mvar9lvi/);
    assert.equal(display.variantSourceId(reloaded), source.proposalId);
    assert.equal(JSON.stringify(source), before);
});
test('F5: applying a local replacement parks its original without deleting it', () => {
    const c = browser({ isApplied: p => !!p.applied }); load(c, 'proposal-supersession.js');
    const api = c;
    assert.ok(api, 'supersession API is loaded');
    const source = { proposalId: 'source', applied: true };
    const variant = { proposalId: 'variant', sourceProposalId: 'source', applied: true };
    const result = api.commitReplacementSupersession(variant, 'variant', id => id === 'source' ? source : null);
    assert.equal(source.applied, false); assert.equal(variant.applied, true);
    assert.equal(result.source, source);
});

for (const lang of ['en', 'es', 'hr', 'sr']) {
    test(`F6: ${lang} uses consistent type names in palette, editor and filters`, () => {
        const d = JSON.parse(read(`frontend/i18n/${lang}.json`));
        assert.equal(d.panel.parcel.build.single, d.modal.singleBuilding.title);
        assert.equal(d.modal.roadWidth.proposalList.filters.goals.single, d.modal.singleBuilding.title);
        assert.equal(d.modal.roadWidth.proposalList.filters.goals['urban-rule'], d.blockify.modal.title);
        assert.equal(d.modal.createProposal.goalOptions.reparcellization, d.reparcellization.modal.title);
        assert.equal(d.siteTool.palette.subdivide, d.reparcellization.modal.title);
        assert.ok(d.mapShell.startDesign && d.mapShell.startDesignHint && d.mapShell.renderFallback);
        assert.match(d.modal.track.minRadius, /\{\{radius\}\}/);
    });
}
test('F6: Design is a registered map-shell action that starts the site tool', () => {
    const api = require('../frontend/js/ui/commands.js');
    const cmd = api.findCommand('site.draw');
    assert.ok(cmd.surfaces.includes('map-shell'));
    let started = 0;
    cmd.run({ global: { SiteTool: { start: () => started++ } } });
    assert.equal(started, 1);
});

test('Additional: a final single-parcel binding names one parcel; explicit empty binding ignores stale selection', () => {
    const c = browser({ CbFormat: { formatDateTime: () => 'today' } });
    load(c, 'proposals/create.js');
    c.getCurrentParcelSelectionContext = () => ({ ids: ['HR-339164-2951', 'HR-339164-2972'] });
    c.getProposalI18nHelper = () => (_key, fallback, values = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
    assert.equal(c.generateDefaultProposalName('Row houses', { parcelIds: ['HR-339164-2972'] }), 'Row houses · parcel 2972');
    assert.equal(c.generateDefaultProposalName('Row houses', { parcelIds: [] }), 'Row houses · today');
});

test('Additional: row-house save uses final binding for its title and generates the offer once', async () => {
    const c = browser({ CbFormat: { formatDateTime: () => 'today' } });
    load(c, 'proposals/site-draft.js'); load(c, 'proposal-editor-adapters.js');
    load(c, 'proposal-drafts.js'); load(c, 'proposals/create.js'); load(c, 'proposal-editor-shell.js');
    const store = c.createProposalDraftStore({ idFactory: () => 'row-draft',
        adapterRegistry: { get: () => ({ validate: () => ({valid:true,errors:[],warnings:[]}) }) } });
    c.proposalDraftStore = store;
    store.createDraft({ goal: 'row', adapterKey: 'row', proposalType: 'Row houses',
        fields: { name: '', selectedParcelIds: ['HR-339164-2951','HR-339164-2972'], site, offer: 0 },
        editorPayload: { placement: { free: true, site, bindingStatus: 'pending' } } });
    c.resolveBackendBaseUrl = () => 'https://example.invalid'; c.fetch = () => {};
    c.__publishBinding = { createFetchBinding: () => async () => ({coverage:'complete',source:'server:test',parcels:[{parcelId:'HR-339164-2972'}]}) };
    c.getProposalI18nHelper = () => (_key, fallback, values = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
    let offers = 0, saved;
    c.generateRandomRoadOffer = () => { offers++; return 1234; };
    c.generateDefaultProposalDescription = () => 'Unchanged generated description';
    store.buildProposalFromDraft = id => {
        const d = store.getDraft(id);
        return { title: d.fields.name, offer: d.fields.offer, offerCurrency: 'EUR', site };
    };
    c.proposalStorage = { addProposal: p => { saved = {...p,proposalId:'row-saved'}; return 'row-saved'; }, getProposal: () => saved };
    c.ProposalManager = { deriveForNewProposal: async () => { saved.applied = true; return true; } };
    c.isProposalApplied = p => p.applied;
    assert.equal(await c.instantCreateProposalFromDraft('row-draft'), 'row-saved');
    assert.equal(saved.title, 'Row houses · parcel 2972');
    assert.equal(saved.offer, 1234); assert.equal(offers, 1);
});

const { createController } = require('../frontend/js/map-mode-transition.js');
function modes(overrides = {}) {
    const calls = { commits: 0, errors: [], changes: [], leaves: 0 };
    const controller = createController({
        loadModel: async () => true, enterModel: async () => true,
        loadPhoto: async () => true, enterPhoto: async () => true,
        leaveModel: () => calls.leaves++, leavePhoto() {},
        onEntered: () => calls.commits++, onError: (...args) => calls.errors.push(args),
        onChange: s => calls.changes.push(s), ...overrides
    });
    return { controller, calls };
}
for (const mode of ['model', 'photo']) {
    for (const failure of ['false', 'throw']) {
        test(`F8: ${mode}, model initialization ${failure} restores 2D without closing working context`, async () => {
            const { controller, calls } = modes({ enterModel: async () => {
                if (failure === 'throw') throw new Error('WebGL context creation failed');
                return false;
            } });
            assert.equal(await controller.request(mode), false);
            assert.equal(calls.commits, 0); assert.equal(calls.errors.length, 1);
            assert.equal(calls.errors[0][1], mode);
            assert.deepEqual(controller.getState(), { desired: '2d', pending: false });
        });
    }
    test(`F8: successful ${mode} commits context closure only after initialization`, async () => {
        let release;
        const ready = new Promise(resolve => { release = resolve; });
        const { controller, calls } = modes({ enterModel: () => ready });
        const request = controller.request(mode);
        await Promise.resolve();
        assert.equal(calls.commits, 0);
        release(true);
        assert.equal(await request, true); assert.equal(calls.commits, 1);
        assert.deepEqual(controller.getState(), { desired: mode, pending: false });
    });
}

test('F8 review: a queued failure message is suppressed after a newer successful request', async () => {
    const queued = [], messages = [];
    let fail = true, commits = 0;
    const c = browser({
        setTimeout: callback => queued.push(callback),
        document: { getElementById: () => null, createElement: () => ({}), head: { appendChild: el => { if (el.onload) queueMicrotask(() => el.onload()); } } },
        CustomEvent: class {}, dispatchEvent() {}, location: { search: '' }, appendBuildToken: x => x,
        whenThreeReady: async () => true,
        __threeModeDriver: { enter: async () => { if (fail) throw new Error('WebGL failed'); return true; }, exit() {}, commit: () => commits++ },
        updateStatus: text => messages.push(text), showEphemeralMessage: text => messages.push(text)
    });
    load(c, 'map-mode-transition.js'); load(c, 'map-mode-loader.js');
    assert.equal(await c.requestMapMode('model'), false);
    assert.equal(queued.length, 1);
    fail = false;
    assert.equal(await c.requestMapMode('model'), true);
    queued.forEach(callback => callback());
    assert.equal(commits, 1); assert.equal(messages.length, 0);
    assert.equal(c.__mapModeState.desired, 'model');
});
test('F8: photo failure after a successful model retains 2D context', async () => {
    const { controller, calls } = modes({ enterPhoto: async () => false });
    assert.equal(await controller.request('photo'), false);
    assert.equal(calls.commits, 0); assert.equal(calls.errors.length, 1);
    assert.equal(controller.getState().desired, '2d');
});
test('F8: obsolete request neither reports an error nor closes the current context', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { controller, calls } = modes({ enterModel: () => pending });
    const request = controller.request('model'); await Promise.resolve();
    await controller.request('2d'); release(false);
    assert.equal(await request, false);
    assert.equal(calls.errors.length, 0); assert.equal(calls.commits, 0);
    assert.equal(controller.getState().desired, '2d');
});

for (const mode of ['model', 'photo']) {
    test(`F8: ${mode} entry exposes actionable fallback through the actual loader`, async () => {
        const messages = []; let closed = 0;
        let center = { lat: 45.80604, lng: 15.97834 }, zoom = 19;
        const c = browser({
            document: { getElementById: () => null, createElement: () => ({}), head: { appendChild: el => { if (el.onload) queueMicrotask(() => el.onload()); } } },
            CustomEvent: class {}, dispatchEvent() {}, location: { search: '' }, appendBuildToken: x => x,
            whenThreeReady: async () => true,
            map: { getCenter: () => center, getZoom: () => zoom, setView: (value, z) => { center = {lat: value[0], lng: value[1]}; zoom = z; } },
            __threeModeDriver: { enter: async () => { center = {lat: 0, lng: 0}; zoom = 12; throw new Error('WebGL context creation failed'); }, exit() {}, commit: () => closed++ },
            updateStatus: text => messages.push(text), showEphemeralMessage: text => messages.push(text)
        });
        load(c, 'map-mode-transition.js'); load(c, 'map-mode-loader.js');
        assert.equal(await c.requestMapMode(mode), false);
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(closed, 0); assert.equal(c.__mapModeState.desired, '2d');
        assert.deepEqual(center, {lat:45.80604,lng:15.97834}); assert.equal(zoom, 19);
        assert.match(messages[0], /WebGL/); assert.match(messages[0], /hardware acceleration/);
    });
}
