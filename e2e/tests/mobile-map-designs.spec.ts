// Phone regressions for the saved-plan workflow, layouts, ownership evidence and absent sources.
import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles, PARCEL_ID, openOnAnotherDevice, chooseProfileName } from '../helpers/runtime';
import { applyLayout, agreementEditor, editorSave } from '../helpers/agreements';
import { pageIndex, fileDesign } from '../helpers/mocks/shared-server';

test.use({ viewport: { width: 390, height: 844 } });
test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });
const writes=(page:any)=>pageIndex(page).requests.filter(r=>r.method==='POST'&&['/pins','/designs','/plans','/agreements'].includes(r.path));
async function openPlans(page:any){if(!await page.locator('#proposals-sheet').isVisible())await page.locator('#proposals-button').click();await page.locator('#shareAppliedProposalsButton').click();await expect(page.locator('#designs-plans')).toBeVisible();}
// Lists (01268caee): Create plan sits in #lists-actions; a saved plan opens in the click stack's Plan section.
const planSection=(page:any)=>page.locator('#click-stack .click-stack__section[data-kind="plans"]');
async function savePlan(page:any,title:string){await page.locator('#lists-actions').getByRole('button',{name:'Create plan',exact:true}).click();const form=page.locator('.plan-composer');await form.getByLabel('Plan name',{exact:true}).fill(title);for(const box of await form.locator('input[type="checkbox"]').all())await box.check();await form.getByRole('button',{name:'Create plan',exact:true}).click();await expect(planSection(page)).toContainText(title);return page.evaluate(title=>(window as any).PlanWorkspace.list().find((r:any)=>r.content.title===title),title);}

