// The build-out timeline in 2D: a plan's construction schedule, edited in its schedule dialog,
// drives the map's time control; planned designs are veiled, designs under construction hatched
// with a crane, and ?when= / ?timeline= reopen the same moment (docs/buildout-timeline.md).
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { drawCorridor, openCity, openParcel, stubBasemapTiles } from '../helpers/runtime';

async function scheduledPlan(page: Page): Promise<{ plan: string; park: string; road: string }> {
  await stubBasemapTiles(page);
  await openCity(page);
  const road = await drawCorridor(page, 'road');
  // The park stands on another parcel than the one the road crosses.
  await openParcel(page, 'proposals', 'HR-335754-1236');
  await page.locator('.parcel-build-btn--park').click();
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.structureProposal?.kind === 'park' && p.applied))).toBe(true);
  const park = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.structureProposal?.kind === 'park').proposalId);
  return page.evaluate(async ({ park, road }) => {
    const w = window as any;
    const records = [w.proposalStorage.getProposal(park), w.proposalStorage.getProposal(road)];
    const cid = (record: any) => w.DesignRecord.cidOf(record);
    const row = w.PlanComposition.create('Phased block', records, w.MapShare.capture(w), {
      [cid(records[0])]: { start: '2027-01', end: '2027-04' },
      [cid(records[1])]: { start: '2027-05', end: '2027-08' },
    });
    w.PlanWorkspace.save(row);
    await w.ClickStack.showPlan(row, { designs: w.PlanComposition.localRecords(row, { apiBase: w.DesignSync.apiBase() }), draft: true });
    return { plan: row.cid, park: String(park), road: String(road) };
  }, { park, road });
}

const shapes = (page: Page, phase: 'planned' | 'construction') => page.locator(`.leaflet-pane.buildout-pane path.buildout-shape--${phase}`);

