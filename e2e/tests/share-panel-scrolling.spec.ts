import { test, expect } from '../helpers/fixtures';
import { chooseProfileName, createSpace, openCity } from '../helpers/runtime';

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
    await composer.getByLabel('Plan name', { exact: true }).fill(`Long shared plan ${width}`);
    await composer.getByRole('button', { name: 'Create plan', exact: true }).click();
    await page.locator('#click-stack .click-stack__section[data-kind="plans"]')
      .getByRole('button', { name: 'Share plan', exact: true }).click();
    const share = page.locator('.plan-share');
    const members = share.locator('.plan-share__members');
    await expect(members.locator('li')).toHaveCount(24);
    await expect.poll(() => members.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await members.focus();
    await page.keyboard.press('PageDown');
    await expect.poll(() => members.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect(share.getByRole('button', { name: 'Publish and copy link', exact: true })).toBeInViewport();
    const publish = share.getByRole('button', { name: 'Publish and copy link', exact: true });
    await publish.click();
    const profile = page.locator('#welcome-modal'), name = profile.locator('#username-input');
    await expect(name).toBeFocused();
    await expect.poll(() => name.evaluate(el => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
    })).toBe(true);
    await page.keyboard.press('Escape');
    await expect(profile).toBeHidden();
    await expect(share).toBeVisible();
    await expect(publish).toBeFocused();
    await publish.click();
    await chooseProfileName(page, 'Long plan author');
    await expect(share).toBeVisible();
    if (width < 768) {
      await share.getByRole('button', { name: 'Publish and copy link', exact: true }).click();
      await expect(share.getByLabel('Plan link', { exact: true })).toBeInViewport();
      await expect(share.getByRole('button', { name: 'Copy link', exact: true })).toBeInViewport();
      await expect(share.locator('.share-panel__actions')).toBeInViewport();
    }
  });
}
