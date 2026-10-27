// Design sharing publishes/copies one design; saved plans have their own sharing action.
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

async function expectExactPlanShare(page: Page, title: string, planCid: string, expectedMembers: string[]) {
  const dialog = page.locator('.plan-share');
  await expect(dialog.locator('h3')).toHaveText(title);
  const members = dialog.locator('.plan-dialog__members li');
  await expect(members).toHaveCount(expectedMembers.length);
  await expect.poll(() => members.allTextContents().then(titles => titles.sort()))
    .toEqual([...expectedMembers].sort());
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
  const link = dialog.getByLabel('Plan link', { exact: true });
  await expect(link).toBeVisible();
  await expect.poll(async () => new URL(await link.inputValue()).pathname).toBe(`/plans/${planCid}`);
  await dialog.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(`/plans/${planCid}`);
}

test('design Share copies only that design; saved-plan Share opens its exact members', async ({ mockApi: page }) => {
  const { index, cids, planCid } = await openComposition(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const share = stackSection(page, 'designs').locator('.btn-share-proposal');
  await share.click();
  await expect(page.getByRole('alertdialog', { name: 'Share design or plan?', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(`/designs/${cids[0]}`);
  expect(index.requests.filter(row => row.method === 'POST' && ['/pins', '/designs', '/plans'].includes(row.path))).toHaveLength(0);

  await expandStackSection(page, 'plans');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await expect(stackSection(page,'plans').getByRole('link',{name:'Open plan',exact:true})).toHaveCount(0);
  await stackSection(page, 'plans').getByRole('button', { name: 'Share plan', exact: true }).click();
  await expectExactPlanShare(page, 'Garden collection', planCid, ['Garden one', 'Garden two']);
  expect(index.requests.filter(row => row.method === 'POST' && ['/pins', '/designs', '/plans'].includes(row.path))).toHaveLength(0);
});

for (const width of [1280, 390]) {
  test(`plan Share includes an unapplied remote member and excludes unrelated designs at ${width}px`, async ({ mockApi: page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { index, cids, planCid, id } = await openComposition(page, false);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await expandStackSection(page, 'plans');
    const share = stackSection(page, 'plans').getByRole('button', { name: 'Share plan', exact: true });
    await expect(share).toHaveClass(/btn-primary/);
    await share.click();
    await expectExactPlanShare(page, 'Garden collection', planCid, ['Garden one', 'Garden two']);
    expect(index.requests.filter(row => row.method === 'POST' && ['/pins','/designs','/plans','/agreements'].includes(row.path))).toHaveLength(0);
    // Reading a plan for sharing must not import or apply its missing member.
    expect(await page.evaluate(cid => (window as any).DesignSync.localCopyOf(cid), cids[1])).toBeNull();
    expect(await page.evaluate(() => {
      const w = window as any;
      return w.proposalStorage.getAllProposals().filter((record: any) => w.isApplied(record)).length;
    })).toBe(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('.plan-dialog')).toBeHidden();
    await clickDesignOnMap(page, id, { x: 0.3, y: 0.2 });
    await expandStackSection(page, 'designs');
    await expandStackSection(page, 'plans');
    await share.click();
    await expectExactPlanShare(page, 'Garden collection', planCid, ['Garden one', 'Garden two']);
  });
}

test('design Share stays on the selected design when it belongs to several plans', async ({ mockApi: page }) => {
  const { index, cids } = await openComposition(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  filePlan(index, plans.create('Alternate garden collection', [cids[0], cids[2]], {
    at: '45.80025,15.9822,18', mode: '2d', city: 'zg', language: 'en'
  }));
  await stackSection(page, 'designs').locator('.btn-share-proposal').click();
  await expect(page.getByRole('alertdialog', { name: 'Share design or plan?', exact: true })).toHaveCount(0);
  await expect(page.locator('.share-plan-panel')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(`/designs/${cids[0]}`);
  expect(index.requests.filter(row => row.method === 'POST' && ['/pins', '/designs', '/plans'].includes(row.path))).toHaveLength(0);
});
