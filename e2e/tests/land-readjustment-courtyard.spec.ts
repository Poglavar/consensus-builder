// Exercises shared-courtyard readjustment through the current parcel-selection and proposal flows.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, showProposal } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Basemap availability must not delay the window.load hook that starts proposal replay.
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>',
  }));
});

const ids = ['HR-335754-1234', 'HR-335754-1235'];
const ring = (west: number, south: number, east: number, north: number) =>
  [[west, south], [east, south], [east, north], [west, north], [west, south]];
const outer = ring(15.9819, 45.8, 15.9825, 45.8005);
const inner = ring(15.98205, 45.80015, 15.9824, 45.80035).reverse();
const parcels = {
  type: 'FeatureCollection', features: ids.map((id, index) => ({
    type: 'Feature',
    properties: {
      ...sampleParcels.features[0].properties, parcelId: id, parcel_id: id, id,
      parcel_number: String(1234 + index), BROJ_CESTICE: String(1234 + index),
      owners: [{ name: index ? 'Courtyard Owner B' : 'Courtyard Owner A', share: '1/1' }],
      ownershipDetails: { owners: [{ name: index ? 'Courtyard Owner B' : 'Courtyard Owner A', percentageShare: 100, actualShareText: '100%' }] },
    },
    geometry: { type: 'Polygon', coordinates: [index
      ? ring(15.9823, 45.8, 15.9825, 45.8005)
      : ring(15.9819, 45.8, 15.9823, 45.8005)] },
  })),
};

async function openCourtyard(page: Page, enclosed = true) {
  await page.route('**/parcels**', route => {
    const request = route.request();
    if (!['fetch', 'xhr'].includes(request.resourceType())) return route.fallback();
    if (/\/ownership(?:\?|$)/.test(request.url())) {
      const parcel = parcels.features.find(feature => request.url().includes(feature.properties.parcelId));
      return route.fulfill({ json: { possessionSheets: [{ possessors: (parcel?.properties.owners || []).map(owner => ({ name: owner.name, ownership: owner.share })) }] } });
    }
    return route.fulfill({ json: parcels });
  });
  await openCity(page);
  await page.evaluate(async inputIds => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    await w.CadastralParcelRepository.ensureIds(inputIds);
    w.map.setView([45.80025, 15.9822], 19, { animate: false });
  }, ids);
  await expect.poll(() => page.evaluate(inputIds => inputIds.every(id => !!(window as any).LiveParcelFabric.get(id)), ids)).toBe(true);
  // Seed an authored, unapplied building, the documented input boundary for derivation.
  await page.evaluate(({ inputIds, outerRing, innerRing, hasCourtyard }) => {
    const w = window as any;
    w.proposalStorage.addProposal({
      title: 'Courtyard source block', goal: 'buildings', primaryType: 'Building',
      cadastreParcelIds: inputIds, applied: false,
      buildingProposal: { parameters: { mode: 'block' } },
      geometry: { blockMassing: { type: 'Feature', properties: {}, geometry: {
        type: 'Polygon', coordinates: hasCourtyard ? [outerRing, innerRing] : [outerRing],
      } } },
    });
  }, { inputIds: ids, outerRing: outer, innerRing: inner, hasCourtyard: enclosed });
  await openParcel(page);
  await page.locator('#multiSelectCheckboxInfo').check();
  await page.locator('#parcel-info-panel .close-button').click();
  await clickMapPoint(page, 15.9824, 45.80025);
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort())).toEqual(ids);
  await page.locator('#selection-tray [data-command="selection.propose"]').click();
  await expect(page.locator('.parcel-build-palette')).toBeVisible();
  await page.locator('.parcel-build-btn--reparcellization').click();
  const modal = page.locator('.reparcel-modal-overlay');
  await expect(modal).toBeVisible();
  await modal.locator('label.reparcel-alg-option:has(input[value="amend"])').click();
  await expect(modal.locator('input[value="amend"]')).toBeChecked();
  await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(2);
  return modal;
}

