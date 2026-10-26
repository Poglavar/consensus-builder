import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, stubBasemapTiles, showProposal } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';
const editor = '#single-building-editor';
const first = 'HR-335754-1234';
async function open(page: any) {
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('#parcel-info-panel .parcel-build-btn--single').click();
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
  const body=await page.evaluate(()=>(window as any).OnMapEditor.getPreview().draftPreview.features[0].geometry);
  await selectNativeOption(page.locator(`[data-parcel-id="${first}"]`),'whole');
  await page.locator('[data-land-footprint]').click();
  await expect(page.locator(`[data-parcel-id="${first}"]`)).toHaveValue('footprint');
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
test('missing stock keeps the unsaved editor open',async({mockApi:page})=>{
  await open(page);
  await page.route('**/buildings/under',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({supported:true,truncated:true,regions:{}})}));
  await page.locator('#single-building-confirm').click();
  await expect(page.locator('[data-land-status]')).toContainText('Could not verify');
  await expect(page.locator('#single-land-take-error')).toBeVisible();
  await expect(page.locator('[data-land-accept]')).toHaveCount(0);
  await expect(page.locator(`${editor} .on-map-editor__panel`)).toBeVisible();
  await page.route('**/buildings/under', route => {
    const regions = route.request().postDataJSON().regions;
    return route.fulfill({ json: { supported: true, truncated: false, source: 'gdi', regions: Object.fromEntries(regions.map((r: any) => [r.key, []])) } });
  });
  await page.locator('[data-land-retry]').click();
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
test('loading an untouched land review does not create discardable edits',async({mockApi:page})=>{
 await open(page);
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
