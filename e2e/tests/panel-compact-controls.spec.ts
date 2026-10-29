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
  // Lists (01268caee): a design row's title opens its details.
  const list = page.locator('#proposals-sheet #proposal-list-host');
  const row = list.locator(`.lists-item[data-list-id="${proposalId}"]`);
  await expect(row).toBeVisible();
  await row.locator('.lists-item__open').click();
  await expect(page.locator('#proposal-details-panel')).toBeVisible();
}

async function expectCompactBounds(page: import('@playwright/test').Page, width: number, height: number): Promise<void> {
  const stack = page.locator('#click-stack');
  if (!(await stack.isVisible())) return;
  const box = await stack.boundingBox();
  expect(box, '#click-stack has a visible bounding box').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height);

  const horizontalOverflow = await stack.evaluate(element => [element, ...element.querySelectorAll('.is-hosted')]
    .map(hosted => ({ scrollWidth: hosted.scrollWidth, clientWidth: hosted.clientWidth })));
  for (const hosted of horizontalOverflow) {
    expect(hosted.scrollWidth).toBeLessThanOrEqual(hosted.clientWidth + 1);
  }
}

for (const viewport of VIEWPORTS) {
  test(`parcel section collapses with its selection retained and Escape closes it on ${viewport.name} @features`, async ({ mockApi: page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCity(page);
    await openParcel(page);

    const panel = page.locator('#parcel-info-panel');
    await expect(panel).toBeVisible();
    // In the stack the section row folds and the stack's × closes: the panel's own − and × are hidden.
    await expect(panel.locator('#parcel-info-minimize')).toBeHidden();
    await expect(panel.locator('.panel-header .close-button')).toBeHidden();
    // The parcel row remains the readable selection caption; it has no section copy action.
    const row = page.locator('#click-stack .click-stack__section[data-kind=parcels] .click-stack__row');
    await expect(row.locator('.click-stack__row-detail')).toHaveText(PARCEL_ID);
    await expect(row.locator('.click-stack__copy-reference')).toHaveCount(0);
    await expectCompactBounds(page, viewport.width, viewport.height);
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#click-stack')).toBeVisible();
    await expect(page.locator('#click-stack .click-stack__section[data-kind=parcels]')).toHaveClass(/is-selected/);
    await expect(row.locator('.click-stack__row-detail')).toHaveText(PARCEL_ID);
    await page.locator('#map').focus();
    await expect(page.locator('#map')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#click-stack')).toBeHidden();
    await expect(panel).toBeHidden();
    // The phone sheet owns its translucent surface; hiding it also hides its resize handle.
    await expect(page.locator('#click-stack')).toHaveCSS('background-color', viewport.width < 768 ? 'rgba(255, 255, 255, 0.8)' : 'rgba(0, 0, 0, 0)');
    const handle = page.locator('#click-stack > .mobile-dock-sheet-handle');
    await expect(handle).toBeHidden();
  });

  test(`Escape dismisses the list-opened proposal details panel on ${viewport.name} @features`, async ({ mockApi: page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCity(page);
    const proposalId = await addLocalProposal(page, viewport.name.replace(/\W+/g, '-'));
    await openProposalFromList(page, proposalId);

    const details = page.locator('#proposal-details-panel');
    await expect(details).toContainText(`Panel control ${viewport.name.replace(/\W+/g, '-')}`);
    await expectCompactBounds(page, viewport.width, viewport.height);
    const row = page.locator('#click-stack .click-stack__section[data-kind=designs] .click-stack__row');
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#click-stack')).toBeHidden();
    await expect(details).toBeHidden();
  });
}
