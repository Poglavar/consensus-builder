import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, chooseProfileName, stubBasemapTiles } from '../helpers/runtime';
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
async function createLocalPlan(page:any,title:string) {
  await page.locator('#designs-plans').getByRole('button',{name:'Create plan',exact:true}).click();
  const composer=page.locator('.plan-composer');
  await composer.getByLabel('Plan name',{exact:true}).fill(title);
  for(const choice of await composer.locator('input[type="checkbox"]').all()) await choice.check();
  await composer.getByRole('button',{name:'Create plan',exact:true}).click();
  await expect(page.locator('.plan-details')).toBeVisible();
  return page.evaluate(title => (window as any).PlanWorkspace.list().find((row:any)=>row.content.title===title),title);
}

test('map controls stay inside the viewport after a live desktop-to-phone resize', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 1180, height: 757 });
  await openCity(page);
  await page.setViewportSize({ width: 500, height: 757 });
  for (const selector of ['#username-display', '#map-shell-bottom-right', '#map-shell-top-right']) {
    await expect.poll(() => page.locator(selector).evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= 500;
    })).toBe(true);
  }
});

test('desktop Designs library and saved plans start local with no public plan link', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openCity(page); await openLibrary(page);
  const panel=page.locator('#proposals-sheet');
  expect((await panel.boundingBox())!.x).toBeGreaterThan(1280/2);
  await expect(panel.getByRole('tab',{name:'Designs',exact:true})).toHaveAttribute('aria-selected','true');
  await panel.getByRole('tab',{name:'Saved plans',exact:true}).click();
  await expect(panel.locator('#designs-plans')).toContainText('No saved plans yet.');
  await expect(panel.locator('#designs-plans input[readonly]')).toHaveCount(0);
  await expect(panel.locator('#designs-plans a[href*="/plans/"]')).toHaveCount(0);
  expect(writes(page)).toHaveLength(0);
});

test('a local plan publishes its exact snapshot only on Share plan and copy repeat makes no writes', async ({ mockApi: page }) => {
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
  await page.locator('.plan-details').getByRole('button',{name:'Share plan',exact:true}).click();
  const share=page.locator('.plan-share');await expect(share).toBeVisible();
  await expect(share.getByLabel('Plan link',{exact:true})).toBeHidden();expect(writes(page)).toHaveLength(0);
  await share.getByRole('button',{name:'Publish and copy link',exact:true}).click();
  const link=share.getByLabel('Plan link',{exact:true});await expect(link).toHaveValue(new RegExp(`/plans/${row.cid}`));
  const sent=writes(page);
  expect(sent.filter(r=>r.path==='/designs').map(r=>r.body.cid)).toEqual(row.content.designCids);
  expect(sent.find(r=>r.path==='/designs')!.body.content).toEqual(row.designs[0].content);
  expect(sent.find(r=>r.path==='/plans')!.body.content).toEqual(row.content);
  expect(cidOfObject(sent.find(r=>r.path==='/plans')!.body.content)).toBe(row.cid);
  expect(sent.filter(r=>r.path==='/agreements')).toHaveLength(0);
  const count=sent.length;await share.getByRole('button',{name:'Copy link',exact:true}).click();expect(writes(page)).toHaveLength(count);
  await page.keyboard.press('Escape');await expect(share).toBeHidden();
  await expect(page.locator('#designs-plans')).toBeVisible();
  await page.locator('#designs-browse-tab').click();await expect(page.locator('#designs-browse')).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.locator('#proposals-sheet')).toBeHidden();
});

test('phone Designs and Saved plans use keyboard tabs in one resizable sheet', async ({ mockApi: page }) => {
  await page.setViewportSize({ width:390,height:844 });await openCity(page);await openLibrary(page);
  const panel=page.locator('#proposals-sheet');
  await expect(panel.locator(':scope > .mobile-dock-sheet-handle')).toHaveCount(1);
  const designs=panel.getByRole('tab',{name:'Designs',exact:true}),plans=panel.getByRole('tab',{name:'Saved plans',exact:true});
  await designs.focus();await page.keyboard.press('ArrowRight');await expect(plans).toHaveAttribute('aria-selected','true');
  await expect(panel.locator('#designs-plans')).toBeVisible();await expect(panel.locator(':scope > .mobile-dock-sheet-handle')).toHaveCount(1);
  const box=(await panel.boundingBox())!;expect(box.x).toBe(0);expect(box.width).toBe(390);expect(box.y+box.height).toBeLessThanOrEqual(844);
  await page.keyboard.press('ArrowLeft');await expect(designs).toHaveAttribute('aria-selected','true');await expect(panel.locator('#designs-browse')).toBeVisible();
  await page.keyboard.press('Escape');await expect(panel).toBeHidden();
});
