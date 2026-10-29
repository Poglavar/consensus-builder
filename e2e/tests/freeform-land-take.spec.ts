import { test, expect } from '../helpers/fixtures';
import { placeFreeformBuilding, openCity, openParcel, openParcelAt, stubBasemapTiles, showProposal } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';
const editor = '#single-building-editor';
const first = 'HR-335754-1234';
async function open(page: any) {
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('#parcel-info-panel .parcel-build-btn--single').click();
  await placeFreeformBuilding(page);
  await expect(page.locator(`${editor} .on-map-editor__panel`)).toBeVisible();
  await expect(page.locator('[data-land-status]')).toContainText('m²');
}
async function finish(page: any) {
  await page.locator('#single-building-confirm').click();
  await expect(page.locator(editor)).toHaveCount(0);
}
test('a narrow building takes a whole parcel, previews demolition, saves and reopens', async ({ mockApi: page }, testInfo) => {
  await page.route('**/buildings/under', route => {
    const regions = route.request().postDataJSON().regions;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ supported:true, source:'gdi', truncated:false,
      regions:Object.fromEntries(regions.map((r:any)=>[r.key,[{id:'yard-building',height_m:4,
        geometry:{type:'Polygon',coordinates:[[[15.98192,45.80002],[15.98198,45.80002],[15.98198,45.80008],[15.98192,45.80008],[15.98192,45.80002]]]} }]])) }) });
  });
  await open(page);
  await expect(page.locator('#single-ground-treatment')).toBeDisabled();
  await expect(page.locator('#single-ground-treatment-edit')).toBeDisabled();
  const body=await page.evaluate(()=>(window as any).OnMapEditor.getPreview().draftPreview.features[0].geometry);
  await selectNativeOption(page.locator(`[data-parcel-id="${first}"]`),'whole');
  await expect(page.locator('#single-ground-treatment')).toBeEnabled();
  await page.locator('[data-land-footprint]').click();
  await expect(page.locator(`[data-parcel-id="${first}"]`)).toHaveValue('footprint');
  await expect(page.locator('#single-ground-treatment')).toBeDisabled();
  await expect(page.locator('#single-ground-treatment-edit')).toBeDisabled();
  expect(await page.evaluate(() => (window as any).getActiveProposalDesignDraft().editorPayload.context.groundSurface)).toBeNull();
  await selectNativeOption(page.locator(`[data-parcel-id="${first}"]`),'whole');
  await expect(page.locator('[data-land-status]')).toContainText('1 buildings removed');
  await expect(page.locator('[data-land-accept]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('land-take-without-acceptance.png') });
  await finish(page);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p:any)=>p.goal==='single'&&p.applied).length), {timeout:20000}).toBe(1);
  const saved=await page.evaluate(()=>(window as any).proposalStorage.getAllProposals().find((p:any)=>p.goal==='single'&&p.applied));
  expect(saved).toBeTruthy();
  expect(saved.geometry.buildings[0].geometry).toEqual(body);
  expect(saved.geometry.landTake.geometry.coordinates[0]).toEqual([[15.9819,45.8],[15.9825,45.8],[15.9825,45.8005],[15.9819,45.8005],[15.9819,45.8]]);
  expect(saved.buildingProposal.demolishedBuildings.map((b:any)=>b.id)).toContain('yard-building');
  expect(await page.evaluate(p=>(window as any).DesignRecord.published(p).geometry.landTake,saved)).toEqual(saved.geometry.landTake);
  await showProposal(page,saved.proposalId);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  await expect(page.locator('[data-land-rows] select')).toHaveCount(1);
  await expect(page.locator('[data-land-rows] select')).toHaveValue('whole');
});
for (const published of [false, true]) test(`height-only editing retains demolition for ${published ? 'a published counterproposal' : 'an in-place save'}`, async ({ mockApi: page }) => {
  const stock = { id: 'yard-building', height_m: 4,
    geometry: { type: 'Polygon', coordinates: [[[15.98192,45.80002],[15.98198,45.80002],[15.98198,45.80008],[15.98192,45.80008],[15.98192,45.80002]]] } };
  await page.route('**/buildings/under', route => {
    const regions = route.request().postDataJSON().regions;
    return route.fulfill({ json: { supported: true, source: 'gdi', truncated: false,
      regions: Object.fromEntries(regions.map((r: any) => [r.key, [stock]])) } });
  });
  await open(page);
  await selectNativeOption(page.locator(`[data-parcel-id="${first}"]`), 'whole');
  await page.locator('#single-height-slider').fill('250');
  await expect(page.locator('[data-land-status]')).toContainText('m²');
  await finish(page);
  const current = () => page.evaluate(() => {
    const w = window as any;
    const p = w.proposalStorage.getAllProposals().find((p: any) => p.goal === 'single' && p.applied);
    return { id: p?.proposalId, height: p?.geometry?.buildings?.[0]?.properties?.height,
      demolished: w.collectDemolishedBuildingRecords().map((b: any) => String(b.id)),
      drawnDemolished: [...w.currentBuildingOutcomeState().demolishedById.keys()] };
  });
  await expect.poll(current).toMatchObject({ height: 250, demolished: ['yard-building'], drawnDemolished: ['yard-building'] });
  const before = await current();
  if (published) await page.evaluate(id => {
    const w = window as any;
    const source = w.proposalStorage.getProposal(id);
    source.published = { cid: w.Cid.cidOfObject(w.DesignRecord.published(source)) };
    w.proposalStorage.save();
  }, before.id);
  await showProposal(page, before.id);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  await expect(page.locator('#single-height-slider')).toHaveValue('250');
  await page.locator('#single-height-slider').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#single-height-slider')).toHaveValue('249');
  expect(await current()).toEqual(before);
  await expect(page.locator('[data-land-status]')).toContainText('m²');
  await expect(page.locator('[data-land-status]')).toContainText('1 buildings removed');
  await finish(page);
  await expect.poll(current).toMatchObject({ height: 249,
    demolished: ['yard-building'], drawnDemolished: ['yard-building'] });
  if (published) {
    expect((await current()).id).not.toBe(before.id);
    expect(await page.evaluate(id => {
      const p = (window as any).proposalStorage.getProposal(id);
      return { applied: p.applied, height: p.geometry.buildings[0].properties.height };
    }, before.id)).toEqual({ applied: false, height: 250 });
  } else expect((await current()).id).toBe(before.id);
});
// Parcel 1234 laid out as two equal plots, west and east of 15.9822, and a tower across that line.
const box = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const halves = { type: 'FeatureCollection', features: [box(15.9819, 45.8, 15.9822, 45.8005), box(15.9822, 45.8, 15.9825, 45.8005)]
  .map(geometry => ({ type: 'Feature', properties: {}, geometry })) };
