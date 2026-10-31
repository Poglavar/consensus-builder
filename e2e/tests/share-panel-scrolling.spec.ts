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
    // On phones the design inspector deliberately owns the map controls; dismiss it before opening
    // the independent Lists sheet used to compose a plan.
    if (width < 768) await page.locator('#click-stack .click-stack__dismiss').click();
    await page.locator('#proposals-button').click();
    await page.locator('#shareAppliedProposalsButton').click();
    // Lists (01268caee): the Plans tab's Create plan sits in the shared #lists-actions row and ticks
    // the designs in Lists → Designs, which scrolls; Continue opens the composer listing all of them.
    await page.locator('#lists-actions').getByRole('button',{name:'Create plan',exact:true}).click();
    const list=page.locator('#proposals-sheet .lists-body'), choices=list.locator('#proposal-list-host input[type=checkbox]');
    await expect(choices).toHaveCount(24);
    await expect.poll(()=>list.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
    await list.hover(); await page.mouse.wheel(0,2500);
    await expect.poll(()=>list.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
    for(const choice of await choices.all())await choice.check();
    await expect(list.locator('.lists-selection-count')).toHaveText('24 selected');
    await list.locator('[data-lists-continue]').click();
    const composer=page.locator('.plan-composer');
    await expect(composer.locator('.plan-dialog__members li')).toHaveCount(24);
    await composer.hover(); await page.mouse.wheel(0,2500);
    await expect(page.locator('.plan-dialog__footer')).toBeInViewport();
  });
}
