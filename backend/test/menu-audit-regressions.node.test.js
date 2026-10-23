// Behavioral regressions for menu state, map selection, agreement truth and authored form text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const commands = require('../../frontend/js/ui/commands.js');
const actorSource = fs.readFileSync(new URL('../../frontend/js/actor-explorer.js', import.meta.url), 'utf8');
const events = ['Alice', 'Bob'].map((name, i) => ({
    id: `event-${i}`, actor: { id: name, name, kind: 'agent', controller: 'llm' },
    action: { type: 'design' }, recordedAt: '2026-10-22T12:00:00Z', runId: `run-${i}`, ok: true
}));

function actorView(options = {}) {
    const document = makeDocument();
    document.readyState = 'loading';
    const window = { document };
    vm.runInNewContext(actorSource, { window, console, Date, URLSearchParams });
    const element = document.createElement('div'); document.body.append(element);
    const counts = [];
    const controller = window.ActorExplorer.mount(element, { events, onVisibleCount: count => counts.push(count), ...options });
    return { element, controller, counts };
}

test('OSM block commands use their own section while cadastral block commands remain gated', () => {
    const clicked = [];
    const context = { mode: '2d', isSectionHidden: section => section === 'blocks',
        isControlAvailable: () => true, clickControl: id => clicked.push(id) };
    for (const id of ['urbanBlocks.refresh', 'urbanBlocks.browse']) {
        assert.equal(commands.isAvailable(id, context), true);
        commands.runCommand(id, context);
    }
    assert.deepEqual(clicked, ['urban-blocks-refresh', 'urban-blocks-browse']);
    assert.equal(commands.isAvailable('blocks.list', context), false);
    assert.equal(commands.isAvailable('urbanBlocks.refresh', { ...context, isControlAvailable: () => false }), false);
    assert.equal(commands.isAvailable('urbanBlocks.browse', { ...context, mode: 'model' }), false);
});

test('source-hidden building labels gate the palette even inside a closed sheet', () => {
    const document = makeDocument();
    document.body.innerHTML = '<section class="map-sheet" hidden><label data-feature-hidden="true"><input id="showBuildingsDgu"></label><label><input id="showBuildingsOsm"></label></section>';
    // The shared fake DOM models parentNode; browser controls expose the same link as parentElement.
    document.querySelectorAll('section, label, input').forEach(el => Object.defineProperty(el, 'parentElement', { get: () => el.parentNode }));
    const context = commands.createBrowserContext({ document });
    assert.equal(commands.isAvailable('layers.buildingsDgu', context), false);
    assert.equal(context.controlUnavailableReason('showBuildingsDgu'), 'hiddenForCity');
    assert.equal(commands.isAvailable('layers.buildingsOsm', context), true);
});

test('actor reset clears nested selection and reports the displayed event count', () => {
    const { element, controller, counts } = actorView();
    element.querySelector('.ae-profiles button').click();
    assert.equal(element.querySelectorAll('.ae-event').length, 1);
    assert.equal(counts.at(-1), 1);
    controller.reset();
    assert.equal(element.querySelectorAll('.ae-event').length, 2);
    assert.equal(element.querySelectorAll('.ae-profiles [aria-pressed="true"]').length, 0);
    assert.equal(counts.at(-1), 2);
});

for (const rejected of [false, true]) test(`reset ignores a pending run ${rejected ? 'failure' : 'response'}`, async () => {
    let resolve, reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const { element, controller } = actorView({ loadRun: () => pending });
    element.querySelector('.ae-meta button').click();
    assert.match(element.querySelector('.ae-run-detail').textContent, /Loading run/);
    controller.reset();
    if (rejected) reject(new Error('stale run failed'));
    else resolve({ id: 'old-run', persona: 'Alice', status: 'done', picks: [], costs: [] });
    await pending.catch(() => {});
    await Promise.resolve();
    assert.equal(element.querySelector('.ae-run-detail').textContent, '');
});

