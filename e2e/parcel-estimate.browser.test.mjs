// Purpose: verify persisted estimate generation, normal parcel-fabric selection, removal, and recovery in a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('./package.json', import.meta.url));
const { chromium } = require('playwright');
const contextFixture = { type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'w100', geometry: { type: 'Polygon', coordinates: [[[ -.00014, -.00014 ], [ .00014, -.00014 ], [ .00014, .00014 ], [ -.00014, .00014 ], [ -.00014, -.00014 ]]] }, properties: { kind: 'building', source_id: 'w100' } },
  { type: 'Feature', id: 'w200', geometry: { type: 'LineString', coordinates: [[-.001, -.00045], [.001, -.00045]] }, properties: { kind: 'road', source_id: 'w200', highway: 'residential', width_m: 4, bridge: false, tunnel: false } },
  { type: 'Feature', id: 'w300', geometry: { type: 'Polygon', coordinates: [[[.0006, .0006], [.0008, .0006], [.0008, .0008], [.0006, .0008], [.0006, .0006]]]}, properties: { kind: 'water', source_id: 'w300' } }
] };

const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/vendor/leaflet-1.9.4/leaflet.css"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/primitives.css"><link rel="stylesheet" href="/css/ground-fallback.css"><link rel="stylesheet" href="/css/parcel-estimate.css"><style>html,body,#map{margin:0;width:100%;height:100%;overflow:hidden}body{font:14px sans-serif}#explore-banner{position:absolute;z-index:900;top:10px;left:10px;background:#fff;padding:6px}#parcel-info-panel{position:absolute;z-index:1200;bottom:8px;left:8px;background:#fff;padding:8px}</style><div id="explore-banner">Explore map notice</div><button id="recover" style="position:absolute;z-index:1000;left:8px;top:8px">Recover parcels</button><div id="map"></div><div id="parcel-info-panel" hidden></div><script>
fetch('/i18n/en.json').then(r=>r.json()).then(dict=>{window.i18n={t(key,vars={}){let v=key.split('.').reduce((o,k)=>o&&o[k],dict);if(typeof v!=='string')return key;return v.replace(/\\{([^}]+)\\}/g,(_,k)=>vars[k]??'')}};window.CityConfigManager={getCurrentCityId:()=> 'fixture',getCityLabel:()=> 'Fixture',getAvailableCities:()=>[],getParcelZoomRange:()=>({min:12,max:22})};window.whenMapCoreReady=()=>Promise.resolve();window.proposalStorage={getAllProposals:()=>[]};window.normalStyle={color:'#666',weight:1,fillOpacity:.08};window.selectedParcelStyle={color:'#00f',weight:4,fillOpacity:.35};window.getParcelBaseStyle=()=>window.normalStyle;window.showParcelInfoPanel=feature=>{const panel=document.querySelector('#parcel-info-panel');panel.textContent=feature.properties.parcelId;panel.hidden=false};window.closeParcelInfoPanel=()=>{document.querySelector('#parcel-info-panel').hidden=true};
const loadScript=src=>new Promise((ok,no)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=no;document.head.append(s)});loadScript('/vendor/leaflet-1.9.4/leaflet.js').then(async()=>{window.map=L.map('map',{zoomControl:false,attributionControl:true}).setView([0,0],17);for(const src of ['/js/ui/dialogs.js','/js/basemap.js','/js/bets/sha256.js','/js/work-slicer.js','/js/parcels/live-fabric.js','/js/parcels/presenter.js','/js/parcels/selection.js','/js/parcels/estimated-source.js','/js/parcels/ground-fallback.js','/js/parcels/estimated-layer.js'])await loadScript(src);window.getBackendBase=()=>'';window.onParcelClick=e=>window.selectParcel(e.target.feature.properties.parcelId,true);document.querySelector('#recover').onclick=()=>window.ParcelGroundFallback.openOptions({city:'fixture'});const source=window.ParcelGroundFallback.activeSource('fixture')||window.ParcelGroundFallback.restoreFromSession('fixture');if(source?.kind==='estimated-local'){const result=source.fetchCell({latLonBbox:window.map.getBounds().toBBoxString()});const mutation=window.LiveParcelFabric.beginMutation({kind:'estimated-local-source-restore'});mutation.seedCadastre(result.features);await mutation.prepare();mutation.publish();await window.ParcelEstimates.open()}window.harnessReady=true})});
</script>`;
function server() {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const pathname = new URL(req.url, 'http://test').pathname;
    if (pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
    const file = path.resolve(root, 'frontend', `.${pathname}`);
    if (!file.startsWith(path.resolve(root, 'frontend') + path.sep)) { res.writeHead(403); return res.end(); }
    try { const body = await readFile(file); const ext = path.extname(file); res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' })[ext] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
}
const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`)));
const close = s => new Promise(resolve => { s.closeAllConnections?.(); s.close(resolve); });