const straddling = { type: 'Feature', properties: { height: 30 }, geometry: box(15.98215, 45.8002, 15.98225, 45.8003) };
test('reopening a building across two layout plots offers each plot whole, with its own outline', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--parcel-layout').click();
  const layout = page.locator('.on-map-reparcellization');
  await expect(layout.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
  await layout.locator('[data-reparcel-upload]').setInputFiles({ name: 'halves.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(halves)) });
  await expect(layout.locator('[data-reparcel-status]')).toHaveText('Loaded 2 polygons from file.');
  await layout.locator('[data-reparcel-commit]').click();
  await expect(layout).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.goal === 'parcel-layout' && p.applied).length)).toBe(1);

  await openParcelAt(page, 15.98205, 45.80025);
  await page.locator('#parcel-info-panel .parcel-build-btn--single').click();
  // One plot is selected; the block prompt offers both, and the tower starts on this one.
  await page.getByRole('alertdialog').getByRole('button', { name: 'No, just this parcel' }).click();
  await placeFreeformBuilding(page);
  await page.locator('#single-building-geojson-input').setInputFiles({ name: 'tower.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(straddling)) });
  const choices = page.locator('[data-land-rows] select');
  await expect(choices).toHaveCount(2);
  await finish(page);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.goal === 'single' && p.applied).length), { timeout: 20_000 }).toBe(1);
  const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.goal === 'single' && p.applied).proposalId);

  // The applied tower covers the line between the plots; the review replays the layout without it
  // and finds both plots, each whole.
  const replays: string[] = [];
  page.on('console', message => { if (message.text().includes('[land-take] ground before')) replays.push(message.text()); });
  await showProposal(page, saved);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  await expect(choices).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('[data-land-rows] .land-take-percent')).toHaveText(['3%', '3%']);
  expect(replays).toEqual([expect.stringContaining('1 designs on 1 parcels')]);
  await selectNativeOption(choices.nth(0), 'whole');
  await expect(choices.nth(0)).toHaveValue('whole');
  const areas = await page.evaluate(([plot, tower]) => {
    const w = window as any;
    return { take: w.turf.area(w.getActiveProposalDesignDraft().editorPayload.context.landTake), expected: w.turf.area(plot) + w.turf.area(tower) / 2 };
  }, [halves.features[0], straddling]);
  expect(areas.take).toBeCloseTo(areas.expected, -1);
});
test('missing stock keeps the unsaved editor open',async({mockApi:page})=>{
  await open(page);
  await page.route('**/buildings/under',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({supported:true,truncated:true,regions:{}})}));
  await page.locator('[data-land-footprint]').click();
  await expect(page.locator('[data-land-status]')).toContainText('Could not verify');
  await expect(page.locator('[data-land-footprint]')).not.toHaveAttribute('aria-busy');
  await expect(page.locator('[data-land-footprint]')).toBeEnabled();
  await page.locator('#single-building-confirm').click();
  await expect(page.locator('[data-land-status]')).toContainText('Could not verify');
  await expect(page.locator('#single-land-take-error')).toBeVisible();
  await expect(page.locator('[data-land-accept]')).toHaveCount(0);
  await expect(page.locator(`${editor} .on-map-editor__panel`)).toBeVisible();
  await page.route('**/buildings/under', route => {
    const regions = route.request().postDataJSON().regions;
    return route.fulfill({ json: { supported: true, truncated: false, source: 'gdi', regions: Object.fromEntries(regions.map((r: any) => [r.key, []])) } });
  });
  await page.locator('[data-land-footprint]').click();
  await expect(page.locator('[data-land-status]')).toContainText('m²');
  await expect(page.locator('#single-land-take-error')).toBeHidden();
});
test('mixed parcel choices and Undo update land without changing the uploaded building',async({mockApi:page})=>{
  await open(page);
  const building={type:'Feature',properties:{height:80},geometry:{type:'Polygon',coordinates:[[[15.9821,45.8004],[15.9823,45.8004],[15.9823,45.8007],[15.9821,45.8007],[15.9821,45.8004]]]}};
  await page.locator('#single-building-geojson-input').setInputFiles({name:'tower.geojson',mimeType:'application/geo+json',buffer:Buffer.from(JSON.stringify(building))});
  const choices=page.locator('[data-land-rows] select');
  await expect(choices).toHaveCount(2);
  await expect(choices.nth(0)).toHaveValue('footprint');
  await expect(choices.nth(1)).toHaveValue('footprint');
  await selectNativeOption(page.locator(`[data-parcel-id="${first}"]`),'whole');
  await expect(page.locator('[data-land-status]')).toContainText('m²');
  const preview=await page.evaluate(()=>({buildings:(window as any).OnMapEditor.getPreview().draftPreview.features,
    take:(window as any).getActiveProposalDesignDraft().editorPayload.context.landTake}));
  expect(preview.buildings[0].geometry).toEqual(building.geometry);
  const areas=await page.evaluate(({take,building})=>({land:(window as any).turf.area(take),body:(window as any).turf.area(building)}),{take:preview.take,building});
  expect(areas.land).toBeGreaterThan(areas.body*3);
  await page.locator('#single-building-undo').click();
  await expect(page.locator(`[data-parcel-id="${first}"]`)).toHaveValue('footprint');
  await expect(page.locator('[data-land-accept]')).toHaveCount(0);
});
test('Done saves the current demolition answer without separate acceptance',async({mockApi:page})=>{
  await open(page);
  await selectNativeOption(page.locator(`[data-parcel-id="${first}"]`),'whole');
  await expect(page.locator('[data-land-status]')).toContainText('m²');
  await page.route('**/buildings/under',route=>{
    const regions=route.request().postDataJSON().regions;
    route.fulfill({contentType:'application/json',body:JSON.stringify({supported:true,truncated:false,source:'gdi',
      regions:Object.fromEntries(regions.map((r:any)=>[r.key,[{id:'new-stock',geometry:{type:'Polygon',coordinates:[[[15.98192,45.80002],[15.98198,45.80002],[15.98198,45.80008],[15.98192,45.80008],[15.98192,45.80002]]]}}]]))})});
  });
  await page.locator('#single-building-confirm').click();
  await expect(page.locator(editor)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .find((p:any) => p.goal === 'single' && p.applied)?.buildingProposal?.demolishedBuildings?.map((building:any) => building.id) || []))
    .toContain('new-stock');
});
test('mobile Done saves without a separate acceptance checkbox',async({mockApi:page})=>{
 await page.setViewportSize({width:390,height:844});
 await open(page);
 await expect(page.locator('[data-land-accept]')).toHaveCount(0);
 await finish(page);
 await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p:any) => p.goal === 'single' && p.applied).length)).toBe(1);
});
test('reopening an unchanged land review does not create discardable edits',async({mockApi:page})=>{
 await open(page);
 await finish(page);
 await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p:any) => p.goal === 'single' && p.applied))).toBe(true);
 const savedId = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p:any) => p.goal === 'single' && p.applied).proposalId);
 await showProposal(page, savedId);
 await page.locator('#proposal-details-footer .btn-edit-geometry').click();
 await expect(page.locator('[data-land-status]')).toContainText('m²');
 const toggle=page.locator(`${editor} .on-map-editor__toggle`);
 const body=page.locator(`${editor} .on-map-editor__body`);
 await expect(toggle).toHaveAttribute('aria-expanded','true');
 await toggle.click();
 await expect(toggle).toHaveAttribute('aria-expanded','false');
 await expect(body).toBeHidden();
 await toggle.click();
 await expect(toggle).toHaveAttribute('aria-expanded','true');
 await expect(body).toBeVisible();
 await page.locator(`${editor} .on-map-editor__header .close-circle-btn`).click();
 await expect(page.locator(editor)).toHaveCount(0);
 await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('Done saves the imported GLB without separate acceptance', async ({ mockApi: page }) => {
  await page.route('**/models', route => route.fulfill({ json: { modelUrl: '/uploads/models/test-building.glb' } }));
  await open(page);
  await page.locator('#single-building-glb-upload').click();
  await page.locator('#building-upload-file').setInputFiles('../test-assets/test-building.glb');
  await expect(page.locator('#building-upload-confirm')).toBeEnabled({ timeout: 20000 });
  await page.locator('#building-upload-confirm').click();
  await expect(page.locator('#building-upload-modal')).toHaveCount(0);
  await expect(page.locator('[data-land-status]')).toContainText('m²');
  await expect(page.locator('[data-land-accept]')).toHaveCount(0);
  await finish(page);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p:any) => p.goal === 'single' && p.applied).length), {timeout:20000}).toBe(1);
  const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p:any) => p.goal === 'single' && p.applied));
  expect(JSON.stringify(saved.geometry)).toContain('/uploads/models/test-building.glb');
});