test.describe('Build-out timeline @features', () => {
  test('the time control steps a scheduled plan through planned, under construction and built', async ({ mockApi: page }, testInfo) => {
    const { plan } = await scheduledPlan(page);
    const button = page.locator('#buildout-clock-button');
    await expect(button).toBeVisible();
    await button.click();
    const clock = page.locator('#buildout-clock');
    await expect(clock).toBeVisible();
    await expect(page.locator('#buildout-clock-title')).toHaveText('Phased block');
    // January 2027: the park is under construction (a quarter done), the road not started.
    await expect.poll(() => page.evaluate(() => (window as any).BuildoutClock.month())).toBe('2027-01');
    await expect(shapes(page, 'construction')).toHaveCount(1);
    await expect(shapes(page, 'planned')).toHaveCount(1);
    await expect(page.locator('.buildout-crane-marker')).toHaveCount(1);
    await expect(page.locator('#buildout-clock-summary')).toHaveText('1 under construction, 1 not started');
    await page.screenshot({ path: testInfo.outputPath('buildout-2027-01.png') });
    expect(new URL(page.url()).searchParams.get('when')).toBe('2027-01');
    expect(new URL(page.url()).searchParams.get('timeline')).toBe(plan);

    // May: the park is built, the road under construction.
    for (let i = 0; i < 4; i += 1) await page.locator('#buildout-clock-forward').click();
    await expect.poll(() => page.evaluate(() => (window as any).BuildoutClock.month())).toBe('2027-05');
    await expect(shapes(page, 'construction')).toHaveCount(1);
    await expect(shapes(page, 'planned')).toHaveCount(0);
    await expect(page.locator('#buildout-clock-summary')).toHaveText('1 under construction, 0 not started');

    // The slider's end is the last month: everything built.
    await page.locator('#buildout-clock-slider').focus();
    await page.keyboard.press('End');
    await expect.poll(() => page.evaluate(() => (window as any).BuildoutClock.month())).toBe('2027-08');
    await page.locator('#buildout-clock-forward').click();
    await expect.poll(() => page.evaluate(() => (window as any).BuildoutClock.month())).toBe('2027-08');
    await page.locator('#buildout-clock-slider').focus();
    await page.keyboard.press('Home');
    await page.locator('#buildout-clock-back').click();
    await expect.poll(() => page.evaluate(() => (window as any).BuildoutClock.month())).toBe('2027-01');

    // Back to now: nothing veiled, the address forgets the moment, and nothing was unapplied.
    await page.locator('#buildout-clock-close').click();
    await expect(clock).toBeHidden();
    await expect(page.locator('.leaflet-pane.buildout-pane path')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('when')).toBe(false);
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().every((p: any) => p.applied))).toBe(true);
  });

  test('a link with ?when= and ?timeline= reopens the plan at that month', async ({ mockApi: page }) => {
    const { plan } = await scheduledPlan(page);
    const url = new URL(page.url());
    url.searchParams.set('when', '2027-06');
    url.searchParams.set('timeline', plan);
    await page.goto(url.href);
    await expect(page.locator('#buildout-clock')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (window as any).BuildoutClock.month())).toBe('2027-06');
    await expect(page.locator('#buildout-clock-month')).toHaveText('June 2027');
    await expect(shapes(page, 'construction')).toHaveCount(1);
  });

  test('a simulated build-out dates the undated members repeatably and is never saved', async ({ mockApi: page }) => {
    const { plan, road } = await scheduledPlan(page);
    // A revision without the road's dates: the simulation has the road to date.
    const base = await page.evaluate(async ({ plan, road }) => {
      const w = window as any, row = w.PlanWorkspace.list().find((r: any) => r.cid === plan);
      const roadCid = w.DesignRecord.cidOf(w.proposalStorage.getProposal(road));
      const schedule = { ...row.content.schedule }; delete schedule[roadCid];
      const next = w.PlanComposition.withSchedule(row, schedule); w.PlanWorkspace.save(next);
      await w.ClickStack.showPlan(next, { designs: w.PlanComposition.localRecords(next, { apiBase: w.DesignSync.apiBase() }), draft: true });
      return { cid: next.cid, roadCid, planCount: w.PlanWorkspace.list().length };
    }, { plan, road });
    // Undated: the road is named under the strip and counted as built on the time control.
    await expect(page.locator('.click-stack__schedule .plan-schedule__undated-item')).toHaveText([/Road/]);
    await page.locator('#buildout-clock-button').click();
    await expect(page.locator('#buildout-clock-summary')).toHaveText('1 under construction, 0 not started, 1 without dates (shown as built)');
    await expect(shapes(page, 'planned')).toHaveCount(0);
    await page.locator('#buildout-clock-close').click();
    await page.evaluate(cid => (window as any).PlanDialog.schedule((window as any).PlanWorkspace.list().find((row: any) => row.cid === cid)), base.cid);
    await expect(page.locator('.plan-dialog .plan-schedule__undated-item')).toHaveText([/Road/]);
    await page.locator('.plan-dialog').getByRole('button', { name: 'Simulate build-out' }).click();
    const clock = page.locator('#buildout-clock');
    await expect(clock).toHaveClass(/buildout-clock--simulated/);
    await expect(clock.locator('.buildout-clock__badge')).toBeVisible();
    await expect(page.locator('#buildout-clock-title')).toHaveText('Simulated build-out');
    const first = await page.evaluate(roadCid => {
      const p = (window as any).BuildoutClock.plan();
      return { seed: p.seed, road: p.content.schedule[roadCid], simulated: p.simulated };
    }, base.roadCid);
    expect(first.simulated).toBe(true);
    expect(first.road.start >= await page.evaluate(() => (window as any).BuildoutSchedule.currentMonth())).toBe(true);
    expect(new URL(page.url()).searchParams.get('buildout')).toBe(first.seed);
    // A link with the seed reopens the same scenario at the same month.
    const link = page.url();
    expect(new URL(link).searchParams.get('timeline')).toBe(base.cid);
    await page.goto(link);
    await expect(page.locator('#buildout-clock')).toHaveClass(/buildout-clock--simulated/, { timeout: 30_000 });
    expect(await page.evaluate(roadCid => (window as any).BuildoutClock.plan().content.schedule[roadCid], base.roadCid)).toEqual(first.road);
    // Nothing was stored: the same plans, the same revision.
    expect(await page.evaluate(() => (window as any).PlanWorkspace.list().length)).toBe(base.planCount);
    // The same seed gives the same dates; another seed (the dice) gives a new scenario.
    await page.evaluate(({ cid, seed }) => (window as any).BuildoutClock.simulate((window as any).PlanWorkspace.list().find((r: any) => r.cid === cid), { seed }), { cid: base.cid, seed: first.seed });
    expect(await page.evaluate(roadCid => (window as any).BuildoutClock.plan().content.schedule[roadCid], base.roadCid)).toEqual(first.road);
    await page.locator('#buildout-clock-reroll').click();
    await expect.poll(() => page.evaluate(() => (window as any).BuildoutClock.plan().seed)).not.toBe(first.seed);
    // Back to now ends the simulation; the plan's own dates stay in view.
    await page.locator('#buildout-clock-close').click();
    await expect(clock).toBeHidden();
    expect(await page.evaluate(() => { const p = (window as any).BuildoutClock.plan(); return { simulated: !!p?.simulated, cid: p?.cid }; })).toEqual({ simulated: false, cid: base.cid });
    expect(new URL(page.url()).searchParams.has('buildout')).toBe(false);
    await expect(page.locator('#buildout-clock-button')).toBeVisible();
  });

  test('the time control and the schedule dialog fit a phone screen', async ({ mockApi: page }, testInfo) => {
    // The designs are drawn at desktop size; the phone layout is what is checked.
    const { plan } = await scheduledPlan(page);
    await page.setViewportSize({ width: 390, height: 780 });
    await page.evaluate(() => (window as any).ClickStack.close());
    await page.locator('#buildout-clock-button').click();
    const clock = page.locator('#buildout-clock');
    await expect(clock).toBeVisible();
    const box = await clock.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath('buildout-phone-clock.png') });
    await page.locator('#buildout-clock-close').click();
    await page.evaluate(plan => (window as any).PlanDialog.schedule((window as any).PlanWorkspace.list().find((row: any) => row.cid === plan)), plan);
    await expect(page.locator('.plan-schedule__row')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath('buildout-phone-dialog.png') });
  });

  test('the schedule dialog saves construction windows as a new plan revision', async ({ mockApi: page }) => {
    const { plan, road } = await scheduledPlan(page);
    await page.evaluate(plan => (window as any).PlanDialog.schedule((window as any).PlanWorkspace.list().find((row: any) => row.cid === plan)), plan);
    const dialog = page.locator('.plan-dialog');
    await expect(dialog.locator('.plan-schedule__row')).toHaveCount(2);
    await expect(dialog.locator('.plan-schedule__bar')).toHaveCount(2);
    const save = dialog.getByRole('button', { name: 'Save schedule' });
    await expect(save).toBeDisabled();
    const roadCid = await page.evaluate(id => (window as any).DesignRecord.cidOf((window as any).proposalStorage.getProposal(id)), road);
    const roadRow = dialog.locator('.plan-schedule__row').filter({ has: page.locator(`[aria-label^="${await page.evaluate(id => (window as any).proposalStorage.getProposal(id).title, road)}"]`) });
    // A reversed window is refused; a valid one saves.
    await roadRow.locator('input[type="month"]').nth(0).fill('2028-03');
    await roadRow.locator('input[type="month"]').nth(1).fill('2028-01');
    await expect(dialog.locator('.plan-dialog__status')).toContainText('no later than its end');
    await expect(save).toBeDisabled();
    await roadRow.locator('input[type="month"]').nth(1).fill('2028-09');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dialog).toHaveCount(0);
    const saved = await page.evaluate(({ plan, roadCid }) => {
      const rows = (window as any).PlanWorkspace.list();
      const next = rows.find((row: any) => row.cid !== plan && row.content.title === 'Phased block');
      return { window: next?.content.schedule?.[roadCid], clockPlan: (window as any).BuildoutClock.plan()?.cid, cid: next?.cid };
    }, { plan, roadCid });
    expect(saved.window).toEqual({ start: '2028-03', end: '2028-09' });
    expect(saved.clockPlan).toBe(saved.cid);
    // The click stack's plan section carries the schedule strip.
    await expect(page.locator('.click-stack__schedule .plan-schedule__bar')).toHaveCount(2);
  });
});
