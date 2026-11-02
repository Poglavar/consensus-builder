import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal, chooseProfileName, stackSection } from '../helpers/runtime';
import { pageIndex, cidOfObject } from '../helpers/mocks/shared-server';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { fillNativeDateTime } from '../helpers/controls';

// Lists (01268caee) puts Create plan in #lists-actions; a saved plan opens in the click stack's Plan
// section, which holds Share plan and Create agreement. Add to plan heads the design card (7cc412330).
const writes = (page:any) => pageIndex(page).requests.filter(request => request.method==='POST' && ['/pins','/designs','/plans','/agreements'].includes(request.path));
async function openPlans(page:any) {
  if(!await page.locator('#proposals-sheet').isVisible())await page.locator('#proposals-button').click();
  await page.locator('#shareAppliedProposalsButton').click();
  await expect(page.locator('#designs-plans')).toBeVisible();
}
// Create plan ticks the designs in Lists → Designs; Continue opens the composer listing them.
async function chooseDesigns(page:any) {
  const choices=page.locator('#proposal-list-host input[type="checkbox"]');
  await expect(choices.first()).toBeVisible();
  for(const choice of await choices.all())await choice.check();
  const count=await choices.count();
  await page.locator('#lists-actions [data-lists-continue]').click();
  await expect(page.locator('.plan-composer .plan-dialog__members li')).toHaveCount(count);
}
async function savePlan(page:any, title:string) {
  const composer=page.locator('.plan-composer');
  await composer.getByLabel('Plan name',{exact:true}).fill(title);
  await composer.getByRole('button',{name:'Create plan',exact:true}).click();
  await expect(composer).toBeHidden();
  await expect(stackSection(page,'plans').locator('.click-stack__row')).toHaveAttribute('aria-expanded','true');
  await expect(stackSection(page,'plans')).toContainText(title);
  return page.evaluate(title => (window as any).PlanWorkspace.list().find((row:any)=>row.content.title===title),title);
}
async function openImportedPlanDetails(page:any, title:string) {
  if (await page.locator('#click-stack').isVisible()) {
    await page.keyboard.press('Escape');
    await expect(page.locator('#click-stack')).toBeHidden();
  }
  if (!await page.locator('#proposals-sheet').isVisible()) await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
  await sheet.locator('#lists-actions').getByRole('button', { name: 'Imported plans', exact: true }).click();
  await page.locator('.plan-file-imported').getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.locator('.plan-details')).toBeVisible();
}
async function importPlanAndOpenDetails(page:any, title:string) {
  const fileText = await page.evaluate(async title => {
    const w = window as any;
    const row = w.PlanWorkspace.list().find((item:any) => item.content.title === title);
    const records = w.PlanComposition.localRecords(row, { apiBase: w.DesignSync.apiBase() });
    const file = await w.PlanFile.create(records, { title: row.content.title, view: row.content.view });
    return w.PlanFile.stringify(file);
  }, title);
  if (await page.locator('#click-stack').isVisible()) {
    await page.keyboard.press('Escape');
    await expect(page.locator('#click-stack')).toBeHidden();
  }
  if (!await page.locator('#proposals-sheet').isVisible()) await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
  const picker = page.waitForEvent('filechooser');
  await sheet.locator('[data-lists-import="plans"]').click();
  await (await picker).setFiles({ name: 'saved-plan.ugt.json', mimeType: 'application/json', buffer: Buffer.from(fileText) });
  await expect(page.getByRole('heading', { name: 'Review plan file', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Import as drafts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Plan imported', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open imported plan', exact: true }).click();
  await expect(page.locator('.plan-details')).toBeVisible();
}

test('Plan creation is local; sharing publishes only the saved immutable snapshot',async({mockApi:page})=>{
  test.setTimeout(120000);
  await openCity(page);
  await page.evaluate(()=>(window as any).guestPolicyBlocks('publish'));
  await chooseProfileName(page,'Plan author');
  const first=await createSpace(page,'park');
  await openPlans(page);
  const heading=page.locator('#proposals-sheet-title');
  await expect(heading).toHaveText('Lists');
  await expect(page.locator('#designs-agreements-button')).toHaveCount(0);
  await page.locator('#lists-actions').getByRole('button',{name:'Create plan',exact:true}).click();
  await chooseDesigns(page);
  await expect(page.locator('.plan-composer').getByRole('button',{name:/Share|Publish|agreement/i})).toHaveCount(0);
  const plan=await savePlan(page,'Original park plan');
  expect(writes(page)).toHaveLength(0);
  const attemptedSessions: any[] = [];
  await page.route('**/mcp/plan-sessions', async route => {
    attemptedSessions.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: { error: 'Shared plan service unavailable' } });
  });
  await stackSection(page,'plans').locator('.click-stack__collaborate-plan').click();
  const collaboration = page.locator('.plan-collaboration');
  const connect = collaboration.getByRole('button', { name: 'Collaborate', exact: true });
  await connect.click();
  await expect(collaboration.getByRole('alert')).toHaveText('Shared plan service unavailable');
  await expect(connect).toBeEnabled();
  expect(attemptedSessions).toHaveLength(1);
  expect(attemptedSessions[0].plan.plan).toEqual(plan.content);
  await page.keyboard.press('Escape');
  await expect(collaboration).toHaveCount(0);
  expect(writes(page)).toHaveLength(0);
  // A later edit to the live design does not silently update this saved plan's source bytes.
  await page.evaluate(id=>{const w=window as any,r=w.proposalStorage.getProposal(id);r.title='Later local edit';w.proposalStorage._indexProposal(r);},first);
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await stackSection(page,'plans').getByRole('button',{name:'Share plan',exact:true}).click();
  const share=page.locator('.plan-share');
  await expect(share).toBeVisible();
  const box=(await share.locator('..').locator('..').boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(420);
  expect(box.height).toBeLessThan(450);
  await expect(share.locator('input[type="checkbox"],input[type="search"]')).toHaveCount(0);
  await expect(share.getByRole('button',{name:/Add|Create agreement|Edit/i})).toHaveCount(0);
  expect(writes(page)).toHaveLength(0);
  await share.getByRole('button',{name:'Publish and copy link',exact:true}).click();
  await expect(share.getByLabel('Plan link',{exact:true})).toHaveValue(new RegExp(`/plans/${plan.cid}`));
  const sent=writes(page);
  expect(sent.filter(request=>request.path==='/designs').map(request=>request.body.cid)).toEqual(plan.content.designCids);
  expect(sent.find(request=>request.path==='/designs')!.body.content).toEqual(plan.designs[0].content);
  expect(sent.find(request=>request.path==='/plans')!.body.content).toEqual(plan.content);
  expect(cidOfObject(sent.find(request=>request.path==='/plans')!.body.content)).toBe(plan.cid);
  expect(sent.filter(request=>request.path==='/agreements')).toHaveLength(0);
  const before=sent.length;
  await share.getByRole('button',{name:'Copy link',exact:true}).click();
  expect(writes(page)).toHaveLength(before);
});

