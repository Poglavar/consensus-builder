// Purpose: exercise recovery, worker generation, export, removal, cancellation and close in a real headless browser with synthetic fixtures.
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
const contextFixture = { type:'FeatureCollection', features:[
  {type:'Feature',id:'w100',geometry:{type:'Polygon',coordinates:[[[ -0.00014,-0.00014],[0.00014,-0.00014],[0.00014,0.00014],[-0.00014,0.00014],[-0.00014,-0.00014]]]},properties:{kind:'building',source_id:'w100'}},
  {type:'Feature',id:'w200',geometry:{type:'LineString',coordinates:[[-0.001,-0.00045],[0.001,-0.00045]]},properties:{kind:'road',source_id:'w200',highway:'residential',width_m:4,bridge:false,tunnel:false}},
  {type:'Feature',id:'w300',geometry:{type:'Polygon',coordinates:[[[0.0006,0.0006],[0.0008,0.0006],[0.0008,0.0008],[0.0006,0.0008],[0.0006,0.0006]]]},properties:{kind:'water',source_id:'w300'}}
] };

const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/vendor/leaflet-1.9.4/leaflet.css"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/primitives.css"><link rel="stylesheet" href="/css/ground-fallback.css"><link rel="stylesheet" href="/css/parcel-estimate.css"><style>html,body,#map{margin:0;width:100%;height:100%;overflow:hidden}body{font:14px sans-serif}#explore-banner{position:absolute;z-index:900;top:10px;left:10px;background:#fff;padding:6px}</style><div id="explore-banner">Explore map notice</div><button id="recover" style="position:absolute;z-index:1000;left:8px;top:8px">Recover parcels</button><div id="map"></div><script>
fetch('/i18n/en.json').then(r=>r.json()).then(dict=>{window.i18n={t(key,vars={}){let v=key.split('.').reduce((o,k)=>o&&o[k],dict);if(typeof v!=='string')return key;return v.replace(/\\{([^}]+)\\}/g,(_,k)=>vars[k]??'')}};window.CityConfigManager={getCurrentCityId:()=> 'fixture',getCityLabel:()=> 'Fixture',getAvailableCities:()=>[]};
const scripts=['/vendor/leaflet-1.9.4/leaflet.js','/js/ui/dialogs.js','/js/basemap.js','/js/parcels/estimated-layer.js','/js/parcels/ground-fallback.js'];let chain=Promise.resolve();for(const src of scripts)chain=chain.then(()=>new Promise((ok,no)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=no;document.head.append(s)}));chain.then(()=>{window.map=L.map('map',{zoomControl:false,attributionControl:true}).setView([0,0],17);window.getBackendBase=()=>'';document.querySelector('#recover').onclick=()=>ParcelGroundFallback.openOptions({city:'fixture'});window.harnessReady=true})});
</script>`;
function server() {
  return createServer(async (req,res)=>{
    res.setHeader('Cache-Control','no-store');
    const pathname=new URL(req.url,'http://test').pathname;
    if(pathname==='/'){res.writeHead(200,{'Content-Type':'text/html'});return res.end(html)}
    const file=path.resolve(root,'frontend',`.${pathname}`);
    if(!file.startsWith(path.resolve(root,'frontend')+path.sep)){res.writeHead(403);return res.end()}
    try{const body=await readFile(file);const ext=path.extname(file);res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.css':'text/css'}[ext]||'application/octet-stream')});res.end(body)}catch{res.writeHead(404);res.end()}
  });
}
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${s.address().port}`)));
const close=s=>new Promise(resolve=>{s.closeAllConnections?.();s.close(resolve)});
const featureCount=page=>page.evaluate(()=>window.__exported?.features?.length ?? -1);

