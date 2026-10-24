// Purpose: sharing the applied plan from the share panel (plan-design-agreement.md, M2 "Browser"):
// the panel picks on the map (js/map-pick.js, M3), so a click on an applied design finds its row;
// each selected design is published (POST /pins + POST /designs) from its row, the panel links the
// selection as /designs/<cid>,<cid> once all of it is published, and another device applies that link
// once; a parcel layout's row is refused (it is published with its agreement); a link naming a design
// the index does not hold, or something that is not a CID, says so.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { openCity, openParcel, createSpace, chooseProfileName, stubBasemapTiles, openOnAnotherDevice, clickDesignOnMap } from '../helpers/runtime';
import { applyLayout } from '../helpers/agreements';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { cidOfObject, createSharedIndex, pageIndex } from '../helpers/mocks/shared-server';

test.beforeEach(async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
});

// The design-<cid> records applied on this device.
const appliedImports = (page: Page, cids: string[]) => page.evaluate(ids => ids.map(cid => (window as any).proposalStorage.getAllProposals()
  .filter((proposal: any) => proposal.proposalId === `design-${cid}` && (window as any).isApplied(proposal)).length), cids);

// The applied plan share panel lives in the Proposals sheet's Share tab.
async function openSharePanel(page: Page): Promise<void> {
  const sheet = page.locator('#proposals-sheet');
  if (!(await sheet.isVisible())) await page.locator('#proposals-button').click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('tab', { name: 'Share', exact: true }).click();
  await expect(sheet.locator('#designs-share .share-plan-panel--embedded')).toBeVisible();
}