async function finishCourtyard(page: Page, mode: 'single' | 'individual') {
  const modal = page.locator('.reparcel-modal-overlay');
  if (mode === 'individual') {
    const rowFor = (name: string) => modal.locator('[data-reparcel-owners-table] tr').filter({ hasText: name });
    await rowFor('Owner A').locator('.cash-offer-input').fill('200');
    await rowFor('Owner B').locator('.cash-offer-input').fill('100');
    await expect(modal.locator('[data-reparcel-cashtotal]')).toContainText('300');
  }
  await modal.locator('[data-reparcel-commit]').click();
  await expect(modal).toBeHidden();
  await expect.poll(async () => (await appliedPlans(page)).length).toBe(1);
  if (mode === 'single') return;
  const [source] = await appliedPlans(page);
  const dialog = await openCounterproposalDialog(page, source.proposalId);
  const offer = dialog.locator('#proposalOffer');
  await expect(offer).toHaveAttribute('readonly', '');
  expect(Number(await offer.inputValue())).toBe(300);
  await dialog.locator(`input[name="reparcel-agreement"][value="${mode}"]`).check();
  await dialog.locator('#proposalName').fill(`Audited courtyard ${mode}`);
  await dialog.locator('#proposalDescription').fill('Preserve private plots and share the enclosed courtyard.');
  await dialog.locator('#createProposalSubmitButton').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

async function openCounterproposalDialog(page: Page, proposalId: string) {
  await showProposal(page, proposalId);
  const panel = page.locator('#proposal-details-panel');
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  const moreActions = panel.locator('summary').filter({ hasText: 'More actions' });
  if (await moreActions.isVisible()) await moreActions.click();
  await panel.locator('.btn-counterpropose-proposal').click();
  const dialog = page.locator('.create-proposal-modal:visible');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function appliedPlans(page: Page) {
  return page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.applied && proposal.reparcellization).map((proposal: any) => JSON.parse(JSON.stringify(proposal))));
}

test('courtyard derivation preserves private plots, joint title and saved shares after reload', async ({ mockApi: page }, testInfo) => {
  const modal = await openCourtyard(page);
  await modal.locator('[data-reparcel-courtyard-building]').click();
  await expect(modal.locator('[data-reparcel-status]')).toContainText('Courtyard carved');
  await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('courtyard-derived.png'), fullPage: true });
  await finishCourtyard(page, 'single');
  const plans = await appliedPlans(page);
  expect(plans).toHaveLength(1);
  const joint = plans[0].reparcellization.polygons.filter((plot: any) => plot.jointPool);
  expect(joint).toHaveLength(1);
  expect(joint[0].owners).toHaveLength(2);
  const sourceBuildingId = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .find((proposal: any) => proposal.title === 'Courtyard source block')?.proposalId);
  expect(sourceBuildingId).toBeTruthy();
  expect(joint[0].derivation).toMatchObject({
    kind: 'building-courtyard', sourceProposalId: sourceBuildingId, sourceTitle: 'Courtyard source block',
    sourceFootprint: { type: 'Polygon', coordinates: [outer, inner] },
  });
  expect(joint[0].owners.map((owner: any) => owner.displayName).sort()).toEqual(['Owner A', 'Owner B']);
  expect(joint[0].owners.reduce((sum: number, owner: any) => sum + owner.share, 0)).toBeCloseTo(1, 12);
  expect(joint[0].owners[0].share).not.toBeCloseTo(joint[0].owners[1].share, 3);
  const readJoint = () => page.evaluate(({ id, inputIds }) => (window as any).LiveParcelFabric.entriesForCadastre(inputIds)
    .filter((feature: any) => String(feature.properties?.producedByProposalId) === id)
    .map((feature: any) => feature.properties.ownershipDetails)
    .filter((ownership: any) => ownership?.jointPool), { id: plans[0].proposalId, inputIds: ids });
  const before = await readJoint();
  expect(before).toHaveLength(1);
  expect(before[0].owners).toHaveLength(2);
  expect(before[0].owners.reduce((sum: number, owner: any) => sum + owner.percentageShare, 0)).toBeCloseTo(100, 8);
  const readCustody = () => page.evaluate(inputIds => {
    const w = window as any;
    const feature = w.LiveParcelFabric.entriesForCadastre(inputIds).find((entry: any) => entry.properties.ownershipDetails?.jointPool);
    if (!feature) return null;
    const id = w.PersistentStorage.getItem(`parcel_${feature.properties.parcelId}_owner`);
    const agent = w.agentStorage.getAgent(id);
    return agent ? { id, jointPool: agent.jointPool, members: agent.members } : null;
  }, ids);
  const custodyBefore = await readCustody();
  expect(custodyBefore?.jointPool).toBe(true);
  expect(custodyBefore?.members.map((member: any) => member.name).sort()).toEqual(['Owner A', 'Owner B']);
  expect(custodyBefore?.members.reduce((sum: number, member: any) => sum + member.share, 0)).toBeCloseTo(1, 12);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).ProposalManager?._initialReapplyDone === true);
  await expect.poll(readJoint).toEqual(before);
  expect(await readCustody()).toEqual(custodyBefore);
  expect((await appliedPlans(page))[0].reparcellization.polygons).toEqual(plans[0].reparcellization.polygons);
});