// Row interactions identify the same source parcel in both the list and the map.
test('parcel rows highlight on hover and click, with equal bulk buttons and compact IDs', async ({ mockApi: page }) => {
  await open(page);
  const row = page.locator('.land-take-row').first();
  await expect(page.locator('[data-land-intro]')).toHaveText('Choose the land taken from each touched parcel. The building keeps its shape.');
  await expect(page.locator('.land-take-row')).toHaveCount(1);
  await expect(page.locator('#single-building-add, #single-building-selector, #single-move-together, [data-land-retry], .land-take-legend, [data-land-multi]')).toHaveCount(0);
  await row.hover();
  await expect(row).toHaveClass(/is-highlighted/);
  await expect(page.locator('.land-take-focus')).toHaveCount(1);
  // Read just geometry from the Leaflet layer (the layer itself has circular references).
  expect(await page.evaluate(() => {
    const w = window as any;
    return (Object.values(w.map._layers).find((l: any) => l._path?.classList.contains('land-take-focus')) as any)?.feature.geometry;
  })).toEqual({type:'Polygon',coordinates:[[[15.9819,45.8],[15.9825,45.8],[15.9825,45.8005],[15.9819,45.8005],[15.9819,45.8]]]});
  await page.locator('#single-height-slider').hover();
  await expect(page.locator('.land-take-focus')).toHaveCount(0);
  await row.locator('.land-take-parcel-id').click();
  await page.locator('#single-height-slider').click();
  await expect(page.locator('.land-take-focus')).toHaveCount(1);
  await page.setViewportSize({width:390,height:844});
  const footprint = await page.locator('[data-land-footprint]').boundingBox();
  const whole = await page.locator('[data-land-whole]').boundingBox();
  expect(Math.abs(footprint!.width-whole!.width)).toBeLessThan(1);
  expect(footprint!.y).toBe(whole!.y);
  const id = page.locator('.land-take-parcel-id').first();
  expect(await id.evaluate(e => getComputedStyle(e).whiteSpace)).toBe('nowrap');
});