test('Designs cards fit a phone; Plans is a tab of the same Lists panel',async({mockApi:page})=>{
  await openCity(page);await page.evaluate(parcelId=>{const w=window as any;for(let i=0;i<15;i++)w.proposalStorage.addProposal({title:`Neighbourhood design ${i}`,goal:'park',author:'Test author',cadastreParcelIds:[parcelId]});},PARCEL_ID);
  await page.locator('#proposals-button').click();const sheet=page.locator('#proposals-sheet');
  const rows=sheet.locator('#proposal-list-host .lists-item');
  await expect(rows).toHaveCount(15);const body=await sheet.locator('.lists-body').boundingBox();expect(body!.height).toBeGreaterThan(844*.55);
  await expect(rows.first()).toBeInViewport({ratio:1});await expect(sheet.locator('#agreementsButton, #mintedAgreementsButton')).toHaveCount(0);
  expect(await sheet.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await sheet.getByRole('tab',{name:'Plans',exact:true}).click();await expect(sheet.locator('#proposals-sheet-title')).toHaveText('Lists');
  await expect(sheet.locator('#designs-plans')).toContainText('No loaded items match these filters.');await expect(sheet.locator('#designs-plans a[href*="/plans/"]')).toHaveCount(0);
});

test('a parcel-layout plan stays local; sharing explains it needs its agreement and plan details still create one',async({mockApi:page})=>{
  test.setTimeout(120_000);const {layoutId}=await applyLayout(page);await openPlans(page);const plan=await savePlan(page,'Layout agreement plan');expect(writes(page)).toHaveLength(0);
  await planSection(page).getByRole('button',{name:'Share plan',exact:true}).click();const share=page.locator('.plan-share');
  await share.getByRole('button',{name:'Publish and copy link',exact:true}).click();await expect(share.locator('.plan-dialog__status')).toContainText(/published with its agreement|Create an agreement/i);
  expect(writes(page)).toHaveLength(0);await page.keyboard.press('Escape');
  await openPlans(page);const row=page.locator('#plan-list-host .lists-item').filter({has:page.getByRole('button',{name:'Layout agreement plan',exact:true})});
  await row.getByRole('button',{name:'Create agreement',exact:true}).click();const editor=agreementEditor(page);
  await expect(editor).toBeVisible();await expect(editor.locator('#agreement-editor-title')).toHaveText('Create agreement');await expect(editor.locator('[data-agreement-plan]')).toHaveValue(plan.cid);
  expect(await page.evaluate(id=>(window as any).proposalStorage.getProposal(id).goal,layoutId)).toBe('parcel-layout');
});

test('a published layout shares its exact saved plan and a fresh device applies it',async({mockApi:page,browser,baseURL})=>{
  test.setTimeout(150_000);const {layoutId}=await applyLayout(page);await page.evaluate(()=>(window as any).guestPolicyBlocks('publish'));await chooseProfileName(page,'Layout publisher');
  const content=await page.evaluate(id=>(window as any).DesignRecord.published((window as any).proposalStorage.getProposal(id)),layoutId);
  const cid=fileDesign(pageIndex(page),content);
  await page.evaluate(({id,cid})=>{const w=window as any;w.DesignSync.markPublished(w.proposalStorage.getProposal(id),{cid,apiBase:w.resolveBackendBaseUrl(),publishedAt:new Date().toISOString()});},{id:layoutId,cid});
  await openPlans(page);const plan=await savePlan(page,'Published layout plan');await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await planSection(page).getByRole('button',{name:'Share plan',exact:true}).click();const share=page.locator('.plan-share');
  await share.getByRole('button',{name:'Publish and copy link',exact:true}).click();const link=share.getByLabel('Plan link',{exact:true});
  await expect(link).toHaveValue(new RegExp(`/plans/${plan.cid}`));const snapshotUrl=new URL(await link.inputValue());
  const requests=writes(page);expect(requests.find(r=>r.path==='/plans')!.body.content).toEqual(plan.content);expect(requests.filter(r=>r.path==='/agreements')).toHaveLength(0);
  const receiver=await openOnAnotherDevice(browser,snapshotUrl.pathname+snapshotUrl.search,pageIndex(page),baseURL);
  try{await expect.poll(()=>receiver.page.evaluate(cid=>{const w=window as any,p=w.proposalStorage.getProposal(`design-${cid}`);return p&&w.isApplied(p)&&p.parcelLayout.plots.length>0;},plan.content.designCids[0]),{timeout:60_000}).toBe(true);}
  finally{await receiver.context.close();}
});

test('2D massing puts Permitted first and disables it cleanly when there is no source',async({mockApi:page})=>{
  await page.route('**/planning/sources?**',route=>route.fulfill({json:{city:'zagreb',sources:[]}}));await openCity(page);await page.locator('#planning-views-button').click();const panel=page.locator('#planning-views');
  await expect(panel.locator('.planning-map-context')).toHaveText('Compare building footprints and massing on the 2D map.');const rows=panel.locator('.planning-layer-row');
  await expect(rows.first().locator('[data-role-label]')).toHaveAttribute('data-role-label','permitted');await expect(rows.nth(1).locator('[data-role-label]')).toHaveAttribute('data-role-label','existing');
  await expect(rows.first()).toHaveAttribute('aria-disabled','true');await expect(rows.first().locator('[data-planning-setting="permitted"]')).toBeDisabled();await expect(rows.nth(1).locator('[data-planning-setting="existing"]')).toBeEnabled();
  await expect(panel.locator('.planning-source-select')).toBeHidden();await expect(panel.locator('.planning-source-note').last()).toBeHidden();await expect(panel.locator('.planning-coverage')).toBeHidden();await expect(panel.locator('.planning-view-status')).toBeHidden();
});

test('phone agreement editor requires a saved plan and fits its tabs without overflow',async({mockApi:page})=>{
  await page.setViewportSize({width:375,height:812});await applyLayout(page);await page.evaluate(()=>{void(window as any).AgreementDialog.open();});const editor=agreementEditor(page);
  await expect(editor).toBeVisible();await expect(editor.locator('#agreement-editor-title')).toHaveText('Create agreement');
  await expect(editor).toContainText('Choose a saved plan');await expect(editorSave(editor)).toBeDisabled();await expect(editor.locator('[data-agreement-plan]')).toHaveValue('');expect(await editor.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
  await editor.getByRole('tab',{name:'Rules',exact:true}).click();await expect(editor.locator('[data-agreement-compensation]')).toBeVisible();
});

test('wrong-city choices have equal touch areas on a phone',async({mockApi:page})=>{
  await openCity(page);await page.evaluate(()=>{void(window as any).promptCityMismatchForProposal('birmingham');});const prompt=page.locator('.city-switch-dialog');await expect(prompt).toBeVisible();
  const stay=await prompt.locator('[data-action-id="stay"]').boundingBox(),open=await prompt.locator('[data-action-id="switch"]').boundingBox();
  expect(stay!.width).toBeCloseTo(open!.width,0);expect(stay!.height).toBeCloseTo(open!.height,0);expect(stay!.height).toBeGreaterThanOrEqual(44);expect(open!.y).toBeGreaterThanOrEqual(stay!.y+stay!.height);await prompt.locator('[data-action-id="stay"]').click();
});