test('saved plan details expose Share, Edit, Cancel and Construction schedule actions', async ({ mockApi: page }) => {
  await openCity(page);
  await createSpace(page, 'park');
  await openPlans(page);
  await page.locator('#lists-actions').getByRole('button', { name: 'Create plan', exact: true }).click();
  await chooseDesigns(page);
  const original = await savePlan(page, 'Plan details actions');

  await importPlanAndOpenDetails(page, 'Plan details actions');
  let details = page.locator('.plan-details');
  await details.getByRole('button', { name: 'Share plan', exact: true }).click();
  await expect(page.locator('.plan-share')).toBeVisible();
  await page.keyboard.press('Escape');

  await openImportedPlanDetails(page, 'Plan details actions');
  details = page.locator('.plan-details');
  await details.getByRole('button', { name: 'Edit plan', exact: true }).click();
  const composer = page.locator('.plan-composer');
  await expect(composer.getByLabel('Plan name', { exact: true })).toHaveValue('Plan details actions');
  await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(composer).toBeHidden();
  expect(await page.evaluate(() => (window as any).PlanWorkspace.list().map((row:any) => row.cid))).toEqual([original.cid]);

  await openImportedPlanDetails(page, 'Plan details actions');
  details = page.locator('.plan-details');
  await details.getByRole('button', { name: 'Construction schedule', exact: true }).click();
  const schedule = page.locator('.plan-schedule');
  const start = schedule.locator('input[type="month"]').first();
  await fillNativeDateTime(start, '2026-03');
  await expect(schedule.getByRole('button', { name: 'Save schedule', exact: true })).toBeEnabled();
  await schedule.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(schedule).toBeHidden();
  const revisions = await page.evaluate(() => (window as any).PlanWorkspace.list());
  expect(revisions).toHaveLength(2);
  const revised = revisions.find((row:any) => row.cid !== original.cid);
  expect(revised.content.schedule).toEqual({ [revised.content.designCids[0]]: { start: '2026-03', end: '2026-03' } });
  expect((revisions.find((row:any) => row.cid === original.cid)).content.schedule).toBeUndefined();
});

