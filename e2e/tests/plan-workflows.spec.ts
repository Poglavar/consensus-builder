import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal, chooseProfileName, stackSection } from '../helpers/runtime';
import { pageIndex, cidOfObject } from '../helpers/mocks/shared-server';
import { sampleParcels } from '../helpers/mocks/parcel-data';

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

// A plan's designs stand together: a park and a square on one parcel cannot share a plan.
async function rivalSpaces(page:any) {
  await openCity(page);
  const park=await createSpace(page,'park');
  await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), park);
  const square=await createSpace(page,'square');
  return { park, square };
}
test('ticking a design for a plan applies it virtually with the ticked ones and refuses one that cannot stand',async({mockApi:page})=>{
  test.setTimeout(120000);
  await rivalSpaces(page);
  await openPlans(page);
  await page.locator('#lists-actions').getByRole('button',{name:'Create plan',exact:true}).click();
  const choices=page.locator('#proposal-list-host input[type="checkbox"]');
  await expect(choices).toHaveCount(2);
  await choices.nth(0).check();
  await choices.nth(1).click();
  await expect(page.locator('.cb-toast').filter({hasText:'cannot be in this plan'})).toBeVisible();
  await expect(choices.nth(1)).not.toBeChecked();
  await expect(page.locator('#lists-actions .lists-selection-count')).toHaveText('1 selected');
  // The trial is rolled back: the square still stands and the park is still parked.
  expect(await page.evaluate(()=>(window as any).proposalStorage.getAllProposals().filter((p:any)=>(window as any).isApplied(p)).map((p:any)=>p.structureProposal?.kind))).toEqual(['square']);
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
  await page.getByRole('button',{name:'Square plan',exact:true}).click();
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
  await page.getByRole('button',{name:'Pocket spaces',exact:true}).click();
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
