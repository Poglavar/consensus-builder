import { test, expect } from '../helpers/fixtures';
import { openCity, createBuilding, createSpace, chooseProfileName, stubBasemapTiles } from '../helpers/runtime';
import { pageIndex, cidOfObject } from '../helpers/mocks/shared-server';

test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });

const writes = (page:any) => pageIndex(page).requests.filter(request => request.method==='POST' && ['/pins','/designs','/plans','/agreements'].includes(request.path));
async function openLibrary(page:any) {
  if(!await page.locator('#proposals-sheet').isVisible()) await page.locator('#proposals-button').click();
  await expect(page.locator('#designs-browse')).toBeVisible();
}
async function openPlans(page:any) {
  await openLibrary(page);
  await page.locator('#shareAppliedProposalsButton').click();
  await expect(page.locator('#designs-plans')).toBeVisible();
}
// Lists (01268caee) puts Create plan in the shared #lists-actions row; a created plan opens in the
// click stack's Plan section (0d7bf0e8d), which holds Share plan. Create plan ticks the designs in
// Lists → Designs; Continue opens the composer listing them.
const planSection=(page:any)=>page.locator('#click-stack .click-stack__section[data-kind="plans"]');
async function createLocalPlan(page:any,title:string) {
  await page.locator('#lists-actions').getByRole('button',{name:'Create plan',exact:true}).click();
  const choices=page.locator('#proposal-list-host input[type="checkbox"]');
  await expect(choices.first()).toBeVisible();
  for(const choice of await choices.all()) await choice.check();
  const count=await choices.count();
  await page.locator('#lists-actions [data-lists-continue]').click();
  const composer=page.locator('.plan-composer');
  await expect(composer.locator('.plan-dialog__members li')).toHaveCount(count);
  await composer.getByLabel('Plan name',{exact:true}).fill(title);
  await composer.getByRole('button',{name:'Create plan',exact:true}).click();
  await expect(composer).toBeHidden();
  await expect(planSection(page).locator('.click-stack__row')).toHaveAttribute('aria-expanded','true');
  await expect(planSection(page)).toContainText(title);
  return page.evaluate(title => (window as any).PlanWorkspace.list().find((row:any)=>row.content.title===title),title);
}

test('map controls stay inside the viewport after a live desktop-to-phone resize', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 1180, height: 757 });
  await openCity(page);
  for (const width of [500, 375, 320]) {
    await page.setViewportSize({ width, height: 757 });
    for (const selector of ['#username-display', '#map-shell-bottom-right', '#map-shell-top-right']) {
      await expect.poll(() => page.locator(selector).evaluate((node, width) => {
        const rect = node.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= width;
      }, width)).toBe(true);
    }
    for (const selector of ['.map-search__chip', '.map-search__icon-button', '#planning-views-button', '#username-display', '#chat-button', '#layers-button', '#settings-button']) {
      await expect(page.locator(selector)).toBeVisible();
      await expect.poll(() => page.locator(selector).evaluate(node => {
        const rect = node.getBoundingClientRect();
        const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return rect.left >= 0 && rect.right <= innerWidth && node.contains(target);
      }), `${selector} remains reachable at ${width}px`).toBe(true);
    }
  }
});

test('desktop Designs library and saved plans start local with no public plan link', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openCity(page); await openLibrary(page);
  const panel=page.locator('#proposals-sheet');
  expect((await panel.boundingBox())!.x).toBeGreaterThan(1280/2);
  await expect(panel.getByRole('tab',{name:'Designs',exact:true})).toHaveAttribute('aria-selected','true');
  await panel.getByRole('tab',{name:'Plans',exact:true}).click();
  await expect(panel.locator('#designs-plans')).toBeVisible();
  await expect(panel.locator('#lists-status')).toBeHidden();
  await expect(panel.locator('#designs-plans')).toContainText('Nothing here yet.');
  await expect(panel.locator('#designs-plans .lists-item')).toHaveCount(0);
  await expect(panel.locator('#designs-plans input[readonly]')).toHaveCount(0);
  await expect(panel.locator('#designs-plans a[href*="/plans/"]')).toHaveCount(0);
  expect(writes(page)).toHaveLength(0);
});