test('known duplicate plan names are advisory while saving stays available', async ({ mockApi: page }) => {
  await openCity(page);
  const designId = await createSpace(page, 'park');
  const existing = await page.evaluate(id => {
    const w = window as any;
    const plan = w.PlanComposition.create('Garden  Plan', [w.proposalStorage.getProposal(id)], w.MapShare.capture(w));
    return w.PlanWorkspace.save(plan);
  }, designId);

  // The plan being revised is not a duplicate of itself.
  await page.evaluate(plan => { void (window as any).PlanDialog.create({ base: plan }); }, existing);
  const composer = page.locator('.plan-composer');
  await expect(composer).toBeVisible();
  await expect(composer.locator('.plan-dialog__duplicate')).toBeHidden();
  await page.keyboard.press('Escape');

  await page.evaluate(id => { void (window as any).PlanDialog.create({ members: [(window as any).proposalStorage.getProposal(id)] }); }, designId);
  await expect(composer).toBeVisible();
  const name = composer.getByLabel('Plan name', { exact: true });
  await name.fill('  garden   plan  ');
  const advisory = composer.locator('.plan-dialog__duplicate');
  await expect(advisory).toHaveText(/already available here.*still use this name/i);
  await expect(advisory.locator('code.record-id')).toHaveText(`…${existing.cid.slice(-8)}`);
  await expect(composer.getByRole('button', { name: 'Create plan', exact: true })).toBeEnabled();
  await composer.getByRole('button', { name: 'Create plan', exact: true }).click();
  await expect(composer).toBeHidden();
  expect(await page.evaluate(() => (window as any).PlanWorkspace.list()
    .filter((row: any) => row.content.title.toLowerCase().replace(/\s+/g, ' ').trim() === 'garden plan').length)).toBe(2);
});