test('explicit permitted inspection bypasses only the OSM-block selection gate', () => {
    const source = fs.readFileSync(new URL('../../frontend/js/map-edit-lock.js', import.meta.url), 'utf8');
    const window = { UrbanBlocksView: { ownsClicks: () => true } };
    vm.runInNewContext(source, { window, console });
    const lock = window.__mapEditLock;
    assert.equal(lock.blocksSelection(), true);
    assert.equal(lock.blocksSelection({ allowUrbanBlocks: true }), false);
    for (const flag of ['measureMode', 'roadDrawingMode', 'cadastreViewActive', 'proposalListBrowseMode']) {
        window[flag] = true;
        assert.equal(lock.blocksSelection({ allowUrbanBlocks: true }), true, flag);
        window[flag] = false;
    }
    lock.claim('test-editor');
    assert.equal(lock.blocksSelection({ allowUrbanBlocks: true }), true);
});

test('NYC degree cells are measured in square metres using the public city config', () => {
    function bounds(sw, ne) {
        return { getSouthWest: () => sw, getNorthEast: () => ne, isValid: () => true,
            getSouth: () => sw.lat, getNorth: () => ne.lat, getWest: () => sw.lng, getEast: () => ne.lng,
            extend() {}, intersects: () => true };
    }
    const document = makeDocument(); document.readyState = 'loading';
    const window = {
        proj4: require('../../frontend/vendor/proj4-2.22.0/proj4.js'),
        CityConfigManager: { getCurrentCityConfig: () => ({ projection: { datasetCrs: 'EPSG:4326' } }), getParcelGridSize: () => 0.005 },
        datasetToWgs84: (x, y) => [y, x],
        CadastralParcelRepository: { snapshot: () => ({ boundsKeys: ['-14802,8142', '-14801,8142'] }) },
        getRequiredGridCells: () => new Set(Array.from({ length: 18 }, (_, i) => String(i)))
    };
    const L = { latLng: (lat, lng) => ({ lat, lng }), latLngBounds: bounds };
    const map = { getBounds: () => bounds({ lat: 40.71, lng: -74.01 }, { lat: 40.72, lng: -74 }), getZoom: () => 18 };
    const context = vm.createContext({ window, document, L, map, console, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(new URL('../../frontend/js/metric-frame.js', import.meta.url), 'utf8'), context);
    const source = fs.readFileSync(new URL('../../frontend/js/parcel-coverage-debug.js', import.meta.url), 'utf8');
    vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'window.coverageData = computeCoverageData; })();'), context);
    const result = window.coverageData();
    assert.equal(result.totalCells, 2);
    assert.ok(result.cellAreaSqm > 230000 && result.cellAreaSqm < 240000, result.cellAreaSqm);
    assert.equal(result.intersectingCells, 2);
    assert.equal(result.viewCellCount, 18);
});

test('agreement badges preserve terminal index states and newer terminal account reads', () => {
    const panel = require('../../frontend/js/agreement-panel.js');
    const tr = (_key, fallback) => fallback;
    for (const status of ['executed', 'cancelled', 'expired']) {
        const remote = { loading: false, status, error: null };
        assert.equal(panel.remoteStatusOf(remote, tr).label.toLowerCase(), status);
        assert.equal(panel.observedRemote(remote, { value: { status: 'Active' } }).status, status);
        assert.equal(panel.observedRemote({ status: 'active' }, { value: { status: status[0].toUpperCase() + status.slice(1) } }).status, status);
    }
});

test('unknown placeholder owners do not become one owner per selected parcel', () => {
    const source = fs.readFileSync(new URL('../../frontend/js/proposals/execution.js', import.meta.url), 'utf8');
    const fn = source.slice(source.indexOf('function computeOwnershipStatsFromSelection('), source.indexOf('\nfunction setOwnershipTransferDirection('));
    const context = { console, getParcelOwnerSlots: id => [{ key: `parcel:${id}:owner`, placeholder: true, type: 'unknown' }] };
    vm.runInNewContext(fn, context);
    assert.equal(context.computeOwnershipStatsFromSelection({ ids: ['p1'] }).ownerCount, null);
    context.getParcelOwnerSlots = () => [{ key: 'known-local-party' }];
    assert.equal(context.computeOwnershipStatsFromSelection({ ids: ['p1', 'p2'] }).ownerCount, 1);
});

