import { openLayerSection } from '../helpers/layers';
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal, clickMapPoint, PARCEL_ID, proposalState, closeParcel } from '../helpers/runtime';
import { Page } from '@playwright/test';

// The original-cadastre toggle moved from the lower-left mode strip into the 2D Layers sheet
// (fbe3758d); the sheet is closed again so the map underneath takes the clicks.
async function toggleCadastreView(page: Page, pressed: boolean) {
  await openLayerSection(page, 'parcels');
  const toggle = page.locator('#layers-sheet #cadastre-view-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', String(pressed));
  await page.locator('#layers-sheet [data-sheet-close]').click();
  await expect(page.locator('#layers-sheet')).toBeHidden();
}

test('consumed ground remains reachable through design parcel tabs and the cadastral map', async ({ mockApi: page }) => {
  await openCity(page);
  const original = await page.evaluate(id => JSON.stringify((window as any).CadastralParcelRepository.get(id)), PARCEL_ID);
  const id = await createSpace(page, 'park');
  const proposal = await proposalState(page, id);
  await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), PARCEL_ID)).toBe(false);
  await showProposal(page, id);
  const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.locator('#click-stack [data-page="relation-parcels"]').click();
  const row = page.locator('#click-stack .click-stack__choices[data-kind="parcels"] .click-stack__link');
  const parcel = row.locator('.click-stack__chip');
  await expect(parcel).toBeVisible();
  await parcel.click();
  await expect(parcel).toHaveAttribute('aria-pressed', 'true');
  await row.locator('.click-stack__open').click();
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
  await expect(page.locator('#parcel-info-title')).toContainText('1234');
  await expect(page.locator('#proposal-details-panel')).toBeHidden();
  // The consumed cadastral parcel has no proposal tab: its current design is shown as a
  // contextual relationship in the click stack. The stack shows the parcel and the level next to it
  // (its formed piece); the design two levels up is a "Designs on this parcel" link in the parcel's
  // card (docs/click-stack.md, "Rows, relationships and expansion").
  const designs = page.locator('#click-stack .click-stack__section[data-kind="parcels"] .click-stack__chip[data-action="preview"][data-kind="designs"]');
  await page.locator('#click-stack [data-page="relation-designs"]').click();
  await expect(designs).toContainText(/park/i);
  await closeParcel(page);
  await toggleCadastreView(page, true);
  await expect(page.locator('body')).toHaveClass(/cadastre-view/);
  const paths = () => page.evaluate(() => (window as any).map.getPane('cadastreViewPane').querySelectorAll('path').length);
  await expect.poll(paths).toBeGreaterThan(0);
  await clickMapPoint(page, 15.9822, 45.80025);
  await page.locator('#click-stack [data-page="parcel-info-tab"]').click();
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
  await expect(page.locator('#parcel-info-title')).toContainText('1234');
  await closeParcel(page);
  await toggleCadastreView(page, false);
  await expect(page.locator('body')).not.toHaveClass(/cadastre-view/);
  await expect.poll(paths).toBe(0);
  expect(await page.evaluate(id => JSON.stringify((window as any).CadastralParcelRepository.get(id)), PARCEL_ID)).toBe(original);
  const after = await proposalState(page, id);
  expect(after).toMatchObject({
    proposalId: proposal.proposalId,
    applied: proposal.applied,
    cadastreParcelIds: proposal.cadastreParcelIds,
    structureProposal: proposal.structureProposal,
  });
  // Reading parcels must preserve authored geometry and rights exactly.
  for (const key of ['declaredRights', 'geometry', 'site', 'binding']) {
    expect(after[key]).toEqual(proposal[key]);
  }
});
