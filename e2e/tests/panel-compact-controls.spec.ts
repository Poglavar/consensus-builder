// Verify compact panel actions remain reachable and open their intended UI.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: '320px mobile', width: 320, height: 780 },
] as const;

async function addLocalProposal(page: import('@playwright/test').Page, key: string): Promise<string> {
  return page.evaluate(({ parcelId, geometry, key }) => {
    const proposalId = `e2e-panel-controls-${key}`;
    return (window as any).proposalStorage.addProposal({
      proposalId,
      title: `Panel control ${key}`,
      description: 'A local proposal for exercising the details panel controls.',
      author: 'E2E author',
      goal: 'park',
      lifecycleStatus: 'Active',
      applied: false,
      cadastreParcelIds: [parcelId],
      geometry,
      structureProposal: { kind: 'park', geometry, applied: false },
    });
  }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY, key });
}

async function openProposalFromList(page: import('@playwright/test').Page, proposalId: string): Promise<void> {
  await page.locator('#proposals-button').click();
  const list = page.locator('#proposals-sheet .proposal-list-modal');
  const row = list.locator(`.proposal-list-item[data-proposal-id="${proposalId}"]`);
  await expect(row).toBeVisible();
  await row.locator('.proposal-list-details-btn').click();
  await expect(page.locator('#proposal-details-panel')).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`parcel info panel minimizes, restores and closes on ${viewport.name} @features`, async ({ mockApi: page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCity(page);
    await openParcel(page);

    const panel = page.locator('#parcel-info-panel');
    const toggle = panel.locator('#parcel-info-minimize');
    const body = panel.locator('.panel-body');
    const tabs = panel.locator('.parcel-tabs');
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await panel.locator('.parcel-title-id').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(PARCEL_ID);
    if (viewport.width < 768) {
      const resize = panel.locator('.mobile-dock-sheet-handle');
      const originalHeight = await panel.evaluate(element => element.getBoundingClientRect().height);
      await resize.click();
      await resize.press('ArrowUp');
      await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(originalHeight);
      await resize.press('ArrowDown');
      await expect.poll(() => panel.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(Math.round(originalHeight));
    }
    await toggle.click();
    await expect(panel).toHaveClass(/is-minimized/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(body).toBeHidden();
    await expect(tabs).toBeHidden();

    await toggle.click();
    await expect(panel).not.toHaveClass(/is-minimized/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(body).toBeVisible();
    await expect(tabs).toBeVisible();

    await panel.locator('.close-button').click();
    await expect(panel).toBeHidden();
  });

  test(`proposal details close control dismisses the real list-opened panel on ${viewport.name} @features`, async ({ mockApi: page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCity(page);
    const proposalId = await addLocalProposal(page, viewport.name.replace(/\W+/g, '-'));
    await openProposalFromList(page, proposalId);

    const panel = page.locator('#proposal-details-panel');
    const close = panel.locator('#proposal-details-close');
    await expect(close).toBeVisible();
    await close.click();
    await expect(panel).toBeHidden();
  });
}
