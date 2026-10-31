// Exercise app-shell buttons and verify navigation and dialog state.
import { test, expect } from '../helpers/fixtures';
import { openCity, clickMapPoint, createSpace, showProposalTab } from '../helpers/runtime';
import { installAreaMonitorSpaFallback } from '../helpers/mocks/area-monitor-server';

test('The keyboard shortcut opens the command palette', async ({ mockApi: page }) => {
  await openCity(page);
  await page.keyboard.press('Control+k');
  await expect(page.locator('.command-palette-backdrop')).toBeVisible();
  await page.locator('.command-palette__input').fill('Measure');
  await page.locator('.command-palette__item').filter({ hasText: /Measure/ }).first().click();
  await expect(page.locator('.command-palette-backdrop')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).measureMode)).toBe(true);
  await clickMapPoint(page, 15.9820, 45.8001);
  await clickMapPoint(page, 15.9824, 45.8001);
  await expect(page.locator('.measurement-label')).toHaveCount(1);
  expect(parseFloat(await page.locator('.measurement-label').innerText())).toBeGreaterThan(25);
});

test('watched-area Undo and Cancel edit and discard the actual drawn vertices', async ({ mockApi: page }) => {
  await openCity(page);
  await page.locator('#activity-button').click();
  await page.locator('#activity-watched-tab').click();
  await page.locator('#areaMonitorDrawButton').click();
  await expect(page.locator('#area-monitor-drawing-toolbar')).toBeVisible();
  await clickMapPoint(page, 15.98195, 45.8001);
  await clickMapPoint(page, 15.9824, 45.8001);
  const vertices = () => page.evaluate(() => (window as any).AreaMonitorDraw.getVertices().length);
  await expect.poll(vertices).toBe(2);
  await page.locator('#area-monitor-drawing-undo').click();
  await expect.poll(vertices).toBe(1);
  await page.locator('#area-monitor-drawing-cancel').click();
  await expect.poll(vertices).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as any).AreaMonitorDraw.isActive())).toBe(false);
  await expect(page.locator('#area-monitor-drawing-toolbar')).toBeHidden();
  await expect(page.locator('#area-monitor-creation-panel')).toHaveCount(0);
});

test('Cancel on a completed watched area discards the unsaved monitor', async ({ mockApi: page }) => {
  let creates = 0;
  await page.route('**/area-monitors**', route => {
    if (route.request().method() === 'POST') creates++;
    return route.fallback();
  });
  await openCity(page);
  await page.locator('#activity-button').click();
  await page.locator('#activity-watched-tab').click();
  await page.locator('#areaMonitorDrawButton').click();
  for (const [lng, lat] of [[15.98195, 45.8001], [15.98245, 45.8001], [15.98245, 45.8004], [15.98195, 45.8001]]) {
    await clickMapPoint(page, lng, lat);
  }
  await expect(page.locator('#area-monitor-creation-panel')).toBeVisible();
  await page.locator('#am-name').fill('Discarded watch area');
  await page.locator('#am-cancel').click();
  await expect(page.locator('#area-monitor-creation-panel')).toHaveCount(0);
  expect(creates).toBe(0);
  await expect(page.locator('body')).not.toHaveClass(/area-monitor-creation-active/);
});

test('a watched area copies its route and opens and closes the other-area list', async ({ mockApi: page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await installAreaMonitorSpaFallback(page);
  await page.goto('/monitors/1?city=zg', { waitUntil: 'domcontentloaded' });
  const panel = page.locator('#area-monitor-detail-panel');
  await expect(panel).toBeVisible();
  await panel.locator('#am-share').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(new URL('/monitors/1', page.url()).href);
  await panel.locator('#am-list-others').click();
  const list = page.locator('#area-monitor-list-modal');
  await expect(list).toBeVisible();
  await expect(list).toContainText('Vukovarska Corridor');
  await list.locator('#am-list-close').click();
  await expect(list).toHaveCount(0);
  await expect(panel).toBeVisible();
});

test('the expanded technical status buttons copy the log and follow a proposal entry', async ({ mockApi: page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCity(page);
  const proposalId = await createSpace(page, 'park');
  const proposalTitle = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.title, proposalId);
  // Seed a real status record using the same boundary used by background proposal events.
  await page.evaluate(id => (window as any).updateStatus('Button coverage park event', { proposalId: id }), proposalId);
  await page.locator('#settings-button').click();
  // Diagnostics sits inside the Advanced accordion.
  await page.locator('#settings-sheet details[data-section="advanced"] > summary').click();
  const technical = page.locator('#settings-sheet section[data-section="diagnostics"]');
  await technical.locator('.status-bar').click();
  await expect(technical.locator('#status-log-expanded')).toBeVisible();
  await technical.locator('[data-status-copy-all]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Button coverage park event');
  await technical.locator('[data-status-open-log]').click();
  const dialog = page.locator('#status-log-modal');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Button coverage park event', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(proposalId);
  await showProposalTab(page, 'overview');
  await expect(page.locator('#click-stack').getByRole('region', { name: proposalTitle, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection?.getKey?.())).toBe(proposalId);
});