// A plan's designs stand together: a park and a square on one parcel cannot share a plan.
async function rivalSpaces(page:any) {
  await openCity(page);
  const park=await createSpace(page,'park');
  await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), park);
  const square=await createSpace(page,'square');
  return { park, square };
}
test('the design ticked last for a plan takes its ground, and the ticked one it stands down is unticked with a warning',async({mockApi:page})=>{
  test.setTimeout(120000);
  await rivalSpaces(page);
  await openPlans(page);
  await page.locator('#lists-actions').getByRole('button',{name:'Create plan',exact:true}).click();
  const choices=page.locator('#proposal-list-host input[type="checkbox"]');
  await expect(choices).toHaveCount(2);
  await choices.nth(0).check();
  await choices.nth(1).click();
  await expect(page.locator('.cb-toast').filter({hasText:'is no longer ticked'})).toBeVisible();
  await expect(choices.nth(1)).toBeChecked();
  await expect(choices.nth(0)).not.toBeChecked();
  await expect(page.locator('#lists-actions .lists-selection-count')).toHaveText('1 selected');
  // The trial is rolled back: the square still stands and the park is still parked.
  expect(await page.evaluate(()=>(window as any).proposalStorage.getAllProposals().filter((p:any)=>(window as any).isApplied(p)).map((p:any)=>p.structureProposal?.kind))).toEqual(['square']);
});
// A plan of this browser's own designs, never published, opened unapplied: Create agreement applies
// the designs it already holds instead of importing copies of them beside the originals.
test('creating an agreement on a plan of unpublished designs applies those designs, without copies',async({mockApi:page})=>{
  test.setTimeout(120000);
  await openCity(page);
  const park=await createSpace(page,'park');
  await showProposal(page,park);
  await stackSection(page,'designs').locator('[data-design-action="add-to-plan"]').click();
  await savePlan(page,'Own park plan');
  await page.evaluate(id=>(window as any).ProposalManager.unapplyProposal(id),park);
  await stackSection(page,'plans').getByRole('button',{name:'Create agreement',exact:true}).click();
  await page.getByRole('button',{name:'Apply and continue',exact:true}).click();
  await expect(page.locator('#agreement-editor')).toBeVisible();
  const records=await page.evaluate(()=>(window as any).proposalStorage.getAllProposals().map((p:any)=>({id:p.proposalId,applied:(window as any).isApplied(p)})));
  expect(records).toEqual([{id:park,applied:true}]);
});
test('saving a plan refuses designs that cannot stand together, as Add to plan offers them',async({mockApi:page})=>{
  test.setTimeout(120000);
  const { park, square }=await rivalSpaces(page);
  await showProposal(page,square);
  await stackSection(page,'designs').locator('[data-design-action="add-to-plan"]').click();
  await savePlan(page,'Square plan');
  await page.keyboard.press('Escape');
  await showProposal(page,park);
  await stackSection(page,'designs').locator('[data-design-action="add-to-plan"]').click();
  const squarePlanCid=await page.evaluate(()=>(window as any).PlanWorkspace.list().find((row:any)=>row.content.title==='Square plan')?.cid);
  expect(squarePlanCid).toBeTruthy();
  await page.locator(`.cb-dialog__footer button[data-action-id="${squarePlanCid}"]`).click();
  const composer=page.locator('.plan-composer');
  await composer.getByRole('button',{name:'Save new revision',exact:true}).click();
  await expect(composer.locator('.plan-dialog__status')).toContainText('cannot stand together with the rest of this plan');
  expect(await page.evaluate(()=>(window as any).PlanWorkspace.list().filter((row:any)=>row.content.title==='Square plan').length)).toBe(1);
});
test('Add to plan creates a reviewed revision and retains the old membership',async({mockApi:page})=>{
  test.setTimeout(120000);await page.setViewportSize({width:390,height:844});
  await openCity(page);const first=await createSpace(page,'park');
  await showProposal(page,first);
  await stackSection(page,'designs').locator('[data-design-action="add-to-plan"]').click();
  await expect(page.locator('.plan-composer .plan-dialog__members li')).toHaveCount(1);
  const original=await savePlan(page,'Pocket spaces');
  await page.keyboard.press('Escape');
  await expect(stackSection(page,'plans')).toHaveCount(0);
  // On its own parcel: a plan's designs stand together, so the square cannot take the park's ground.
  const second=await createSpace(page,'square',sampleParcels.features[1].properties.parcelId);
  await showProposal(page,second);
  await stackSection(page,'designs').locator('[data-design-action="add-to-plan"]').click();
  await page.locator(`.cb-dialog__footer button[data-action-id="${original.cid}"]`).click();
  const composer=page.locator('.plan-composer');
  await expect(composer.getByText('Saving changes creates a new plan revision. Existing links stay unchanged.')).toBeVisible();
  await expect(composer.locator('.plan-dialog__members li')).toHaveCount(2);
  await composer.getByRole('button',{name:'Save new revision',exact:true}).click();
  await expect(stackSection(page,'plans').locator('.click-stack__row')).toHaveAttribute('aria-expanded','true');
  const saved=await page.evaluate(()=>(window as any).PlanWorkspace.list().filter((row:any)=>row.content.title==='Pocket spaces'));
  expect(saved).toHaveLength(2);
  expect(saved.find((row:any)=>row.cid===original.cid).content.designCids).toEqual(original.content.designCids);
  const next=saved.find((row:any)=>row.cid!==original.cid);expect(next.content.designCids).toHaveLength(2);
  expect(writes(page)).toHaveLength(0);
  await stackSection(page,'plans').getByRole('button',{name:'Create agreement',exact:true}).click();
  await expect(page.locator('#agreement-editor')).toBeVisible();
  await expect(page.locator('#agreement-editor [data-agreement-plan]')).toHaveValue(next.cid);
  await expect(page.locator('#agreement-editor .plan-composer')).toHaveCount(0);
});
