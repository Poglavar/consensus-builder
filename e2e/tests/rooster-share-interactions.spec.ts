import { openPlanCritics, openPlanActions } from '../helpers/plan-actions';
import { test, expect } from '../helpers/fixtures';
import { applyLayout } from '../helpers/agreements';
import { openCity, createSpace, showProposal, stubBasemapTiles } from '../helpers/runtime';

test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });

test('the plan critic picker works by keyboard and shows two disabled portraits at phone width', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCity(page);
  await createSpace(page, 'park');
  await page.keyboard.press('Escape');
  const row = await openPlanActions(page);
  const picker = row.locator('.lists-critics');
  const summary = picker.locator('summary');
  const rooster = picker.getByRole('button', { name: 'Urban rooster Parcel grain', exact: true });

  await expect(rooster).toBeHidden();
  await summary.focus();
  await summary.press('Enter');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(rooster).toBeFocused();
  await page.evaluate(() => (window as any).ListsPanel.refresh());
  await expect(rooster).toBeFocused();
  const choices = picker.getByRole('button');
  await expect(choices).toHaveCount(7);
  await expect(picker.getByRole('button', { name: 'Cat Square enclosure', exact: true })).toBeEnabled();
  await expect(picker.getByRole('button', { name: 'Beaver Independent phases', exact: true })).toBeEnabled();
  await expect(picker.getByRole('button', { name: 'Dog Walkability', exact: true })).toBeEnabled();
  await expect(picker.getByRole('button', { name: 'Hare Cycling', exact: true })).toBeEnabled();
  for (const label of ['Owl Approval path', 'Crow Street frontage']) {
    const choice = picker.getByRole('button', { name: label, exact: true });
    await expect(choice).toBeDisabled();
    await expect(choice.locator('img')).toHaveCSS('filter', 'grayscale(1)');
  }
  await expect.poll(() => choices.locator('img').evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(await picker.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await summary.press('Space');
  await expect(rooster).toBeHidden();
});

test('the rooster touches each inspected parcel with its beak and highlights only that parcel', async ({ mockApi: page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { layoutId } = await applyLayout(page); await showProposal(page, layoutId);
  await page.evaluate(() => {
    const w:any=window, original=Element.prototype.animate; w.__pecks=0;
    Element.prototype.animate=function(frames:any,options:any){const animation=original.call(this,frames,options);if(this.matches('.grain-rooster__body')&&frames[1]?.transform?.includes('rotate(-35deg)')){animation.pause();animation.currentTime=options.duration*frames[1].offset;w.__pecks++;let release:any;const finished=new Promise(resolve=>release=resolve);w.__releasePeck=()=>{animation.cancel();release();};return{finished,cancel:()=>animation.cancel()}as any;}return animation;};
  });
  await page.locator('#proposals-button').click();
  const picker = await openPlanCritics(page);
  const rooster = picker.getByRole('button', { name: 'Urban rooster Parcel grain', exact: true });
  await rooster.click();
  for(let index=1;index<=2;index++){await expect.poll(()=>page.evaluate(()=>(window as any).__pecks)).toBe(index);const sample=await page.evaluate(()=>{const w:any=window,active=document.querySelector('.grain-score-parcel.is-active')as SVGPathElement,beak=document.querySelector('[data-grain-role="beak"]')as SVGPathElement;const contact=new DOMPoint(28,79).matrixTransform(beak.getScreenCTM()!);return{active:document.querySelectorAll('.grain-score-parcel.is-active').length,inside:active.isPointInFill(contact.matrixTransform(active.getScreenCTM()!.inverse())),selectedProposal:w.currentlyHighlightedProposalId};});expect(sample).toEqual({active:1,inside:true,selectedProposal:null});await page.evaluate(()=>(window as any).__releasePeck());}
  await expect(page.locator('#grain-score-panel [data-grain-role="result"]')).toBeVisible({timeout:15000});
  await expect(page.locator('#grain-score-panel [data-grain-role="eyebrow"]')).toHaveText('Institute for Urban Grain');
  // The rooster scores the plan as applied on the map: with a member unapplied it asks to apply the
  // plan first, and Cancel leaves the map and the rooster as they were.
  await page.locator('#grain-score-panel').getByRole('button', { name: 'Close grain score', exact: true }).click();
  await expect(picker).toBeVisible();
  await expect(rooster).toBeFocused();
  await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), layoutId);
  await rooster.click();
  const ask = page.locator('.cb-dialog--confirm');
  await expect(ask).toContainText('The designs of this plan are not on your map.');
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.locator('#grain-score-panel')).toBeHidden();
  expect(await page.evaluate(id => (window as any).isApplied((window as any).proposalStorage.getProposal(id)), layoutId)).toBe(false);
});

test('the Rooster returns to the selected plan’s analysis tab on every close', async ({ mockApi: page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { layoutId } = await applyLayout(page);
  const row = await openPlanActions(page, 'Grain return plan', [layoutId]);
  await row.getByRole('button', { name: /^Open / }).click();
  const stack = page.locator('#click-stack');
  const tab = stack.getByRole('tab', { name: 'Stats & analysis' });
  await tab.press('Enter');
  const rooster = stack.getByRole('button', { name: 'Urban rooster Parcel grain', exact: true });
  for (const dismiss of ['button', 'escape']) {
    await rooster.press('Enter');
    const panel = page.locator('#grain-score-panel');
    await expect(panel.locator('[data-grain-role="result"]')).toBeVisible();
    if (dismiss === 'escape') await page.keyboard.press('Escape');
    else await panel.getByRole('button', { name: 'Close grain score' }).click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(rooster).toBeFocused();
    await expect(panel).toBeHidden();
  }
});

test('composing a plan selects membership independently of map focus', async ({ mockApi: page }) => {
  await openCity(page); const first=await createSpace(page,'park');
  await page.evaluate(id=>(window as any).ProposalManager.unapplyProposal(id),first);
  await createSpace(page,'square');
  const focused=await page.evaluate(()=>(window as any).currentlyHighlightedProposalId);
  await page.locator('#proposals-button').click(); await page.locator('#shareAppliedProposalsButton').click();
  // Create plan ticks the designs in Lists → Designs. Ticked designs are previewed on the map, so the
  // map may frame them (the old map-centre check is obsolete); the map's selected design stays put.
  await page.locator('#lists-actions').getByRole('button',{name:'Create plan',exact:true}).click();
  const choices=page.locator('#proposal-list-host input[type=checkbox]');
  await expect(choices).toHaveCount(2);await choices.first().check();await choices.nth(1).uncheck();
  expect(await page.evaluate(()=>(window as any).currentlyHighlightedProposalId)).toBe(focused);
  await expect(page.locator('#lists-actions .lists-selection-count')).toHaveText('1 selected');
  await page.locator('#lists-actions [data-lists-continue]').click();
  const form=page.locator('.plan-composer');
  await expect(form.locator('.plan-dialog__members li')).toHaveCount(1);
  await expect(form.locator('.plan-dialog__count')).toHaveText('1 selected');
});