test('estimated parcels persist as selectable live parcels across reloads', async () => {
  const s = server(), url = await listen(s); let browser, releaseContext = () => {}, notifySecond;
  const secondContextStarted = new Promise(resolve => { notifySecond = resolve; });
  let contextCalls = 0; const errors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 375, height: 812 } });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.stack || e.message));
    const image = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'); x.fillStyle = '#b9aa87'; x.fillRect(0, 0, 256, 256); x.fillStyle = '#706958'; for (let y = 24; y < 240; y += 48) for (let xx = 18; xx < 240; xx += 52) x.fillRect(xx, y, 24, 18); return c.toDataURL('image/jpeg', .9).split(',')[1]; });
    await page.route('**/parcel-estimate/context**', async route => {
      contextCalls++;
      await page.evaluate(count => { window.__contextCalls = count; }, contextCalls).catch(() => {});
      if (contextCalls === 3) { notifySecond(); await new Promise(resolve => { releaseContext = resolve; }); return route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(contextFixture) }).catch(() => {}); }
      if (contextCalls === 4) return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"fixture failure"}' });
      await route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(contextFixture) }).catch(() => {});
    });
    await page.route('**/tiles/satellite-v2/**/*.jpg**', route => route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from(image, 'base64') }));
    await page.goto(url); await page.waitForFunction(() => window.harnessReady);
    await page.locator('#recover').click(); await page.locator('.ground-fallback-option[data-option="ocr"]').click();
    try { await page.waitForFunction(() => window.harnessReady && window.LiveParcelFabric.snapshot().featureCount > 0, { timeout: 20000 }); }
    catch (error) {
      const diagnostics = await page.evaluate(() => ({ url: location.href, ready: window.harnessReady,
        calls: window.__contextCalls, status: document.querySelector('.parcel-estimate-status')?.textContent,
        stored: Object.keys(localStorage).filter(key => key.startsWith('cb_estimated_parcels:')),
        panel: !!document.querySelector('.parcel-estimate-panel'), source: window.ParcelGroundFallback?.activeSource('fixture')?.kind,
        pageErrors: document.body.innerText.slice(-500) }));
      throw new Error(`${error.message}; browser diagnostics ${JSON.stringify({ ...diagnostics, errors })}`);
    }
    // Source replacement causes a real page reload; the fixture rehydrates source features through the live fabric.
    assert.equal(contextCalls, 1);
    const panel = page.locator('.parcel-estimate-panel'); await panel.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.parcel-estimate-plot').count(), 0, 'the estimator must not own parcel geometry');
    const present = await page.evaluate(() => {
      const ids = window.LiveParcelFabric.snapshot().parcelIds;
      const presenter = window.ParcelPresenter;
      if (!presenter) return { presenterMissing: true, globals: { L: typeof window.L, fabric: typeof window.LiveParcelFabric, source: typeof window.EstimatedParcelSource } };
      const id = ids[0], feature = window.LiveParcelFabric.get(id), layer = presenter.getLayer(id);
      return { id, feature, hasLayer: !!layer, owner: layer?.__parcelPresenterOwned === true };
    });
    assert(!present.presenterMissing, JSON.stringify({ present, errors }));
    assert(present.id.startsWith('EST:')); assert.equal(present.hasLayer, true); assert.equal(present.owner, true);
    assert.equal(present.feature.properties.estimated, true); assert.equal(present.feature.properties.accuracy, 'unvalidated');
    const firstId = present.id;
    await page.evaluate(id => { window.ParcelPresenter.getLayer(id).fire('click', { latlng: window.map.getCenter() }); }, firstId);
    assert.equal(await page.evaluate(() => window.selectedParcelId), firstId);
    assert.equal(await page.locator('#parcel-info-panel').textContent(), firstId);
    await page.evaluate(() => closeParcelInfoPanel());
    assert.equal(await page.evaluate(id => !!window.LiveParcelFabric.get(id) && !!window.ParcelPresenter.getLayer(id), firstId), true);

    const downloadGeo = async () => { const pending = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Export GeoJSON' }).click(); const dl = await pending; return JSON.parse(await readFile(await dl.path(), 'utf8')); };
    const exported = await downloadGeo();
    assert(exported.features.length > 0);
    assert(exported.features.every(f => f.properties.estimated === true && f.properties.parcelId === f.id && /^EST:/.test(f.id)));
    assert.equal(exported.demo.raster.height, 512); assert(exported.demo.raster.width < 512);

    // Closing controls leaves presenter geometry loaded; reopening and panning do not regenerate.
    await panel.getByRole('button', { name: 'Close estimates' }).click();
    assert.equal(await page.locator('.parcel-estimate-panel').count(), 0);
    assert.equal(await page.evaluate(id => !!window.LiveParcelFabric.get(id) && !!window.ParcelPresenter.getLayer(id), firstId), true);
    await page.evaluate(() => window.ParcelEstimates.open()); await panel.waitFor({ state: 'visible' });
    await page.evaluate(async () => { window.map.panBy([30, 20], { animate: false }); await window.ParcelEstimates.open(); });
    assert.equal(contextCalls, 1);

    // A desktop resize changes the viewport raster aspect, and the refreshed collection survives reload.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.map.invalidateSize({ animate: false }));
    const landscapeBounds = await page.evaluate(() => window.map.getBounds().toBBoxString().split(',').map(Number));
    const reloadAfterLandscape = page.waitForNavigation({ waitUntil: 'load' });
    await panel.getByRole('button', { name: 'Generate estimates' }).click();
    await reloadAfterLandscape;
    await page.waitForFunction(() => window.harnessReady && window.LiveParcelFabric.snapshot().featureCount > 0);
    assert.equal(contextCalls, 2);
    await page.evaluate(() => window.ParcelEstimates.open()); await panel.waitFor({ state: 'visible' });
    const landscape = await downloadGeo();
    assert.equal(landscape.demo.raster.width, 512);
    assert(Math.abs(landscape.demo.raster.width / landscape.demo.raster.height - 16 / 9) < 0.01);
    assert.deepEqual(landscape.demo.source_features.requested_bounds, landscapeBounds);

    // Removal persists through the source store and reload boundary.
    await panel.getByRole('button', { name: 'Remove a plot' }).click();
    const removedId = landscape.features.at(-1).id;
    const fabricCountBeforeRemoval = await page.evaluate(() => window.LiveParcelFabric.snapshot().featureCount);
    const removalReload = page.waitForNavigation({ waitUntil: 'load' });
    assert.equal(await page.evaluate(id => window.ParcelEstimates.consumeRemovalClick(id), removedId), true);
    await removalReload;
    await page.waitForFunction(count => window.harnessReady && window.LiveParcelFabric.snapshot().featureCount === count - 1, fabricCountBeforeRemoval);
    assert.equal(contextCalls, 2);
    await page.evaluate(() => window.ParcelEstimates.open()); await panel.waitFor({ state: 'visible' });
    const afterRemove = await downloadGeo(); assert.equal(afterRemove.features.length, landscape.features.length - 1);
    assert.equal(await page.evaluate(id => !!window.LiveParcelFabric.get(id), removedId), false);

    const idsBeforeCancel = afterRemove.features.map(f => f.id).sort();
    await panel.getByRole('button', { name: 'Generate estimates' }).click(); await secondContextStarted;
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await page.getByText(/Cancelled\. Existing estimates are unchanged\./).waitFor(); releaseContext();
    const afterCancel = await downloadGeo(); assert.deepEqual(afterCancel.features.map(f => f.id).sort(), idsBeforeCancel);

    // A failed regeneration leaves the previously stored collection intact.
    await panel.getByRole('button', { name: 'Generate estimates' }).click();
    await page.getByText('Could not retrieve buildings, roads or water. Please retry.').waitFor();
    assert.equal(contextCalls, 4);
    const afterFailure = await downloadGeo(); assert.deepEqual(afterFailure.features.map(f => f.id).sort(), idsBeforeCancel);

    // Oversize viewport is disabled; fixed-size mode and then zooming back in restore generation.
    await page.evaluate(() => window.map.setZoom(14, { animate: false }));
    const generate = panel.getByRole('button', { name: 'Generate estimates' });
    assert.equal(await generate.isDisabled(), true);
    await page.getByText('Zoom in to an area no wider or taller than 2 km, or choose a fixed area size.').waitFor();
    await page.locator('#parcel-estimate-size').selectOption('256'); assert.equal(await generate.isEnabled(), true);
    await page.locator('#parcel-estimate-size').selectOption('viewport'); assert.equal(await generate.isDisabled(), true);
    await page.evaluate(() => window.map.setZoom(18, { animate: false })); assert.equal(await generate.isEnabled(), true);
    assert.equal(contextCalls, 4);
    assert.deepEqual(errors, []);
  } finally { releaseContext(); if (browser) await browser.close(); await close(s); }
});
