// Purpose: the land-readjustment layout editor works without hunting for a tool. Handles are on as
// soon as it opens; grabbing a boundary segment moves it (and turns the automatic layout into a drawn
// one); undo gives the automatic layout back and redo replays the edit; switching to Draw freely keeps
// the plots and owners that were on the map.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID } from '../helpers/runtime';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ mockApi: page }) => {
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>',
  }));
});

async function openReadjustment(page: Page) {
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--reparcellization').click();
  const modal = page.locator('.on-map-reparcellization');
  await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
  await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
  return modal;
}

// Rows of the New plots list: "1 123 m² Owner A …".
async function plotRows(page: Page): Promise<string[]> {
  return page.locator('.reparcel-newplots-list tbody tr').evaluateAll(rows => rows
    .map(row => (row as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
}

const algorithm = (page: Page) => page.locator('input[name="reparcel-algorithm"]:checked').inputValue();

// A point 30% along the first draggable boundary segment, in page coordinates: not its midpoint,
// where the insert handle sits.
async function segmentPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.locator('path.geom-handle-edge').first().evaluate(element => {
    const path = element as unknown as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() * 0.3);
    const matrix = path.getScreenCTM()!;
    return { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f };
  });
}

test('a boundary segment drags straight away, undo and redo walk it back and forth, Draw freely keeps the plots', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  const modal = await openReadjustment(page);
  expect(await algorithm(page)).toBe('sweep-line');
  // The handles are the editor: on from the start, with grabbable segments between plots.
  await expect(modal.locator('[data-reparcel-nodes]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('path.geom-handle-edge').first()).toBeAttached();
  await expect(page.locator('.reparcel-plot-number').first()).toBeVisible();
  const automatic = await plotRows(page);
  expect(automatic.length).toBeGreaterThanOrEqual(2);

  const start = await segmentPoint(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(start.x + step * 4, start.y);
  await page.mouse.up();

  await expect.poll(() => plotRows(page)).not.toEqual(automatic);
  const dragged = await plotRows(page);
  expect(dragged).toHaveLength(automatic.length);
  // Editing the automatic split turned it into a drawn layout with the same owners.
  expect(await algorithm(page)).toBe('manual');
  expect(dragged.map(row => row.replace(/^\d+ [\d.,]+ m² /, ''))).toEqual(automatic.map(row => row.replace(/^\d+ [\d.,]+ m² /, '')));

  await page.mouse.move(5, 400);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => plotRows(page)).toEqual(automatic);
  expect(await algorithm(page)).toBe('sweep-line');
  await expect(modal.locator('[data-reparcel-redo-edit]')).toBeEnabled();

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => plotRows(page)).toEqual(dragged);
  expect(await algorithm(page)).toBe('manual');

  // Back to the automatic split, then Draw freely: the plots and owners come along.
  await modal.locator('.reparcel-alg-option', { hasText: 'Automatic' }).click();
  await expect.poll(() => plotRows(page)).toEqual(automatic);
  await modal.locator('.reparcel-alg-option', { hasText: 'Draw freely' }).click();
  await expect.poll(() => algorithm(page)).toBe('manual');
  expect(await plotRows(page)).toEqual(automatic);
  await expect(modal.locator('[data-reparcel-status]')).toContainText('Drawing freely from the current layout');
});

test('a click on a boundary offers to erase it, and Delete removes a node from its popup', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  const modal = await openReadjustment(page);
  const before = await plotRows(page);

  const point = await segmentPoint(page);
  await page.mouse.click(point.x, point.y);
  const popup = page.locator('.leaflet-popup .reparcel-node-popup');
  await expect(popup).toContainText('Boundary between plot 1');
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  // Escape closed only the popup, not the editor.
  await expect(modal.locator('.on-map-editor__panel')).toBeVisible();

  await page.mouse.click(point.x, point.y);
  await popup.getByRole('button', { name: 'Erase this boundary' }).click();
  await expect.poll(async () => (await plotRows(page)).length).toBe(before.length - 1);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => plotRows(page)).toEqual(before);

  // A node popup: Delete removes the node, which straightens or dissolves its boundary.
  const node = page.locator('.reparcel-node-handle').first();
  await node.click();
  await expect(popup).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(popup).toHaveCount(0);
  await expect.poll(() => plotRows(page)).not.toEqual(before);
});

// Ownership and approval is part of designing the readjustment: set up in the designer, it is on
// the proposal Done creates, with no replacement proposal afterwards.
test('ownership and approval set up in the designer lands on the created proposal', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  const modal = await openReadjustment(page);
  const row = modal.locator('[data-reparcel-approval]');
  await expect(row).toContainText('Not set up yet');
  await row.locator('[data-reparcel-approval-setup]').click();
  const dialog = page.locator('.approval-setup-dialog');
  await expect(dialog).toBeVisible();
  const rights = {
    schema: 'parcel-rights/v1',
    source: { provider: 'upload', reference: 'e2e-register' },
    parcels: [{ parcelId: PARCEL_ID, complete: true, owners: [{ ownerId: 'owner-a', share: '1/2' }, { ownerId: 'owner-b', share: '1/2' }] }]
  };
  await dialog.locator('[data-approval-file]').setInputFiles({ name: 'rights.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(rights)) });
  await dialog.locator('[data-editor-action="approval-import"]').click();
  await expect(dialog.locator('.proposal-editor-approval-status')).toContainText('Ownership data is complete');
  await dialog.locator('[data-approval-policy-type]').selectOption('threshold');
  await dialog.locator('[data-approval-fraction="area"]').fill('7/1x');
  await dialog.locator('[data-approval-lens]').fill('e2e-lens-member');
  // A malformed fraction is reported without losing what was typed.
  await dialog.locator('[data-action-id="apply"]').click();
  await expect(dialog.locator('[data-approval-apply-error]')).toContainText('fraction');
  await expect(dialog.locator('[data-approval-lens]')).toHaveValue('e2e-lens-member');
  await dialog.locator('[data-approval-fraction="area"]').fill('7/10');
  await dialog.locator('[data-action-id="apply"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText('Rights for 1 parcel(s), 2 owner(s)');
  await expect(row).toContainText('area 7/10');
  // The owners now come from the rights file.
  await expect.poll(async () => (await plotRows(page)).join(' ')).toMatch(/Owner A.*Owner B|Owner B.*Owner A/);

  const before = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length);
  await modal.locator('[data-reparcel-commit]').click();
  await expect(modal).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(before + 1);
  const created = await page.evaluate(() => {
    const all = (window as any).proposalStorage.getAllProposals();
    const p = all[all.length - 1];
    return { rights: p.approvalConfig?.rights?.parcels?.length, policy: p.approvalConfig?.policy?.type, area: p.approvalConfig?.policy?.area,
      lens: (p.lens || []).map((entry: any) => (typeof entry === 'string' ? entry : entry.address)) };
  });
  expect(created).toEqual({ rights: 1, policy: 'threshold', area: { numerator: 7, denominator: 10, strict: false }, lens: ['e2e-lens-member'] });
});
