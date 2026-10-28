// Station categories use existing placement, and observed source records have one inspection host.
import {test, expect} from '../helpers/fixtures';
import {openCity, openParcel} from '../helpers/runtime';

for (const width of [1280, 390]) {
  test(`track-station level chooser cancels cleanly at ${width}px`, async ({mockApi: page}, testInfo) => {
    test.setTimeout(90000);
    await page.setViewportSize({width, height:844});
    await openCity(page);
    await openParcel(page, 'proposals');
    const launcher=page.locator('#parcel-info-panel .parcel-transport-btn--trackStation');
    await launcher.click();
    const dialog=page.getByRole('dialog',{name:'Track station',exact:true});
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-station-level]')).toHaveCount(3);
    await expect(dialog.getByRole('button',{name:'Ground level',exact:true})).toBeVisible();
    await expect(dialog.getByRole('button',{name:'Elevated station',exact:true})).toBeVisible();
    await expect(dialog.getByRole('button',{name:'Underground',exact:true})).toBeVisible();
    const icons=await dialog.locator('[data-station-level] i').evaluateAll(elements=>elements.map(element=>getComputedStyle(element).maskImage));
    expect(new Set(icons).size).toBe(3);
    expect(icons.every(icon=>icon.includes('station-')&&icon.endsWith('.svg")'))).toBe(true);
    expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`station-levels-${width}.png`)});
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(()=>(window as any).isTransitStationPlacementActive())).toBe(false);
    await launcher.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(()=>(window as any).isTransitStationPlacementActive())).toBe(false);
    expect(await page.evaluate(()=>(window as any).proposalStorage.getAllProposals().length)).toBe(0);
  });
}

test('observed building inspection stays inside Built and never revives a standalone panel', async ({mockApi: page})=>{
  test.setTimeout(90000);
  await openCity(page);
  await page.waitForFunction(()=>(window as any).PlanningViews?.isReady());
  const inspect=()=>page.evaluate(()=>{
    const w=window as any;
    const feature=w.turf.polygon([[[15.9821,45.8001],[15.9823,45.8001],[15.9823,45.8003],[15.9821,45.8003],[15.9821,45.8001]]],
      {object_id:'inspection-fixture',name:'Observed fixture',height_m:12});
    w.PlanningViews.inspectBuilding(feature,'inspection-fixture');
  });
  await inspect();
  const stack=page.locator('#click-stack');
  const built=stack.locator('.click-stack__section[data-kind="built"]');
  await expect(built).toHaveClass(/is-expanded/);
  await expect(built.locator('.click-stack__row-detail')).toHaveText('Observed fixture');
  await expect(built.locator('#planning-inspector.is-hosted')).toBeVisible();
  await expect(page.locator('#planning-inspector')).toHaveCount(1);
  await built.locator('.click-stack__row').click();
  await expect(page.locator('#planning-inspector')).toBeHidden();
  await page.evaluate(()=>window.dispatchEvent(new Event('i18n:translationsLoaded')));
  await expect(page.locator('#planning-inspector')).toBeHidden();
  await inspect();
  await expect(built.locator('#planning-inspector.is-hosted')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stack).toBeHidden();
  await page.evaluate(()=>window.dispatchEvent(new Event('i18n:translationsLoaded')));
  await expect(page.locator('#planning-inspector')).toBeHidden();
});