test.describe('Sharing the applied plan @core', () => {
  test('the share panel publishes each selected design and its link applies them once on another device', async ({ mockApi: sender, browser, baseURL }) => {
    test.setTimeout(240_000);
    await openCity(sender);
    await sender.evaluate(() => (window as any).i18n.setLanguage('en'));
    await sender.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(sender.url()).origin });
    await createSpace(sender, 'park');
    const secondParcelId = sampleParcels.features[1].properties.parcelId;
    await sender.evaluate(async (id) => {
      await (window as any).CadastralParcelRepository.ensureIds([id]);
    }, secondParcelId);
    await expect.poll(() => sender.evaluate(id => !!(window as any).ParcelPresenter.getLayer(id), secondParcelId)).toBe(true);
    await openParcel(sender, 'proposals', secondParcelId);
    await sender.locator('.parcel-build-btn--square').click();
    await expect.poll(() => sender.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.structureProposal?.kind === 'square' && proposal.applied))).toBe(true);
    const index = pageIndex(sender);

    // A share link carries its author: a guest chooses a profile name first.
    await openSharePanel(sender);
    await sender.keyboard.press('Escape');
    await expect(sender.locator('#proposals-sheet')).toBeHidden();
    await sender.evaluate(() => (window as any).guestPolicyBlocks('publish'));
    await chooseProfileName(sender, 'Plan author');
    await openSharePanel(sender);
    const sheet = sender.locator('#proposals-sheet');
    const panel = sheet.locator('#designs-share .share-plan-panel--embedded');
    await expect(panel.locator('.share-plan-count')).toHaveText('2 of 2 designs included · 0 excluded');
    const park = panel.locator('.share-plan-row').filter({ hasText: /park/i });
    const square = panel.locator('.share-plan-row').filter({ hasText: /square/i });
    await expect(park).toBeVisible();
    await expect(square).toBeVisible();
    // Both rows are selected and unpublished, so there is no link yet.
    const linkRow = panel.locator('.share-plan-link');
    await expect(linkRow).toBeHidden();
    await expect(panel.locator('.share-plan-status')).toHaveText('Publish at least one design to get a link.');
    // The panel picks on the map through the one pick mode it shares with the agreement editor
    // (js/map-pick.js): a click on an applied design there finds its row.
    await expect(sender.locator('body')).toHaveClass(/\bmap-pick-mode\b/);
    await expect(sender.locator('body')).toHaveAttribute('data-map-pick', 'share');
    await expect(sender.locator('body')).not.toHaveClass(/\bshare-plan-mode\b/);
    expect(await sender.evaluate(() => (window as any).MapPick.active())).toBe('share');
    const parkId = await sender.evaluate(() => String((window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.structureProposal?.kind === 'park').proposalId));
    await clickDesignOnMap(sender, parkId);
    await expect(park).toHaveClass(/\bis-picked\b/);
    await expect(square).not.toHaveClass(/\bis-picked\b/);
    await expect(panel.locator('.share-plan-status')).toHaveText(/^Selected .*park/i);

    await park.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(park.locator('.share-plan-row__published')).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('.share-plan-status')).toHaveText('Publish every selected design to get the link, or deselect some.');
    await square.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(square.locator('.share-plan-row__published')).toBeVisible({ timeout: 30_000 });

    // Two designs pinned and indexed, each under the CID of its object; the link names both, sorted.
    expect(index.requests.filter(request => request.method === 'POST').map(request => request.path))
      .toEqual(['/pins', '/designs', '/pins', '/designs']);
    const rows = [...index.designs.values()];
    expect(rows.map(row => row.goal).sort()).toEqual(['park', 'square']);
    rows.forEach(row => {
      expect(cidOfObject(row.content)).toBe(row.cid);
      expect(row.content.author).toBe('Plan author');
    });
    const cids = rows.map(row => row.cid).sort();
    const link = panel.locator('.share-plan-link__input');
    await expect(linkRow).toBeVisible();
    const fullLink = await link.inputValue();
    await panel.getByRole('button', { name: 'Copy URL', exact: true }).click();
    await expect.poll(() => sender.evaluate(() => navigator.clipboard.readText())).toBe(fullLink);
    expect(new URL(await link.inputValue()).pathname).toBe(`/designs/${cids.join(',')}`);
    expect(new URL(await link.inputValue()).searchParams.has('3d')).toBe(false);

    // Deselecting a row narrows the link to the rest.
    await park.locator('input[type="checkbox"]').uncheck();
    const squareCid = rows.find(row => row.goal === 'square')!.cid;
    await expect(link).toHaveValue(new RegExp(`/designs/${squareCid}\\?`));
    await park.locator('input[type="checkbox"]').check();
    await expect(link).toHaveValue(new RegExp(`/designs/${cids.join(',')}\\?`));

    // Leaving the integrated Share tab closes its sheet and ends map-pick mode.
    await sender.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(sender.locator('body')).not.toHaveClass(/\bmap-pick-mode\b/);
    expect(await sender.evaluate(() => (window as any).MapPick.active())).toBeNull();

    // Another device applies the link's designs once, and again once after a reload.
    const receiver = await openOnAnotherDevice(browser, `/designs/${cids.join(',')}?city=zg&reduceMotion=1`, index, baseURL);
    try {
      await expect.poll(() => appliedImports(receiver.page, cids), { timeout: 90_000 }).toEqual([1, 1]);
      await receiver.page.reload({ waitUntil: 'domcontentloaded' });
      await waitForMapReady(receiver.page);
      await expect.poll(() => appliedImports(receiver.page, cids), { timeout: 90_000 }).toEqual([1, 1]);
      expect(await receiver.page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(2);
      expect(index.requests.filter(request => request.path === '/designs/batch')).toHaveLength(2);
    } finally {
      await receiver.context.close();
    }
  });

  test('a parcel layout is not shared on its own: its row is refused and the panel offers no link', async ({ mockApi: page }) => {
    test.setTimeout(180_000);
    await applyLayout(page);
    await openSharePanel(page);

    const panel = page.locator('#proposals-sheet #designs-share .share-plan-panel--embedded');
    const row = panel.locator('.share-plan-row');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.share-plan-row__refusal')).toHaveText('A parcel layout is published with its agreement. Propose an agreement that includes it.');
    await expect(row.locator('input[type="checkbox"]')).toBeEnabled();
    await expect(row.locator('input[type="checkbox"]')).toBeChecked();
    await expect(row.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await expect(panel.locator('.share-plan-link')).toBeHidden();
    await expect(panel.locator('.share-plan-create-agreement')).toBeVisible();
    expect(pageIndex(page).requests.filter(request => request.method === 'POST')).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#proposals-sheet')).toBeHidden();
  });

  test('a link to a design the index does not hold, or to something that is not a CID, says so', async ({ browser, baseURL }) => {
    test.setTimeout(150_000);
    const index = createSharedIndex();
    const missingCid = cidOfObject({ schema: 'design/v1', goal: 'park', note: 'never published' });
    const missing = await openOnAnotherDevice(browser, `/designs/${missingCid}?city=zg&reduceMotion=1`, index, baseURL);
    try {
      const summary = missing.page.locator('.share-modal-overlay');
      await expect(summary).toContainText('Shared designs', { timeout: 60_000 });
      await expect(summary.locator('.shared-plan-failures li')).toHaveText(`${missingCid} · This design is not on the server.`);
      expect(index.requests.filter(request => request.path === '/designs/batch')).toHaveLength(1);
    } finally {
      await missing.context.close();
    }

    const invalid = await openOnAnotherDevice(browser, '/designs/not-a-design-cid?city=zg&reduceMotion=1', index, baseURL);
    try {
      const summary = invalid.page.locator('.share-modal-overlay');
      await expect(summary).toContainText('Shared designs', { timeout: 60_000 });
      await expect(summary.locator('.shared-plan-failures li')).toHaveText('not-a-design-cid · This is not a design link.');
      // Nothing was asked of the index for it.
      expect(index.requests.filter(request => request.path === '/designs/batch')).toHaveLength(1);
    } finally {
      await invalid.context.close();
    }
  });
});