test('Share plan publishes a new snapshot when an applied member changed and copy repeat makes no writes', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await openCity(page);
  await page.evaluate(()=>(window as any).guestPolicyBlocks('publish'));
  await chooseProfileName(page,'Plan author');
  const sourceId=await createSpace(page,'park');
  await openPlans(page);
  const row=await createLocalPlan(page,'Pocket park plan');
  expect(writes(page)).toHaveLength(0);
  await page.evaluate(id=>{const w=window as any,r=w.proposalStorage.getProposal(id);r.title='Changed live';w.proposalStorage._indexProposal(r);},sourceId);
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await planSection(page).getByRole('button',{name:'Share plan',exact:true}).click();
  const share=page.locator('.plan-share');await expect(share).toBeVisible();
  await expect(share).toContainText('1 changed designs are ready to publish as a new plan revision.');
  const revised=await page.evaluate(originalCid=>(window as any).PlanWorkspace.list().find((candidate:any)=>candidate.content.title==='Pocket park plan'&&candidate.cid!==originalCid),row.cid);
  expect(revised).toBeTruthy();expect(revised.cid).not.toBe(row.cid);
  await expect(share.getByLabel('Plan link',{exact:true})).toBeHidden();expect(writes(page)).toHaveLength(0);
  await share.getByRole('button',{name:'Publish and copy link',exact:true}).click();
  const link=share.getByLabel('Plan link',{exact:true});await expect(link).toHaveValue(new RegExp(`/plans/${revised.cid}`));
  const sent=writes(page);
  expect(sent.filter(r=>r.path==='/designs').map(r=>r.body.cid)).toEqual(revised.content.designCids);
  expect(sent.find(r=>r.path==='/designs')!.body.content).toEqual(revised.designs[0].content);
  expect(sent.find(r=>r.path==='/plans')!.body.content).toEqual(revised.content);
  expect(cidOfObject(sent.find(r=>r.path==='/plans')!.body.content)).toBe(revised.cid);
  expect(sent.filter(r=>r.path==='/agreements')).toHaveLength(0);
  const count=sent.length;await share.getByRole('button',{name:'Copy link',exact:true}).click();expect(writes(page)).toHaveLength(count);
  await page.keyboard.press('Escape');await expect(share).toBeHidden();
  await page.locator('#proposals-button').click();
  await page.locator('#shareAppliedProposalsButton').click();
  await expect(page.locator(`#designs-plans .lists-item[data-list-id="${revised.cid}"]`)).toContainText('Published');
  await page.locator('#designs-browse-tab').click();await expect(page.locator('#designs-browse')).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.locator('#proposals-sheet')).toBeHidden();
});

test('Share plan follows a building edit saved by the ordinary editor', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await openCity(page); await page.evaluate(()=>(window as any).guestPolicyBlocks('publish'));
  await chooseProfileName(page,'Building plan author');
  const sourceId=await createBuilding(page); await openPlans(page);
  const original=await createLocalPlan(page,'Edited building plan');
  await page.evaluate(async id => { await (window as any).editProposal(id,{tab:'details'}); },sourceId);
  const shell=page.locator('.proposal-editor-shell.is-open'); await expect(shell).toBeVisible();
  await shell.locator('[data-draft-path="fields.description"]').fill('Building revision prepared in the ordinary editor.');
  await shell.locator('[data-editor-action="review"]').click();
  await shell.locator('[data-editor-action="publish"]').click();
  await page.locator('#createProposalSubmitButton').click();
  await expect.poll(() => page.evaluate(id=>(window as any).proposalStorage.getProposal(id)?.description,sourceId))
    .toBe('Building revision prepared in the ordinary editor.');
  await page.evaluate(plan => (window as any).PlanDialog.share(plan),original);
  const share=page.locator('.plan-share'); await expect(share).toContainText('1 changed designs are ready to publish as a new plan revision.');
  const revised=await page.evaluate(cid=>(window as any).PlanWorkspace.list().find((row:any)=>row.content.title==='Edited building plan'&&row.cid!==cid),original.cid);
  expect(revised.cid).not.toBe(original.cid);
  await share.getByRole('button',{name:'Publish and copy link',exact:true}).click();
  await expect(share.getByLabel('Plan link',{exact:true})).toHaveValue(new RegExp(`/plans/${revised.cid}`));
  const sent=writes(page); const planWrite=sent.find(row=>row.path==='/plans');
  expect(planWrite?.body.content).toEqual(revised.content);
  const savedBuilding=sent.find(row=>row.path==='/designs')?.body.content;
  expect(savedBuilding.description).toBe('Building revision prepared in the ordinary editor.');
});

test('phone Designs and Plans use keyboard tabs in one resizable sheet', async ({ mockApi: page }) => {
  await page.setViewportSize({ width:390,height:844 });await openCity(page);await openLibrary(page);
  const panel=page.locator('#proposals-sheet');
  await expect(panel.locator(':scope > .mobile-dock-sheet-handle')).toHaveCount(1);
  const designs=panel.getByRole('tab',{name:'Designs',exact:true}),plans=panel.getByRole('tab',{name:'Plans',exact:true});
  await designs.focus();await page.keyboard.press('ArrowRight');await expect(plans).toHaveAttribute('aria-selected','true');
  await expect(panel.locator('#designs-plans')).toBeVisible();await expect(panel.locator(':scope > .mobile-dock-sheet-handle')).toHaveCount(1);
  const box=(await panel.boundingBox())!;expect(box.x).toBe(0);expect(box.width).toBe(390);expect(box.y+box.height).toBeLessThanOrEqual(844);
  await page.keyboard.press('ArrowLeft');await expect(designs).toHaveAttribute('aria-selected','true');await expect(panel.locator('#designs-browse')).toBeVisible();
  await page.keyboard.press('Escape');await expect(panel).toBeHidden();
});
