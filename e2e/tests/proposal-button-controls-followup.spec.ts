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
    expect(posts.map(request => request.path)).toEqual(['/pins', '/designs', '/pins', '/designs', '/pins', '/designs']);
    const published = await page.evaluate(ids => ids.map(id => {
      const w = window as any;
      const proposal = w.proposalStorage.getProposal(id);
      return { mark: proposal?.published?.cid || null, current: w.DesignSync.publishedCid(proposal) };
    }), proposalIds);
    expect(published.every(entry => !!entry.mark && entry.mark === entry.current)).toBe(true);
    expect(new Set(published.map(entry => entry.mark))).toEqual(new Set(index.designs.keys()));
  });

  test('click stack strips switch the cadastral parcel and the design, then the stack closes', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await page.evaluate(async parcelId => {
      await (window as any).CadastralParcelRepository.ensureIds([parcelId]);
    }, SECOND_PARCEL_ID);
    await page.evaluate(({ parcelIds, geometry }) => {
      const storage = (window as any).proposalStorage;
      // Both proposals stand on both base parcels, so the click stack lists two designs and the
      // two cadastral parcels under them, each as a strip of chips.
      const footprint = {
        type: 'MultiPolygon',
        coordinates: [geometry.coordinates, (window as any).CadastralParcelRepository.get(parcelIds[1]).geometry.coordinates],
      };
      for (const [index, goal] of ['park', 'square'].entries()) {
        storage.addProposal({
          proposalId: `drill-stack-${index}`,
          title: `Drill stack ${goal}`,
          goal,
          lifecycleStatus: 'Active',
          applied: true,
          cadastreParcelIds: parcelIds,
          geometry: footprint,
          structureProposal: { kind: goal, geometry: footprint, applied: true },
        });
      }
      (window as any).updateProposalLayer();
    }, { parcelIds: [PARCEL_ID, SECOND_PARCEL_ID], geometry: PARCEL_GEOMETRY });
    await clickMapPoint(page, 15.9822, 45.80025);

    const stack = page.locator('#click-stack');
    await expect(stack).toBeVisible();
    const parcels = stack.locator('.click-stack__section[data-kind="parcels"]');
    const parcelChips = parcels.locator('.click-stack__chip');
    await expect(parcelChips).toHaveCount(2);
    await expect(parcelChips.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await parcelChips.nth(1).click();
    await expect(parcelChips.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(parcels.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    await expect(parcels.locator('#parcel-info-panel')).toBeVisible();
    await expect(page.locator('#parcel-info-title')).toContainText(SECOND_PARCEL_ID);

    // The designs' strip: choosing the other design expands the designs section on it.
    const designs = stack.locator('.click-stack__section[data-kind="designs"]');
    await expect(designs.locator('.click-stack__row-title')).toHaveText('Designs (2)');
    const other = designs.locator('.click-stack__chip[aria-pressed="false"]');
    const otherId = await other.getAttribute('data-id');
    await other.click();
    await expect(designs.locator(`.click-stack__chip[data-id="${otherId}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(designs.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    await expect(parcels.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'false');
    await stack.locator('.click-stack__close').click();
    await expect(stack).toBeHidden();
  });
});