for (const fail of [false, true]) test(`terminal chain status survives a pending and ${fail ? 'failed' : 'stale Active'} reread`, async () => {
    const source = fs.readFileSync(new URL('../../frontend/js/agreement-panel.js', import.meta.url), 'utf8');
    const fn = source.slice(source.indexOf('async function readChain(agreement)'), source.indexOf('\n        // Reads the account when'));
    let resolve, reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const terminal = { status: 'Executed', decision: 'Satisfied' };
    const state = { id: 'a1', chainToken: 0, chain: { account: 'account1', value: terminal } };
    const context = { state, isBinding: () => true, isOpen: () => true, renderPanel() {}, log() {}, console,
        win: { AgreementBridge: { onchainRef: () => ({ account: 'account1', cluster: 'devnet' }), read: () => pending } } };
    vm.runInNewContext(fn, context);
    const reading = context.readChain({ id: 'a1' });
    assert.equal(state.chain.loading, true);
    assert.equal(state.chain.value.status, 'Executed');
    if (fail) reject(new Error('RPC unavailable'));
    else resolve({ status: 'Active', decision: 'Pending' });
    await reading;
    assert.equal(state.chain.value.status, 'Executed');
    assert.equal(require('../../frontend/js/agreement-panel.js').observedRemote({ status: 'active' }, state.chain).status, 'executed');
});

test('facet text generation preserves authored fields and updates explicitly generated fields', () => {
    const source = fs.readFileSync(new URL('../../frontend/js/proposals/create.js', import.meta.url), 'utf8');
    const fn = source.slice(source.indexOf('function updateProposalNameAndDescription('), source.indexOf('\nasync function createProposal('));
    const document = makeDocument();
    document.body.innerHTML = '<input id="proposalName"><input id="proposalDescription">';
    const title = document.getElementById('proposalName'), description = document.getElementById('proposalDescription');
    title.value = 'Authored title'; title.dataset.titleOrigin = 'user';
    description.value = 'Inherited detailed description'; description.dataset.descriptionOrigin = 'user';
    const context = { document, generateDefaultProposalName: type => `Generated ${type}`, generateDefaultProposalDescription: type => `Default ${type}` };
    vm.runInNewContext(fn, context);
    context.updateProposalNameAndDescription('Building', true);
    assert.equal(title.value, 'Authored title'); assert.equal(description.value, 'Inherited detailed description');
    title.dataset.titleOrigin = 'generated'; description.dataset.descriptionOrigin = 'generated';
    context.updateProposalNameAndDescription('Park', true);
    assert.equal(title.value, 'Generated Park'); assert.equal(description.value, 'Default Park');
});

test('source-only cadastral Propose context explains current-ground selection without changing it', () => {
    const document = makeDocument();
    document.body.innerHTML = '<div id="parcel-proposal-primary-actions"></div>';
    const selected = new Set(['formed-piece']);
    const window = { document, currentParcel: { id: 'formed-piece' },
        multiParcelSelection: { isActive: true, selectedParcels: selected },
        LiveParcelFabric: { get: id => id === 'formed-piece' ? { id } : null },
        ParcelMenuModel: require('../../frontend/js/ui/parcel-menu-model.js') };
    vm.runInNewContext(fs.readFileSync(new URL('../../frontend/js/parcels/ui/proposal-actions.js', import.meta.url), 'utf8'), { window, document, console });
    window.renderParcelProposalActions('consumed-source');
    const container = document.getElementById('parcel-proposal-primary-actions');
    assert.match(container.textContent, /read-only cadastral source record.*current formed ground piece/);
    assert.equal(container.querySelectorAll('button').length, 0);
    assert.deepEqual([...selected], ['formed-piece']);
    assert.equal(window.currentParcel.id, 'formed-piece');
    window.renderParcelProposalActions('formed-piece');
    assert.ok(container.querySelector('.parcel-build-btn--park'));
});


test('manual selection control reflects the current selection mode', () => {
    const source = fs.readFileSync(new URL('../../frontend/js/proposals/list-ui.js', import.meta.url), 'utf8');
    const fn = source.slice(source.indexOf('function syncMultiSelectControls('), source.indexOf('function handleDescendantItemHover('));
    const document = makeDocument();
    document.body.innerHTML = '<button id="parcel-manual-selection" aria-pressed="false"></button>';
    const context = { document };
    vm.runInNewContext(fn, context);
    const control = document.getElementById('parcel-manual-selection');
    context.syncMultiSelectControls(true);
    assert.equal(control.getAttribute('aria-pressed'), 'true');
    context.syncMultiSelectControls(false);
    assert.equal(control.getAttribute('aria-pressed'), 'false');
});
