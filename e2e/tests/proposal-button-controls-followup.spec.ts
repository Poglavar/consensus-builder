// Verify the walk gate's publish actions and the click stack's instance strips.
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { pageIndex } from '../helpers/mocks/shared-server';

const SECOND_PARCEL_ID = sampleParcels.features[1].properties.parcelId;

async function establishLocalProfile(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Proposal follow-up tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

test.describe('proposal button controls follow-up @features', () => {
  test('walk gate publishes one row, then Publish all publishes the rest and closes', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const proposalIds = await page.evaluate(({ parcelId, geometry }) => {
      const storage = (window as any).proposalStorage;
      return [1, 2, 3].map(index => storage.addProposal({
        proposalId: `walk-upload-${index}`,
        title: `Walk upload ${index}`,
        goal: 'park',
        lifecycleStatus: 'Active',
        applied: true,
        cadastreParcelIds: [parcelId],
        geometry,
        structureProposal: { kind: 'park', geometry, applied: true },
      }));
    }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    const index = pageIndex(page);

    await page.evaluate(() => (window as any).showWalkUploadGateModal({}));

    const modal = page.locator('.share-modal-overlay');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Publish before walking');
    const rowPublish = modal.locator('.walk-upload-gate__row').getByRole('button', { name: 'Publish', exact: true });
    await expect(rowPublish).toHaveCount(3);
    await rowPublish.first().click();
    await expect(modal.getByRole('button', { name: 'Published', exact: true })).toHaveCount(1);
    await expect.poll(() => index.designs.size).toBe(1);
    await modal.getByRole('button', { name: 'Publish all', exact: true }).click();
    await expect(modal).toBeHidden({ timeout: 30000 });
    await expect.poll(() => index.designs.size).toBe(3);
    expect([...index.designs.values()].map(row => row.title).sort()).toEqual([
      'Walk upload 1', 'Walk upload 2', 'Walk upload 3',
    ]);
    // Each row went to the courier, then the index, under its own CID; each local design now hashes
    // to the CID it is published as.
    const posts = index.requests.filter(request => request.method === 'POST');
    expect(posts.map(request => request.path)).toEqual(['/designs', '/designs', '/designs']);
    const published = await page.evaluate(ids => ids.map(id => {
      const w = window as any;
      const proposal = w.proposalStorage.getProposal(id);
      return { mark: proposal?.published?.cid || null, current: w.DesignSync.publishedCid(proposal) };
    }), proposalIds);
    expect(published.every(entry => !!entry.mark && entry.mark === entry.current)).toBe(true);
    expect(new Set(published.map(entry => entry.mark))).toEqual(new Set(index.designs.keys()));
  });

  test('click stack context navigates design to source parcel and back to a related design', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await page.evaluate(async parcelId => {
      await (window as any).CadastralParcelRepository.ensureIds([parcelId]);
    }, SECOND_PARCEL_ID);
    const proposalIds = await page.evaluate(({ parcelIds, geometry }) => {
      const storage = (window as any).proposalStorage;
      // Both proposals stand on both base parcels, making the source/child relationships selectable.
      const footprint = {
        type: 'MultiPolygon',
        coordinates: [geometry.coordinates, (window as any).CadastralParcelRepository.get(parcelIds[1]).geometry.coordinates],
      };
      const ids = ['park', 'square'].map((goal, index) => storage.addProposal({
        proposalId: `drill-stack-${index}`,
        title: `Drill stack ${goal}`,
        goal,
        lifecycleStatus: 'Active',
        applied: true,
        cadastreParcelIds: parcelIds,
        geometry: footprint,
        structureProposal: { kind: goal, geometry: footprint, applied: true },
      }));
      (window as any).updateProposalLayer();
      return ids;
    }, { parcelIds: [PARCEL_ID, SECOND_PARCEL_ID], geometry: PARCEL_GEOMETRY });
    await clickMapPoint(page, 15.9822, 45.80025);

    const stack = page.locator('#click-stack');
    await expect(stack).toBeVisible();
    const designs = stack.locator('.click-stack__section[data-kind="designs"]');
    await expect(designs).toHaveClass(/is-selected/);
    await expect(designs.locator('.click-stack__row-title')).toHaveText('Design (2)');
    const sourceParcels = designs.locator('.click-stack__choices[data-kind="parcels"]');
    await expect(sourceParcels.locator('.click-stack__chip')).toHaveCount(2);
    // A related item only outlines its object: the design stays selected and the item shows pressed.
    const secondParcel = sourceParcels.locator(`.click-stack__chip[data-id="${SECOND_PARCEL_ID}"]`);
    await secondParcel.click();
    await expect(secondParcel).toHaveAttribute('aria-pressed', 'true');
    await expect(designs).toHaveClass(/is-selected/);
    // Its open button goes to the parcel.
    await sourceParcels.locator(`.click-stack__open[data-id="${SECOND_PARCEL_ID}"]`).click();

    const parcels = stack.locator('.click-stack__section[data-kind="parcels"]');
    await expect(parcels).toHaveClass(/is-selected/);
    await expect(parcels.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#parcel-info-panel')).toBeVisible();
    await expect(page.locator('#parcel-info-title')).toContainText(SECOND_PARCEL_ID);
    await expect(page.locator('path.click-stack-map-focus').first()).toBeVisible();
    // The selected source parcel offers its related designs inside its section.
    const relatedDesigns = parcels.locator('.click-stack__choices[data-kind="designs"]');
    await expect(relatedDesigns.locator('.click-stack__chip')).toHaveCount(2);
    await relatedDesigns.locator(`.click-stack__open[data-id="${proposalIds[0]}"]`).click();

    await expect(designs).toHaveClass(/is-selected/);
    await expect(designs.locator('.click-stack__row-title')).toHaveText('Design (2)');
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    await expect(page.locator('#proposal-details-panel')).toContainText('Drill stack park');
    await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(proposalIds[0]);
    // The source-to-design strip is gone from the collapsed parcel section after selecting its child.
    await expect(parcels.locator('.click-stack__choices[data-kind="designs"]')).toHaveCount(0);
    // The selected design has no sibling-design strip; its source-parcel context remains below it.
    await expect(designs.locator('.click-stack__choices[data-kind="designs"]')).toHaveCount(0);
    await expect(designs.locator('.click-stack__choices[data-kind="parcels"] .click-stack__chip')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(stack).toBeHidden();
  });
});
