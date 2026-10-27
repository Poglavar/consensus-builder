import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, openOnAnotherDevice, chooseProfileName } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';

for (const width of [1280, 390]) {
  test(`a saved plan shares its immutable snapshot at ${width}px`, async ({ mockApi: page, browser, baseURL }) => {
    test.setTimeout(180_000); await page.setViewportSize({ width, height: 844 }); await openCity(page); await page.evaluate(()=>(window as any).guestPolicyBlocks('publish')); await chooseProfileName(page,'Plan author');
    const id=await createSpace(page,'park'); await page.locator('#proposals-button').click(); await page.locator('#shareAppliedProposalsButton').click();
    await page.locator('#lists-actions').getByRole('button',{name:'Create plan',exact:true}).click();
    const form=page.locator('.plan-composer'); await form.getByLabel('Plan name',{exact:true}).fill('Riverside Garden'); await form.locator('input[type=checkbox]').check(); await form.getByRole('button',{name:'Create plan',exact:true}).click();
    await expect(form).toBeHidden(); await expect(page.locator('.plan-details')).toHaveCount(0);
    const section=page.locator('#click-stack .click-stack__section[data-kind="plans"]');
    await expect(section.locator('.click-stack__row')).toHaveAttribute('aria-expanded','true');
    await expect(section).toContainText('Riverside Garden');
    const plan=await page.evaluate(()=>(window as any).PlanWorkspace.list()[0]); const snapshot=structuredClone(plan.content);
    expect(await page.evaluate(()=>(window as any).ClickStack.current().sections.find((s:any)=>s.kind==='plans').instances[0].cid)).toBe(plan.cid);
    expect(pageIndex(page).requests.filter(r=>r.method==='POST'&&['/pins','/designs','/plans'].includes(r.path))).toHaveLength(0);
    await page.evaluate(id=>{const w:any=window,r=w.proposalStorage.getProposal(id);r.title='Later change';w.proposalStorage._indexProposal(r);},id);
    await section.getByRole('button',{name:'Share plan',exact:true}).click(); const share=page.locator('.plan-share');
    await expect(share.getByRole('heading',{name:'Riverside Garden'})).toBeVisible(); await share.getByRole('button',{name:'Publish and copy link',exact:true}).click();
    const linkField=share.getByLabel('Plan link',{exact:true}); await expect(linkField).toBeVisible(); await expect(linkField).toHaveValue(new RegExp(`/plans/${plan.cid}`));
    const link=await linkField.inputValue(); expect(pageIndex(page).requests.find(r=>r.method==='POST'&&r.path==='/plans')!.body.content).toEqual(snapshot);
    const receiver=await openOnAnotherDevice(browser,link,pageIndex(page),baseURL);
    try { await expect(receiver.page).toHaveTitle('Riverside Garden · Consensus Builder'); await expect.poll(()=>receiver.page.evaluate(cid=>!!(window as any).PlanWorkspace.list().find((p:any)=>p.cid===cid),plan.cid)).toBe(true); }
    finally { await receiver.context.close(); }
  });
}

test('a failed plan publish remains retryable and does not create a plan link',async({mockApi:page})=>{
  await openCity(page);await page.evaluate(()=>(window as any).guestPolicyBlocks('publish'));await chooseProfileName(page,'Plan author');await createSpace(page,'park');await page.locator('#proposals-button').click();await page.locator('#shareAppliedProposalsButton').click();
  await page.locator('#lists-actions').getByRole('button',{name:'Create plan',exact:true}).click();const form=page.locator('.plan-composer');await form.getByLabel('Plan name',{exact:true}).fill('Retry garden');await form.locator('input[type=checkbox]').check();await form.getByRole('button',{name:'Create plan',exact:true}).click();
  await page.route('**/plans',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Storage is unavailable'})}));
  await page.locator('#click-stack .click-stack__section[data-kind="plans"]').getByRole('button',{name:'Share plan',exact:true}).click();const share=page.locator('.plan-share');await share.getByRole('button',{name:'Publish and copy link',exact:true}).click();
  await expect(share.locator('[role=status]')).toContainText('Storage is unavailable');await expect(share.getByRole('button',{name:'Publish and copy link',exact:true})).toBeEnabled();await expect(share.getByLabel('Plan link',{exact:true})).toBeHidden();
});