test('separate agreements preserve each input and coexist through reload', async ({ mockApi: page }, testInfo) => {
  const modal = await openCourtyard(page);
  await modal.locator('[data-reparcel-courtyard-building]').click();
  await expect(modal.locator('[data-reparcel-status]')).toContainText('Courtyard carved');
  await finishCourtyard(page, 'individual');
  const plans = await appliedPlans(page);
  expect(plans).toHaveLength(2);
  expect(plans.map((proposal: any) => proposal.cadastreParcelIds)).toEqual(expect.arrayContaining(ids.map(id => [id])));
  expect(plans.every((proposal: any) => proposal.reparcellization.polygons.some((plot: any) => plot.jointPool))).toBe(true);
  expect(plans.reduce((sum: number, proposal: any) => sum + proposal.offer, 0)).toBe(300);
  expect(plans.every((proposal: any) => proposal.reparcellization.inputParcels.length === 1
    && JSON.stringify(proposal.site) === JSON.stringify(proposal.reparcellization.inputParcels[0].geometry))).toBe(true);
  const childCashByOwner = new Map<string, number>();
  for (const proposal of plans) {
    const ledgerTotal = proposal.reparcellization.ownerShares.reduce((sum: number, owner: any) => sum + owner.cashOffer, 0);
    expect(proposal.offer).toBe(ledgerTotal);
    for (const owner of proposal.reparcellization.ownerShares) {
      childCashByOwner.set(owner.displayName, (childCashByOwner.get(owner.displayName) || 0) + owner.cashOffer);
    }
  }
  expect(Object.fromEntries(childCashByOwner)).toEqual({ 'Owner A': 200, 'Owner B': 100 });
  await page.screenshot({ path: testInfo.outputPath('courtyard-separate.png'), fullPage: true });
  const outputOwnership = () => page.evaluate(inputIds => (window as any).LiveParcelFabric.entriesForCadastre(inputIds)
    .filter((feature: any) => feature.properties?.producedByProposalId)
    .map((feature: any) => ({ id: feature.properties.parcelId, ownership: feature.properties.ownershipDetails }))
    .sort((a: any, b: any) => a.id.localeCompare(b.id)), ids);
  const before = await outputOwnership();
  expect(before).toHaveLength(4);
  expect(before.filter((feature: any) => feature.ownership.jointPool)).toHaveLength(2);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).ProposalManager?._initialReapplyDone === true);
  await expect.poll(async () => (await appliedPlans(page)).map((proposal: any) => proposal.proposalId).sort())
    .toEqual(plans.map((proposal: any) => proposal.proposalId).sort());
  expect(await outputOwnership()).toEqual(before);
});

test('a zero-cash land exchange can be forked and saved with its ledger intact', async ({ mockApi: page }) => {
  await openCourtyard(page);
  await finishCourtyard(page, 'single');
  const [source] = await appliedPlans(page);
  const dialog = await openCounterproposalDialog(page, source.proposalId);
  const offer = dialog.locator('#proposalOffer');
  await expect(offer).toHaveAttribute('readonly', '');
  expect(Number(await offer.inputValue())).toBe(0);
  await dialog.locator('#proposalName').fill('Cashless parcel exchange counterproposal');
  await dialog.locator('#proposalDescription').fill('Exchange parcel boundaries with no cash compensation.');
  await dialog.locator('#createProposalSubmitButton').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  const saved = await page.evaluate(() => {
    const proposal = (window as any).proposalStorage.getAllProposals()
      .find((item: any) => item.title === 'Cashless parcel exchange counterproposal');
    return proposal ? JSON.parse(JSON.stringify(proposal)) : null;
  });
  expect(saved).toBeTruthy();
  expect(saved.offer).toBe(0);
  expect(saved.cadastreParcelIds).toEqual(source.cadastreParcelIds);
  expect(saved.reparcellization.polygons).toEqual(source.reparcellization.polygons);
  expect(saved.reparcellization.ownerShares).toEqual(source.reparcellization.ownerShares);
});