test('parcel estimate recovery creates, exports, edits, cancels and closes an illustrative overlay',async()=>{
  const s=server(),url=await listen(s);let browser,releaseContext=()=>{},notifySecond,notifyThird;let secondContextStarted=new Promise(resolve=>notifySecond=resolve),thirdContextStarted=new Promise(resolve=>notifyThird=resolve),contextCalls=0;const errors=[];
  try{
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});const context=await browser.newContext({acceptDownloads:true,viewport:{width:375,height:812}});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d');x.fillStyle='#b9aa87';x.fillRect(0,0,256,256);x.fillStyle='#706958';for(let y=24;y<240;y+=48)for(let xx=18;xx<240;xx+=52)x.fillRect(xx,y,24,18);return c.toDataURL('image/jpeg',.9).split(',')[1]});
    await page.route('**/parcel-estimate/context**',async route=>{contextCalls++;if(contextCalls===2){notifySecond();await new Promise(resolve=>{releaseContext=resolve});try{await route.fulfill({status:200,contentType:'application/geo+json',body:JSON.stringify(contextFixture)})}catch{};return}if(contextCalls===3){notifyThird();await route.fulfill({status:502,contentType:'application/json',body:'{"error":"fixture failure"}'});return}await route.fulfill({status:200,contentType:'application/geo+json',body:JSON.stringify(contextFixture)}).catch(()=>{})});
    await page.route('**/tiles/satellite-v2/**/*.jpg**',route=>route.fulfill({status:200,contentType:'image/jpeg',body:Buffer.from(image,'base64')}));
    await page.goto(url);await page.waitForFunction(()=>window.harnessReady);
    const beforeOpen=await page.evaluate(()=>({bounds:map.getBounds().toBBoxString(),zoom:map.getZoom()}));
    await page.locator('#recover').click();await page.locator('.ground-fallback-option[data-option="ocr"]').click();
    const panel=page.locator('.parcel-estimate-panel');await panel.waitFor({state:'visible'});assert.equal(await page.locator('.ground-fallback-overlay').count(),0);assert(await page.locator('body').evaluate(el=>el.classList.contains('parcel-estimate-open')));assert.equal(await page.locator('#explore-banner').isVisible(),false);
    const actions=panel.locator('.parcel-estimate-actions'),collapse=panel.getByRole('button',{name:'Collapse controls'});await collapse.click();assert.equal(await actions.isVisible(),false);await panel.getByRole('button',{name:'Show controls'}).click();assert.equal(await actions.isVisible(),true);
    assert.equal(await page.locator('#parcel-estimate-size').inputValue(),'viewport');
    assert.deepEqual(await page.evaluate(()=>({bounds:map.getBounds().toBBoxString(),zoom:map.getZoom()})),beforeOpen);
    const requestedBounds=await page.evaluate(()=>map.getBounds().toBBoxString().split(',').map(Number));
    const generate=panel.getByRole('button',{name:'Generate estimates'});
    // Opening the recovery choice must create estimates without pressing Generate.
    await page.waitForFunction(()=>document.querySelectorAll('.parcel-estimate-plot').length>0,{timeout:60000});
    assert.equal(contextCalls,1);
    const paths=page.locator('.parcel-estimate-plot');assert(await paths.count()>0);assert(await paths.first().getAttribute('d'));
    assert.equal(await paths.first().evaluate(el=>getComputedStyle(el).stroke),'rgb(181, 247, 178)');
    const downloadGeo=async()=>{const pending=page.waitForEvent('download');await panel.getByRole('button',{name:'Export GeoJSON'}).click();const dl=await pending;const file=await dl.path();return JSON.parse(await readFile(file,'utf8'))};
    let exported=await downloadGeo();assert(exported.features.length>0);assert(exported.features.every(f=>f.properties.estimated===true&&f.properties.shape==='rectangle'&&f.geometry.type==='Polygon'&&f.geometry.coordinates[0].length===5));
    assert.equal(exported.demo.raster.height,512);assert(exported.demo.raster.width<512);
    assert.deepEqual(exported.demo.source_features.requested_bounds,requestedBounds);
    assert.equal(exported.demo.source_image.hash_format,`RGBA8 ${exported.demo.raster.width}x512`);
    await page.evaluate(async()=>{map.panBy([30,20],{animate:false});await ParcelEstimates.open()});
    assert.equal(contextCalls,1);
    await panel.getByRole('button',{name:'Remove a plot'}).click();await paths.first().dispatchEvent('click');
    const afterRemove=await downloadGeo();assert.equal(afterRemove.features.length,exported.features.length-1);assert.equal(afterRemove.demo.removed_plot_ids.length,1);
    const remaining=afterRemove.features.length,remainingIds=afterRemove.features.map(f=>f.id).sort();await generate.click();await secondContextStarted;await panel.getByRole('button',{name:'Cancel'}).click();
    await page.getByText(/Cancelled\. Existing estimates are unchanged\./).waitFor();releaseContext();
    assert.equal(await page.locator('.parcel-estimate-plot').count(),remaining);
    const preserved=await downloadGeo();assert.deepEqual(preserved.features.map(f=>f.id).sort(),remainingIds);
    await generate.click();await thirdContextStarted;await page.getByText('Could not retrieve buildings, roads or water. Please retry.').waitFor();
    const afterFailure=await downloadGeo();assert.deepEqual(afterFailure.features.map(f=>f.id).sort(),remainingIds);assert.equal(await page.locator('.parcel-estimate-plot').count(),remaining);
    const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,view:innerWidth,panel:document.querySelector('.parcel-estimate-panel').getBoundingClientRect().toJSON()}));assert(size.width<=size.view,`horizontal overflow ${size.width}>${size.view}`);assert(size.panel.left>=0&&size.panel.right<=size.view,`panel bounds ${size.panel.left}..${size.panel.right} exceed ${size.view}px viewport`);
    await page.setViewportSize({width:1280,height:720});await page.evaluate(()=>map.invalidateSize({animate:false}));
    const landscapeBounds=await page.evaluate(()=>map.getBounds().toBBoxString().split(',').map(Number));
    await generate.click();await page.waitForFunction(()=>document.querySelector('.parcel-estimate-status').textContent.includes('illustrative plots'));
    const landscape=await downloadGeo();assert.equal(landscape.demo.raster.width,512);assert.equal(landscape.demo.raster.height,288);assert.deepEqual(landscape.demo.source_features.requested_bounds,landscapeBounds);
    await page.evaluate(()=>map.setZoom(14,{animate:false}));assert.equal(await generate.isDisabled(),true);
    await page.getByText('Zoom in to an area no wider or taller than 2 km, or choose a fixed area size.').waitFor();
    await page.locator('#parcel-estimate-size').selectOption('256');assert.equal(await generate.isEnabled(),true);
    await page.locator('#parcel-estimate-size').selectOption('viewport');assert.equal(await generate.isDisabled(),true);
    await page.evaluate(()=>map.setZoom(18,{animate:false}));assert.equal(await generate.isEnabled(),true);
    assert.equal(await page.locator('.parcel-estimate-status').textContent().then(t=>t.includes('illustrative plots')),true);
    await panel.getByRole('button',{name:'Close estimates'}).click();assert.equal(await page.locator('.parcel-estimate-panel').count(),0);assert.equal(await page.locator('.parcel-estimate-frame').count(),0);assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('parcel-estimate-open')),false);assert.equal(await page.locator('#explore-banner').isVisible(),true);
    await page.evaluate(async()=>{map.setZoom(14,{animate:false});await ParcelEstimates.open()});
    assert.equal(contextCalls,4);assert.equal(await generate.isDisabled(),true);
    await page.getByText('Zoom in to an area no wider or taller than 2 km, or choose a fixed area size.').waitFor();
    await panel.getByRole('button',{name:'Close estimates'}).click();
    assert.deepEqual(errors,[]);
  }finally{releaseContext();if(browser)await browser.close();await close(s)}
});
