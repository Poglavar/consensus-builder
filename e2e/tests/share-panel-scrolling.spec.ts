import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity } from '../helpers/runtime';

for (const width of [1280, 390]) {
  test(`plan composer stays usable with a long design list at ${width}px`, async ({ mockApi: page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openCity(page);
    const id = await createSpace(page, 'park');
    await page.evaluate(seedId => {
      const w:any=window, source=w.proposalStorage.getProposal(seedId);
      for(let i=1;i<24;i++)w.proposalStorage.addProposal({...structuredClone(source),proposalId:`long-list-${i}`,title:`Park design ${i}`,applied:true});
    }, id);
    await page.locator('#proposals-button').click();
    await page.locator('#shareAppliedProposalsButton').click();
    await page.locator('#designs-plans').getByRole('button',{name:'Create plan',exact:true}).click();
    const list=page.locator('.plan-dialog__choices');
    await expect(list.locator('input[type=checkbox]')).toHaveCount(24);
    await expect.poll(()=>list.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
    await list.hover(); await page.mouse.wheel(0,2500);
    await expect.poll(()=>list.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
    await expect(page.locator('.plan-dialog__footer')).toBeInViewport();
  });
}
