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
  await expect(page.locator('#planning-inspector')).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`parcel info panel in the stack copies its id, resizes on phones and closes with the stack on ${viewport.name} @features`, async ({ mockApi: page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCity(page);
    await openParcel(page);

    const panel = page.locator('#parcel-info-panel');
    await expect(panel).toBeVisible();
    // In the stack the section row folds and the stack's × closes: the panel's own − and × are hidden.
    await expect(panel.locator('#parcel-info-minimize')).toBeHidden();
    await expect(panel.locator('.panel-header .close-button')).toBeHidden();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await panel.locator('.parcel-title-id').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(PARCEL_ID);
    if (viewport.width < 768) {
      // The parcel panel is hosted in the click stack's parcel section; the stack is the sheet that resizes.
      const sheet = page.locator('#click-stack');
      const resize = sheet.locator(':scope > .mobile-dock-sheet-handle');
      const originalHeight = await sheet.evaluate(element => element.getBoundingClientRect().height);
      await resize.click();
      await resize.press('ArrowUp');
      await expect.poll(() => sheet.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(originalHeight);
      await resize.press('ArrowDown');
      await expect.poll(() => sheet.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(Math.round(originalHeight));
    }
    await page.locator('#click-stack .click-stack__close').click();
    await expect(page.locator('#click-stack')).toBeHidden();
    await expect(panel).toBeHidden();
  });

  test(`proposal details close control dismisses the real list-opened panel on ${viewport.name} @features`, async ({ mockApi: page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCity(page);
    const proposalId = await addLocalProposal(page, viewport.name.replace(/\W+/g, '-'));
    await openProposalFromList(page, proposalId);

    const inspector = page.locator('#planning-inspector');
    await expect(inspector).toContainText(`Panel control ${viewport.name.replace(/\W+/g, '-')}`);
    await inspector.locator('.planning-inspector__header .close-circle-btn').click();
    await expect(inspector).toBeHidden();
  });
}
