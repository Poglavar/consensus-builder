import { selectNativeOption } from '../helpers/controls';
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, openParcel, PARCEL_GEOMETRY, PARCEL_ID, proposalState, showProposal, expandStackSection, runParcelCommand, stackCommand, stackSection } from '../helpers/runtime';

const SOLANA_WALLET = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
const ANCHOR_ACCOUNT = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const AGREEMENT_ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const LENS_MEMBER = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const ATTESTATION = 'F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4';
const AGREEMENT_CID = `bafkrei${'a'.repeat(52)}`;

async function expandProposalDetails(page: import('@playwright/test').Page): Promise<void> {
  const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
}

test.describe('Proposal browsing @features', () => {
  test('local list filters, sorts and switches proposal sources through visible controls', async ({ mockApi: page }) => {
    await openCity(page);
    const ids = await page.evaluate((parcelId) => {
      const w = window as any;
      return [
        w.proposalStorage.addProposal({ title: 'North park plan', goal: 'park', author: 'Ada', createdAt: '2024-01-01T00:00:00Z', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId] }),
        w.proposalStorage.addProposal({ title: 'South park plan', goal: 'park', author: 'Bea', createdAt: '2025-01-01T00:00:00Z', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId] }),
        w.proposalStorage.addProposal({ title: 'Road safety plan', goal: 'road-track', author: 'Ada', createdAt: '2023-01-01T00:00:00Z', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId] }),
      ];
    }, PARCEL_ID);

    // Lists (01268caee): one Source and filters section above the Designs rows; search stays out,
    // publication and order fold behind Filters; removal asks before dropping the browser copy.
    await page.locator('#proposals-button').click();
    const list = page.locator('#proposals-sheet');
    const rows = list.locator('#proposal-list-host .lists-item');
    const titles = rows.locator('.lists-item__title');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toBeInViewport();
    const order = list.locator('select[data-list-filter="sort"]');
    await expect(order).toBeHidden();
    await list.locator('.lists-filter-details > summary').click();
    await expect(order).toBeVisible();
    await list.getByRole('searchbox').fill('North');
    await expect(titles).toHaveText(['North park plan']);
    // Search also matches the author.
    await list.getByRole('searchbox').fill('Ada');
    await expect(titles).toHaveText(['North park plan', 'Road safety plan']);

    await list.getByRole('searchbox').fill('');
    await expect(titles).toHaveText(['North park plan', 'Road safety plan', 'South park plan']);
    await selectNativeOption(order, 'newest');
    await expect(titles).toHaveText(['South park plan', 'North park plan', 'Road safety plan']);

    // Designs come from this device or from the server's index; none are read from a chain (M3).
    await expect(list.locator('[data-list-source]')).toHaveCount(2);
    await list.locator('[data-list-source="published"]').click();
    await expect(list.locator('[data-list-source="published"]')).toHaveAttribute('aria-pressed', 'true');
    // Restore local source before removing; removal is offered only for locally held records.
    await list.locator('[data-list-source="local"]').click();
    await expect(rows).toHaveCount(3);
    const target = list.locator(`#proposal-list-host .lists-item[data-list-id="${ids[2]}"]`);
    await target.getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await page.locator('.cb-dialog').getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await expect.poll(() => page.evaluate(id => (window as any).getProposalByIdOrHash(id) == null, ids[2])).toBe(true);
    await expect(rows).toHaveCount(2);
  });

  test('Duplicate on the details starts placement and cancellation leaves the source unchanged', async ({ mockApi: page }) => {
    await openCity(page);
    const sourceId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
      title: 'Original park', goal: 'park', cadastreParcelIds: [parcelId], site: geometry,
      geometry, structureProposal: { kind: 'park', geometry },
    }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    const before = await proposalState(page, sourceId);
    await showProposal(page, sourceId);
    await page.locator('.btn-duplicate-design').click();
    await expect(page.locator('#design-duplicate-editor .on-map-editor__panel')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await proposalState(page, sourceId)).toEqual(before);
  });

  test('a parcel\'s History row loads the agreements over it, its ownership attestations and the executed agreement', async ({ mockApi: page }) => {
    await page.route(`**/parcels/${encodeURIComponent(PARCEL_ID)}/history`, route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        parcelUid: PARCEL_ID,
        anchor: { account: ANCHOR_ACCOUNT, exists: null, source: 'unavailable' },
        events: [
          { type: 'agreement_published', at: '2026-08-10T08:00:00Z', agreementCid: AGREEMENT_CID, title: 'Block 1234 readjustment',
            link: `/agreements/${AGREEMENT_CID}` },
          { type: 'parcel_ownership', at: '2026-08-10T08:06:00Z', attestation: ATTESTATION, member: LENS_MEMBER, owner: SOLANA_WALLET,
            ownerCount: 1, hash: `sha256:${'ab'.repeat(32)}`, link: `https://explorer.solana.com/address/${ATTESTATION}?cluster=devnet` },
          { type: 'agreement_executed', at: '2026-08-11T09:00:00Z', outcome: 'executed', agreementCid: AGREEMENT_CID, account: AGREEMENT_ACCOUNT,
            lens: LENS_MEMBER, transaction: 'tx-executed', link: 'https://explorer.solana.com/tx/tx-executed?cluster=devnet' },
        ],
      }),
    }));
    await openCity(page);
    await openParcel(page);
    // The parcel's Info tab ends with its History, read when the row is opened.
    const history = page.locator(`#parcel-history-section details[data-parcel-history="${PARCEL_ID}"]`);
    await expect(history).toBeVisible();
    await history.locator('summary').click();
    const events = history.locator('.parcel-history-event');
    await expect(events).toHaveCount(3);
    expect(await events.evaluateAll(items => items.map(item => item.getAttribute('data-history-type'))))
      .toEqual(['agreement_published', 'parcel_ownership', 'agreement_executed']);
    // The agreement proposed over the parcel, named by its title and CID, its link resolved on the API.
    const published = history.locator('[data-history-type="agreement_published"]');
    await expect(published).toContainText('Agreement proposed');
    await expect(published).toContainText('Block 1234 readjustment');
    await expect(published).toContainText(`Agreement ${AGREEMENT_CID.slice(0, 4)}…${AGREEMENT_CID.slice(-4)}`);
    await expect(published.locator('time')).toHaveAttribute('datetime', '2026-08-10T08:00:00Z');
    const backend = await page.evaluate(() => String((window as any).getBackendBase()).replace(/\/+$/, ''));
    await expect(published.getByRole('link', { name: 'View' })).toHaveAttribute('href', `${backend}/agreements/${AGREEMENT_CID}`);
    // The lens member's ownership attestation: who attested whom, and its account hash.
    const ownership = history.locator('[data-history-type="parcel_ownership"]');
    await expect(ownership).toContainText('Ownership attested');
    await expect(ownership).toContainText(`Member ${LENS_MEMBER.slice(0, 4)}…${LENS_MEMBER.slice(-4)}`);
    await expect(ownership).toContainText(`Owner ${SOLANA_WALLET.slice(0, 4)}…${SOLANA_WALLET.slice(-4)}`);
    await expect(ownership).toContainText('1 attested owner(s)');
    await expect(ownership.locator('.parcel-history-hash')).toHaveAttribute('title', `sha256:${'ab'.repeat(32)}`);
    await expect(ownership.getByRole('link', { name: 'View' })).toHaveAttribute('href', /\/address\/.+cluster=devnet/);
    // The executed agreement names the lens that attested its decision and links its transaction.
    const executed = history.locator('[data-history-type="agreement_executed"]');
    await expect(executed).toContainText('Agreement executed');
    await expect(executed).toContainText(`Lens: ${LENS_MEMBER.slice(0, 4)}…${LENS_MEMBER.slice(-4)}`);
    await expect(executed.getByRole('link', { name: 'View' })).toHaveAttribute('href', 'https://explorer.solana.com/tx/tx-executed?cluster=devnet');
    await expect(history.locator('.parcel-history-anchor')).toContainText('Parcel anchor status unavailable');
    await expect(history.locator('.parcel-history-anchor')).not.toContainText('No parcel anchor found');
  });

  test('stacked proposals open the visible side-by-side parcel comparison', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(({ parcelId, geometry }) => {
      const w = window as any;
      w.proposalStorage.addProposal({ title: 'Compare park plan', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], geometry, applied: true });
      w.proposalStorage.addProposal({ title: 'Compare square plan', goal: 'square', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], geometry, applied: true });
      w.updateProposalLayer();
    }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await clickMapPoint(page, 15.9822, 45.80025);

    // The design header counts peers; the parcel section links to each related design.
    const designs = stackSection(page, 'designs');
    await expect(designs.locator('.click-stack__row-title')).toHaveText('Design (2)');
    await expandStackSection(page, 'parcels');
    const relatedDesigns = stackSection(page, 'parcels').locator('.click-stack__choices[data-kind="designs"]');
    await expect(relatedDesigns.locator('.click-stack__chip')).toHaveCount(2);
    const compare = stackCommand(page, 'parcel.compare');
    await expect(compare).toBeVisible();
    await compare.click();
    const comparison = page.locator('#parcel-compare-dialog');
    await expect(comparison).toBeVisible();
    // The comparison is a modal of its own: the stack steps aside.
    await expect(page.locator('#click-stack')).toBeHidden();
    await expect(comparison).toContainText('Compare park plan');
    await expect(comparison).toContainText('Compare square plan');
    await comparison.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(comparison).toBeHidden();
    await runParcelCommand(page, 15.9822, 45.80025, 'parcel.compare');
    await expect(comparison).toBeVisible();
    const selectedId = await comparison.locator('.parcel-compare__picker--a select').inputValue();
    await comparison.locator('.parcel-compare__picker--a .parcel-compare__details').click();
    await expect(comparison).toBeHidden();
    await showProposal(page, selectedId);
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(selectedId);
  });
});
