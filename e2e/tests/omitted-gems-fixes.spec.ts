// Exercise the owner labels, plural messages and title conversion through the running app.
import { expect } from '@playwright/test';
import { test } from '../helpers/fixtures';
import { waitForMapReady, waitForParcelsLoaded } from '../helpers/app';

test.beforeEach(async ({ mockApi: page }) => {
  await page.goto('/?city=zg&at=45.8002,15.9822,19&lang=en&reduceMotion=1');
  await waitForMapReady(page);
  await waitForParcelsLoaded(page);
});

test('owner types and building counts use the live browser modules', async ({ mockApi: page }) => {
  const result = await page.evaluate(() => {
    const w = window as any;
    return {
      company: w.ParcelsOwnershipUi.getOwnershipType({ name: 'Example', ownerType: 'company' }),
      government: w.ParcelsOwnershipUi.getOwnershipType({ name: 'Example', ownerType: 'government' }),
      authority: w.ParcelsOwnershipUi.getOwnershipType({ name: 'NEW YORK CITY HOUSING AUTHORITY' }),
      one: w.i18n.t('proposalDrafts.design.buildingSummary', { count: 1, typology: 'Block' }),
      two: w.i18n.t('proposalDrafts.design.buildingSummary', { count: 2, typology: 'Block' })
    };
  });
  expect(result).toEqual({ company: 'company', government: 'government', authority: 'government',
    one: '1 building · Block', two: '2 buildings · Block' });
});

for (const origin of ['generated', 'user'] as const) {
  test(`${origin} title is handled when a Block converts to Freeform`, async ({ mockApi: page }) => {
    await page.evaluate(titleOrigin => {
      const w = window as any;
      const shape = { type: 'Feature', properties: { height: 15, massing: true }, geometry: {
        type: 'Polygon', coordinates: [[[15.98205,45.80015],[15.98215,45.80015],
          [15.98215,45.80025],[15.98205,45.80025],[15.98205,45.80015]]]
      } };
      const user = w.getCurrentUserAgent?.();
      w.proposalStorage.addProposal({ proposalId: 'conversion-title-check', city: 'zagreb',
        goal: 'buildings', typologyType: 'block', title: 'My courtyard', titleOrigin,
        description: 'Keep this description.', authorAgentId: user?.id, author: user?.name,
        applied: false, cadastreParcelIds: ['HR-335754-1234'],
        geometry: { buildings: [shape], ruleMassing: shape },
        buildingProposal: { typologyType: 'block', parameters: { mode: 'parametric',
          typology: 'block', rule: { kind: 'max', maxHeightM: 15 } } }
      });
      w.showProposalInfo(w.proposalStorage.getProposal('conversion-title-check'));
    }, origin);
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    const convert = page.getByRole('button', { name: 'Convert to freeform building', exact: true });
    await expect(convert).toBeVisible();
    await convert.click();
    await page.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getProposal('conversion-title-check')?.goal)).toBe('single');
    const stored = await page.evaluate(() => {
      const record = (window as any).proposalStorage.getProposal('conversion-title-check');
      return { title: record.title, origin: record.titleOrigin, description: record.description };
    });
    expect(stored.origin).toBe(origin);
    expect(stored.description).toBe('Keep this description.');
    if (origin === 'user') expect(stored.title).toBe('My courtyard');
    else {
      expect(stored.title).not.toBe('My courtyard');
      expect(stored.title).toMatch(/Single building|Freeform/i);
    }
  });
}