test('a building without an enclosed hole does not change the kept layout', async ({ mockApi: page }) => {
  const modal = await openCourtyard(page, false);
  const before = await modal.locator('[data-reparcel-newplots-table]').innerText();
  await modal.locator('[data-reparcel-courtyard-building]').click();
  await expect(modal.locator('[data-reparcel-status]')).toContainText('No building block with an enclosed courtyard');
  expect(await modal.locator('[data-reparcel-newplots-table]').innerText()).toBe(before);
  await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled();
});

test('courtyard derivation can be undone without changing original ownership', async ({ mockApi: page }) => {
  const modal = await openCourtyard(page);
  const before = await modal.locator('[data-reparcel-newplots-table]').innerText();
  await modal.locator('[data-reparcel-courtyard-building]').click();
  await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(3);
  await modal.locator('[data-reparcel-undo-edit]').click();
  await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(2);
  expect(await modal.locator('[data-reparcel-newplots-table]').innerText()).toBe(before);
});

test('manual courtyard drawing creates shared land and conserves the entire pool', async ({ mockApi: page }, testInfo) => {
  const modal = await openCourtyard(page);
  const pool = await modal.locator('#reparcel-map .leaflet-overlay-pane svg path').evaluateAll(paths =>
    paths.map(path => path.getBoundingClientRect()).sort((a, b) => b.width - a.width)
      .map(box => ({ x: box.x, y: box.y, width: box.width, height: box.height }))[0]);
  expect(pool.width).toBeGreaterThan(100);
  await modal.locator('[data-reparcel-courtyard-draw]').click();
  for (const [x, y] of [[0.25, 0.3], [0.8, 0.3], [0.8, 0.7], [0.25, 0.7]]) {
    await page.mouse.click(pool.x + pool.width * x, pool.y + pool.height * y);
  }
  await expect(modal.locator('[data-reparcel-finish]')).toBeEnabled();
  await modal.locator('[data-reparcel-finish]').click();
  await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('courtyard-manual.png'), fullPage: true });
  await finishCourtyard(page, 'single');
  const [plan] = await appliedPlans(page);
  const plots = plan.reparcellization.polygons;
  expect(plots.filter((plot: any) => plot.jointPool)).toHaveLength(1);
  expect(plots.find((plot: any) => plot.jointPool).owners).toHaveLength(2);
  const difference = await page.evaluate(polygons => {
    const w = window as any;
    const features = polygons.map((plot: any) => w.turf.feature(plot.geometry));
    const union = features.reduce((a: any, b: any) => w.turf.union(a, b));
    return Math.abs(features.reduce((area: number, feature: any) => area + w.turf.area(feature), 0) - w.turf.area(union));
  }, plots);
  expect(difference).toBeLessThan(0.01);
  expect(plots.reduce((area: number, plot: any) => area + plot.area, 0)).toBeCloseTo(plan.reparcellization.totalArea, 1);
});

test('separate agreements require a shared courtyard', async ({ mockApi: page }) => {
  await openCourtyard(page);
  await finishCourtyard(page, 'single');
  const [source] = await appliedPlans(page);
  const dialog = await openCounterproposalDialog(page, source.proposalId);
  await expect(dialog.locator('input[name="reparcel-agreement"][value="individual"]')).toBeDisabled();
  await expect(dialog.locator('.reparcel-agreement-options')).toContainText('Draw a shared courtyard');
});

test('separate agreements reject a transfer of private land to another input owner', async ({ mockApi: page }) => {
  const modal = await openCourtyard(page);
  await modal.locator('[data-reparcel-courtyard-building]').click();
  await modal.locator('[data-reparcel-assign]').click();
  const leftPlot = await modal.locator('#reparcel-map .leaflet-overlay-pane path.leaflet-interactive').first().boundingBox();
  if (!leftPlot) throw new Error('Private plot has no visible bounds');
  await page.mouse.click(leftPlot.x + leftPlot.width * 0.1, leftPlot.y + leftPlot.height * 0.1);
  const popup = modal.locator('.reparcel-owner-popup');
  const ownerA = popup.locator('.reparcel-owner-popup__row').filter({ hasText: 'Owner A' }).locator('input');
  const ownerB = popup.locator('.reparcel-owner-popup__row').filter({ hasText: 'Owner B' }).locator('input');
  await expect(ownerA).toBeChecked();
  await expect(ownerB).not.toBeChecked();
  await ownerB.check();
  await ownerA.uncheck();
  await popup.locator('.reparcel-owner-popup__close').click();
  await finishCourtyard(page, 'single');
  const [source] = await appliedPlans(page);
  const dialog = await openCounterproposalDialog(page, source.proposalId);
  await expect(dialog.locator('input[name="reparcel-agreement"][value="individual"]')).toBeDisabled();
  await expect(dialog.locator('.reparcel-agreement-options')).toContainText('must keep private land with its original owners');
});

