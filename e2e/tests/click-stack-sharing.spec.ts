// Click-stack sharing offers an explicit scope and opens the existing panel with exact plan members.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { clickDesignOnMap, expandStackSection, stackSection, stubBasemapTiles } from '../helpers/runtime';
import { fileDesign, filePlan, pageIndex } from '../helpers/mocks/shared-server';
import { sampleParcels } from '../helpers/mocks/parcel-data';

const records = require('../../frontend/js/design-record.js');
const plans = require('../../frontend/js/plan-record.js');

async function openComposition(page: Page, includeSecond = true) {
  await stubBasemapTiles(page);
  const index = pageIndex(page);
  const titles = ['Garden one', 'Garden two', 'Outside garden'];
  const cids = titles.map((title, i) => {
    const geometry = sampleParcels.features[i].geometry;
    return fileDesign(index, records.published({ title, city: 'zg', author: 'Studio North', goal: 'park',
      site: geometry, structureProposal: { kind: 'park', geometry }, createdAt: '2026-10-25T10:00:00Z' }));
  });
  const planCid = filePlan(index, plans.create('Garden collection', cids.slice(0, 2), {
    at: '45.80025,15.9822,18', mode: '2d', city: 'zg', language: 'en'
  }));
  const imported = includeSecond ? cids : [cids[0], cids[2]];
  await page.goto(`/designs/${imported.join(',')}?city=zg&lang=en&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.proposalStorage?.getAllProposals().filter((record: any) => w.isApplied(record)).length;
  }), { timeout: 30_000 }).toBe(imported.length);
  const id = await page.evaluate(cid => (window as any).DesignSync.localCopyOf(cid).proposalId, cids[0]);
  await clickDesignOnMap(page, id, { x: 0.3, y: 0.2 });
  await expandStackSection(page, 'designs');
  await expect(stackSection(page, 'plans').locator('.click-stack__row')).toContainText('Garden collection');
  return { index, cids, planCid, id };
}

async function expectExactMembers(page: Page, cids: string[]) {
  const panel = page.locator('.share-plan-panel');
  await expect(panel.locator('.share-plan-row')).toHaveCount(3);
  await expect(panel.getByRole('checkbox', { name: 'Garden one', exact: true })).toBeChecked();
  await expect(panel.getByRole('checkbox', { name: 'Garden two', exact: true })).toBeChecked();
  await expect(panel.getByRole('checkbox', { name: 'Outside garden', exact: true })).not.toBeChecked();
  await expect.poll(async () => {
    const input = panel.locator('.share-plan-link__input[readonly]');
    if (!(await input.isVisible())) return [];
    return new URL(await input.inputValue()).pathname.replace('/designs/', '').split(',').sort();
  }).toEqual(cids.slice(0, 2).sort());
}

test('design Share warns before publishing, can cancel, and offers the whole plan', async ({ mockApi: page }) => {
  const { index, cids } = await openComposition(page);
  const share = stackSection(page, 'designs').locator('.btn-share-proposal');
  await share.click();
  const warning = page.getByRole('alertdialog', { name: 'Share design or plan?', exact: true });
  await expect(warning).toContainText('publishes only this design');
  await expect(warning).toContainText('The rest of the plan is not included.');
  expect(index.requests.filter(row => row.method === 'POST' && ['/pins', '/designs', '/plans'].includes(row.path))).toHaveLength(0);
  await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(warning).toBeHidden();
  await expect(share).toBeVisible();
  await share.click();
  await warning.getByRole('button', { name: 'Share the whole plan', exact: true }).click();
  await expectExactMembers(page, cids);
  expect(index.requests.filter(row => row.method === 'POST' && ['/pins', '/designs', '/plans'].includes(row.path))).toHaveLength(0);
});

for (const width of [1280, 390]) {
  test(`plan Share includes an unapplied remote member and excludes unrelated designs at ${width}px`, async ({ mockApi: page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { cids } = await openComposition(page, false);
    await expandStackSection(page, 'plans');
    const share = stackSection(page, 'plans').getByRole('button', { name: 'Share plan', exact: true });
    await expect(share).toHaveClass(/btn-primary/);
    await share.click();
    await expectExactMembers(page, cids);
    // Reading a plan for sharing must not import or apply its missing member.
    expect(await page.evaluate(cid => (window as any).DesignSync.localCopyOf(cid), cids[1])).toBeNull();
    expect(await page.evaluate(() => {
      const w = window as any;
      return w.proposalStorage.getAllProposals().filter((record: any) => w.isApplied(record)).length;
    })).toBe(2);
    const panel = page.locator('.share-plan-panel');
    await panel.getByRole('checkbox', { name: 'Garden one', exact: true }).uncheck();
    await panel.getByRole('checkbox', { name: 'Outside garden', exact: true }).check();
    await page.locator('#designs-browse-tab').click();
    await page.locator('#shareAppliedProposalsButton').click();
    await expect(panel.getByRole('checkbox', { name: 'Garden one', exact: true })).not.toBeChecked();
    await expect(panel.getByRole('checkbox', { name: 'Garden two', exact: true })).toBeChecked();
    await expect(panel.getByRole('checkbox', { name: 'Outside garden', exact: true })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.locator('#proposals-sheet')).toBeHidden();
    await page.locator('#proposals-button').click();
    await page.locator('#shareAppliedProposalsButton').click();
    await expect(panel.locator('.share-plan-row')).toHaveCount(2);
    await expect(panel.getByRole('checkbox', { name: 'Garden one', exact: true })).toBeChecked();
    await expect(panel.getByRole('checkbox', { name: 'Outside garden', exact: true })).toBeChecked();
  });
}

test('a design included in several plans lets the person choose which plan to share', async ({ mockApi: page }) => {
  const { index, cids } = await openComposition(page);
  filePlan(index, plans.create('Alternate garden collection', [cids[0], cids[2]], {
    at: '45.80025,15.9822,18', mode: '2d', city: 'zg', language: 'en'
  }));
  await stackSection(page, 'designs').locator('.btn-share-proposal').click();
  await page.getByRole('alertdialog', { name: 'Share design or plan?', exact: true })
    .getByRole('button', { name: 'Share the whole plan', exact: true }).click();
  const chooser = page.getByRole('alertdialog', { name: 'Share plan', exact: true });
  await expect(chooser).toContainText('Which plan do you want to share?');
  await chooser.getByRole('button', { name: 'Alternate garden collection', exact: true }).click();
  const panel = page.locator('.share-plan-panel');
  await expect(panel.getByRole('checkbox', { name: 'Garden one', exact: true })).toBeChecked();
  await expect(panel.getByRole('checkbox', { name: 'Garden two', exact: true })).not.toBeChecked();
  await expect(panel.getByRole('checkbox', { name: 'Outside garden', exact: true })).toBeChecked();
  await expect.poll(async () => {
    const input = panel.locator('.share-plan-link__input[readonly]');
    if (!(await input.isVisible())) return [];
    return new URL(await input.inputValue()).pathname.replace('/designs/', '').split(',').sort();
  }).toEqual([cids[0], cids[2]].sort());
});