test('deep zoom reuses native basemap tiles and survives an address round trip', async ({ mockApi: page }) => {
  await open(page);
  expect(await page.evaluate(() => (window as any).map.getMaxZoom())).toBe(23);
  await page.evaluate(() => (window as any).map.setZoom(23, {animate:false}));
  expect(await page.evaluate(() => (window as any).map.getZoom())).toBe(23);
  expect(await page.evaluate(() => (window as any).WorldEntryModel.parseAt(new URL(location.href).searchParams.get('at')).zoom)).toBe(23);
  const tiles = await page.evaluate(() => {
    const w = window as any;
    return Object.values(w.map._layers).filter((l:any) => typeof l.getTileUrl === 'function').map((l:any)=>({max:l.options.maxZoom,native:l.options.maxNativeZoom,tileZoom:l._tileZoom}));
  });
  expect(tiles).toContainEqual({max:23,native:19,tileZoom:19});
});

test('bulk land choices keep their spinner until the source review completes', async ({ mockApi: page }) => {
  await open(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/buildings/under', async route => {
    await gate;
    const regions = route.request().postDataJSON().regions;
    await route.fulfill({json:{supported:true,truncated:false,source:'gdi',regions:Object.fromEntries(regions.map((r:any)=>[r.key,[]]))}});
  });
  const button = page.locator('[data-land-whole]');
  await button.click();
  await expect(button).toHaveAttribute('aria-busy','true');
  await expect(button).toBeDisabled();
  release();
  await expect(button).not.toHaveAttribute('aria-busy');
  await expect(button).toBeEnabled();
  await expect(page.locator('[data-land-status]')).toContainText('m²');
  await expect(page.locator('[data-land-rows] select')).toHaveValue('whole');
});