test('courtyard amendment can be reviewed and saved on a 390px viewport', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const modal = await openCourtyard(page);
  await modal.locator('[data-reparcel-courtyard-building]').click();
  await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(3);
  const cash = modal.locator('.cash-offer-input').first();
  await cash.scrollIntoViewIfNeeded();
  await expect(cash).toHaveAttribute('aria-label', /Cash offer.*Owner/);
  const bounds = await cash.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x || 0) + (bounds?.width || 0)).toBeLessThanOrEqual(390);
  await cash.fill('12.34');
  await expect(modal.locator('[data-reparcel-cashtotal]')).toContainText('12.34');
  expect(await modal.locator('[data-reparcel-owners-table]').evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('courtyard-mobile.png'), fullPage: true });
  await finishCourtyard(page, 'single');
  const [saved] = await appliedPlans(page);
  expect(saved.reparcellization.polygons.find((plot: any) => plot.jointPool).owners).toHaveLength(2);
  expect(saved.reparcellization.ownerShares[0].cashOffer).toBe(12.34);
});

for (const size of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`custom shares and per-owner before/after review survive save and reopen on ${size.name}`, async ({ mockApi: page }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const modal = await openCourtyard(page);
    await modal.locator('[data-reparcel-courtyard-building]').click();
    await modal.locator('.reparcel-newplot-row').last().getByRole('button', { name: 'Edit shares' }).click();
    const popup = modal.locator('.reparcel-owner-popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.reparcel-share-mode')).toContainText('private-land proportions');
    await popup.getByRole('spinbutton', { name: 'Owner A share (%)', exact: true }).fill('70');
    await popup.getByRole('spinbutton', { name: 'Owner B share (%)', exact: true }).fill('20');
    await expect(popup.locator('.reparcel-share-total')).toContainText('100%');
    await expect(popup.getByRole('button', { name: 'Apply shares', exact: true })).toBeDisabled();
    await expect(modal.locator('[data-reparcel-commit]')).toBeDisabled();
    await popup.getByRole('spinbutton', { name: 'Owner B share (%)', exact: true }).fill('30');
    await expect(popup.getByRole('button', { name: 'Apply shares', exact: true })).toBeEnabled();
    await popup.getByRole('button', { name: 'Apply shares', exact: true }).click();
    await expect(popup).toBeHidden();
    await expect(modal.locator('.reparcel-newplot-row').last()).toContainText(/70(?:\.0)?%/);

    const review = modal.locator('[data-reparcel-owner-review]');
    await review.getByRole('combobox').selectOption({ label: 'Owner A' });
    await expect(review.locator('li')).toHaveCount(2);
    await expect(review).toContainText('Input parcels: 1234');
    await expect(review).toContainText(/70(?:\.0)?%/);
    await expect(modal.locator('#reparcel-map path.reparcel-owner-input')).toHaveCount(1);
    await expect(modal.locator('#reparcel-map path.reparcel-owner-output')).toHaveCount(2);
    const cash = modal.locator('[data-reparcel-owners-table] tr').filter({ hasText: 'Owner A' }).locator('.cash-offer-input');
    await cash.fill('-1');
    await expect(modal.locator('[data-reparcel-commit]')).toBeDisabled();
    await cash.fill('12.345');
    await expect(modal.locator('[data-reparcel-commit]')).toBeDisabled();
    await cash.fill('');
    await expect(modal.locator('[data-reparcel-commit]')).toBeDisabled();
    await cash.fill('12.34');
    await expect(review.locator('[data-impact="cash"]')).toContainText('12.34');
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled();
    await review.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`${size.name}-owner-review.png`), fullPage: true });

    // The review isolates this owner's old parcels on one side and fractional outputs on the other.
    await modal.locator('[data-reparcel-compare]').click();
    await expect(modal.locator('.reparcel-before-map path.reparcel-owner-input')).toHaveCount(1);
    await expect(modal.locator('#reparcel-map > .leaflet-pane path.reparcel-owner-output')).toHaveCount(2);
    await modal.locator('#reparcel-map').scrollIntoViewIfNeeded();
    await expect.poll(() => modal.locator('#reparcel-map').evaluate(map => {
      const before = map.querySelector('.reparcel-before-map path[stroke="#111"]')?.getBoundingClientRect();
      const after = map.querySelector(':scope > .leaflet-pane path[stroke="#dc2626"]')?.getBoundingClientRect();
      return before && after ? Math.max(...['x', 'y', 'width', 'height'].map(key =>
        Math.abs((before as any)[key] - (after as any)[key]))) : Infinity;
    }), { message: 'Before and after must use the same projection, including half-step zoom above level 19' }).toBeLessThan(2);
    const visibleOutputs = await modal.locator('#reparcel-map').evaluate(map => {
      const box = map.getBoundingClientRect();
      return [...map.querySelectorAll('path.reparcel-owner-output')].every(path => {
        const plot = path.getBoundingClientRect();
        return plot.width > 0 && plot.height > 0 && plot.left >= box.left && plot.right <= box.right
          && plot.top >= box.top && plot.bottom <= box.bottom;
      });
    });
    expect(visibleOutputs, 'Closing the share popup must restore the parcels inside the map').toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${size.name}-owner-comparison.png`), fullPage: true });
    await modal.locator('[data-reparcel-compare]').click();

    if (size.name === 'desktop') {
      // Splitting a custom joint plot preserves its shares; undo restores the original plot.
      await review.getByRole('combobox').selectOption('');
      await modal.locator('[data-reparcel-assign]').click();
      await modal.locator('#reparcel-map').scrollIntoViewIfNeeded();
      await modal.locator('[data-reparcel-line]').click();
      const pool = await modal.locator('#reparcel-map .leaflet-overlay-pane path').evaluateAll(paths =>
        paths.map(path => path.getBoundingClientRect()).sort((a, b) => b.width - a.width)
          .map(box => ({ x: box.x, y: box.y, width: box.width, height: box.height }))[0]);
      await page.mouse.click(pool.x, pool.y + pool.height * 0.5);
      await page.mouse.click(pool.x + pool.width, pool.y + pool.height * 0.5);
      await modal.locator('[data-reparcel-finish]').click();
      await expect.poll(() => modal.locator('.reparcel-newplot-row').count()).toBeGreaterThan(3);
      const jointRows = modal.locator('.reparcel-newplot-row').filter({ hasText: /70(?:\.0)?%/ });
      await expect(jointRows).toHaveCount(2);
      await modal.locator('[data-reparcel-undo-edit]').click();
      await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(3);
      await expect(modal.locator('.reparcel-newplot-row').last()).toContainText(/70(?:\.0)?%/);
    }
    await finishCourtyard(page, 'single');
    const [saved] = await appliedPlans(page);
    const shared = saved.reparcellization.polygons.find((plot: any) => plot.jointPool);
    expect(shared.jointShareMode).toBe('manual');
    expect(shared.owners.map((owner: any) => owner.share)).toHaveLength(2);
    expect(shared.owners[0].share).toBeCloseTo(0.7, 12);
    expect(shared.owners[1].share).toBeCloseTo(0.3, 12);
    const validation = await page.evaluate(proposal => (window as any).ReparcellizationValidation.validate(proposal), saved);
    expect(validation.valid).toBe(true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).ProposalManager?._initialReapplyDone === true);
    await showProposal(page, saved.proposalId);
    const panel = page.locator('#proposal-details-panel');
    const expand = panel.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    const more = panel.locator('summary').filter({ hasText: 'More actions' });
    if (await more.isVisible()) await more.click();
    await panel.locator('.btn-edit-geometry').click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('.reparcel-newplot-row').last()).toContainText(/70(?:\.0)?%/);
    await modal.locator('.reparcel-newplot-row').last().getByRole('button', { name: 'Edit shares' }).click();
    await expect(popup.locator('.reparcel-share-mode')).toContainText('stay fixed');
    await expect(popup.getByRole('spinbutton', { name: 'Owner A share (%)', exact: true })).toHaveValue('70');
    await popup.getByRole('spinbutton', { name: 'Owner A share (%)', exact: true }).scrollIntoViewIfNeeded();
    const popupBox = await popup.boundingBox();
    expect(popupBox?.x).toBeGreaterThanOrEqual(0);
    expect((popupBox?.x || 0) + (popupBox?.width || 0)).toBeLessThanOrEqual(size.width);
    await page.screenshot({ path: testInfo.outputPath(`${size.name}-custom-shares.png`), fullPage: true });
  });
}
