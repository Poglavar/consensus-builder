// Purpose: a design's published lineage is one CID link. A design forked from a published one says
// "Forked from <short CID>", linking to /designs/<cid>; a design of its own has no such line, and the
// details panel lists no forks or counterproposals (plan-design-agreement.md, simplification 8).
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID, showProposal } from '../helpers/runtime';
import { cidOfObject } from '../helpers/mocks/shared-server';
import type { Page } from '@playwright/test';

const square = [[[15.9819, 45.8], [15.9821, 45.8], [15.9821, 45.8005], [15.9819, 45.8005], [15.9819, 45.8]]];

async function seed(page: Page, record: Record<string, unknown>): Promise<string> {
  return page.evaluate(({ record, parcel, coordinates }) => (window as any).proposalStorage.addProposal({
    goal: 'park', lifecycleStatus: 'Active',
    lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Active', reason: 'no-matching-observation' },
    cadastreParcelIds: [parcel], acceptedParcelIds: [],
    geometry: { type: 'Polygon', coordinates }, ...record
  }), { record, parcel: PARCEL_ID, coordinates: square });
}

test('a fork of a published design links it by CID, and nothing else is listed as lineage', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  const source = cidOfObject({ schema: 'design/v1', title: 'Published original' });
  const fork = await seed(page, { proposalId: 'p-lineage-fork', title: 'Fork of a published design', origin: { cid: source } });
  const own = await seed(page, { proposalId: 'p-lineage-own', title: 'A design of its own' });

  const panel = page.locator('#proposal-details-panel');
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  await showProposal(page, fork);
  if (await expand.isVisible()) await expand.click();
  const forkedFrom = panel.locator(`[data-proposal-forked-from="${source}"] a`);
  await expect(forkedFrom).toHaveText(`Forked from ${source.slice(0, 12)}…${source.slice(-6)}`);
  await expect(forkedFrom).toHaveAttribute('title', source);
  // The published design's own link, in the city the fork belongs to.
  await expect(forkedFrom).toHaveAttribute('href', `/designs/${source}?city=zg`);
  await expect(panel.locator('[data-proposal-lineage]')).toHaveCount(0);

  await showProposal(page, own);
  if (await expand.isVisible()) await expand.click();
  await expect(panel).toContainText('A design of its own');
  await expect(panel.locator('[data-proposal-forked-from]')).toHaveCount(0);
});
