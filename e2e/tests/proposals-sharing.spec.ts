import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, openOnAnotherDevice, chooseProfileName } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';

test('sharing a plan publishes its exact selected designs and another device restores the snapshot', async ({ mockApi: page, browser, baseURL }) => {
  test.setTimeout(180_000);
  await openCity(page); await page.evaluate(()=>(window as any).guestPolicyBlocks('publish')); await chooseProfileName(page,'Plan author');
  const first=await createSpace(page, 'park');
  await page.evaluate(async id => { await (window as any).ProposalManager.unapplyProposal(id); }, first);
  await createSpace(page, 'square');
  await page.locator('#proposals-button').click();
  await page.locator('#shareAppliedProposalsButton').click();
  await page.locator('#designs-plans').getByRole('button', { name: 'Create plan', exact: true }).click();
  const form = page.locator('.plan-composer');
  await form.getByLabel('Plan name', { exact: true }).fill('Two gardens');
  await expect(form.locator('input[type=checkbox]')).toHaveCount(2);
  await form.locator('input[type=checkbox]').nth(0).check();
  await form.locator('input[type=checkbox]').nth(1).uncheck();
  await form.getByRole('button', { name: 'Create plan', exact: true }).click();
  await expect(page.locator('.plan-details')).toBeVisible();
  const row = await page.evaluate(() => (window as any).PlanWorkspace.list()[0]);
  expect(row.content.designCids).toHaveLength(1);
  await page.locator('.plan-details').getByRole('button', { name: 'Share plan', exact: true }).click();
  const share = page.locator('.plan-share');
  await expect(share.locator('.plan-dialog__members li')).toHaveCount(1);
  await share.getByRole('button', { name: 'Publish and copy link', exact: true }).click();
  const linkField=share.getByLabel('Plan link', { exact: true });
  await expect(linkField).toHaveValue(new RegExp(`/plans/${row.cid}`));
  const link = await linkField.inputValue();
  const index = pageIndex(page);
  expect(index.requests.filter(r => r.method === 'POST' && r.path === '/plans')).toHaveLength(1);
  expect(index.requests.filter(r => r.method === 'POST' && r.path === '/designs')).toHaveLength(1);
  const receiver = await openOnAnotherDevice(browser, link, index, baseURL);
  try {
    await expect(receiver.page).toHaveTitle('Two gardens · Consensus Builder');
    await expect.poll(() => receiver.page.evaluate(cid => !!(window as any).DesignSync.localCopyOf(cid), row.content.designCids[0])).toBe(true);
  } finally { await receiver.context.close(); }
});

test('a plan cannot be published when a member snapshot is missing', async ({ mockApi: page }) => {
  await openCity(page);
  const result=await page.evaluate(async()=>{
    const w:any=window,content={schema:'plan/v1',title:'Missing member',designCids:[w.Cid.cidOfObject({schema:'design/v1',goal:'park',note:'missing'})],view:w.MapShare.capture(w)};
    const plan={content,cid:w.Cid.cidOfObject(content)};
    try{await w.PlanWorkspace.resolve(plan);return null;}catch(error:any){return error.message;}
  });
  expect(result).toContain('could not be found');
});
