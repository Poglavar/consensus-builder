// Isolated real-browser file/UI checks. No production plans, source API or wallet is contacted.
import { test, expect } from '@playwright/test';
import path from 'node:path';
const root = path.resolve(__dirname, '../../frontend');

test.beforeEach(async ({ page }) => {
  await page.route('http://localhost/plan-file-fixture', route => route.fulfill({ contentType: 'text/html', body: '<div id="plan-file-actions"></div><div id="downloads"></div>' }));
  await page.goto('http://localhost/plan-file-fixture');
  await page.evaluate(() => { (window as any).MapHighlight = { color: '#469973' }; });
  for (const file of ['vendor/noble-hashes-1.8.0/sha256.js', 'vendor/ipfs-file-cid/ipfs-file-cid.js', 'js/cid.js',
    'js/proposals/authored-record.js', 'js/proposals/formation-depth.js', 'js/design-record.js', 'js/plan-record.js',
    'js/plan-file.js', 'js/ui/busy-control.js', 'js/ui/modal-escape.js', 'js/ui/dialogs.js', 'js/proposals/dialog-share.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => {
    const w = window as any;
    w.getProposalI18nHelper = () => (_key: string, fallback: string, params: any = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_: string, key: string) => String(params[key]));
    w.errors = []; w.showStyledAlert = (message: string) => w.errors.push(message);
    w.writes = 0; w.applies = 0; w.failImport = false;
    const records = new Map(), values = new Map();
    w.proposalStorage = { getAllProposals: () => [...records.values()], getProposal: (id: string) => records.get(id) };
    w.PersistentStorage = { forEach: (fn: any) => values.forEach((value, key) => fn(value, key)) };
    w.ProposalManager = { runParcelMutation: async (_kind: string, _id: any, work: any) => {
      const draft = new Map(records), puts = new Map();
      const store = { getAllProposals: () => [...draft.values()], getProposal: (id: string) => draft.get(id),
        importProposal: (record: any) => { if (w.failImport) throw new Error('Storage failed'); draft.set(record.proposalId, record); return record; } };
      const result = await work({ _parcelMutation: { proposals: store, storage: { setItem: (key: string, value: string) => puts.set(key, value) } } });
      draft.forEach((v, k) => records.set(k, v)); puts.forEach((v, k) => values.set(k, v)); w.writes++; return result;
    } };
    w.MapShare = { capture: () => ({ at: '45,15,17', mode: '2d', city: 'zagreb' }) };
    const site = { type: 'Polygon', coordinates: [[[15,45],[15.001,45],[15.001,45.001],[15,45.001],[15,45]]] };
    w.sample = { proposalId: 'sample', goal: 'park', title: '<img src=x onerror=alert(1)>', site, structureProposal: { kind: 'park', geometry: site } };
    w.showSharePlanPanel = (options: any) => { w.opened = options; };
  });
  await page.addScriptTag({ path: path.join(root, 'js/plan-file-ui.js') });
  await page.addStyleTag({ content: '.cb-dialog-backdrop{position:fixed;inset:0;background:#fff}.cb-dialog{background:white;padding:20px}.cb-dialog button{margin:5px}' });
});

async function choose(page: any, body?: string) {
  const text = body ?? await page.evaluate(async () => {
    const w = window as any; return w.PlanFile.stringify(await w.PlanFile.create([w.sample], { title: 'File plan', view: w.MapShare.capture() }));
  });
  await page.locator('input[type=file]').first().setInputFiles({ name: 'test.ugt.json', mimeType: 'application/json', buffer: Buffer.from(text) });
}

test('preview, cancel, repeated choice and confirmation preserve unapplied drafts', async ({ page }) => {
  await choose(page);
  await expect(page.getByRole('heading', { name: 'Review plan file' })).toBeVisible();
  expect(await page.evaluate(() => document.querySelectorAll('.cb-dialog-body img').length)).toBe(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as any).writes)).toBe(0);
  await expect(page.getByRole('button', { name: 'Import plan file', exact: true })).toBeEnabled();
  await choose(page);
  await page.getByRole('button', { name: 'Import as drafts' }).click();
  expect(await page.evaluate(() => (window as any).errors)).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Plan imported', exact: true })).toBeVisible();
  const snapshot = await page.evaluate(() => { const w = window as any; return { writes: w.writes, records: w.proposalStorage.getAllProposals(), applies: w.applies }; });
  expect(snapshot.records).toHaveLength(1); expect(snapshot.records[0].applied).toBe(false); expect(snapshot.records[0].published).toBeUndefined(); expect(snapshot.applies).toBe(0);
  await page.getByRole('button', { name: 'Open imported plan' }).click();
  expect(await page.evaluate(() => (window as any).opened.view.at)).toBe('45,15,17');
  await choose(page); await page.getByRole('button', { name: 'Import as drafts' }).click();
  await expect(page.getByRole('heading', { name: 'Plan imported', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(1);
});

test('malformed, unsupported and storage-failed flows leave no writes and restore controls', async ({ page }) => {
  for (const text of ['{', '{"schema":"ugt-plan-file/v99"}']) {
    await choose(page, text);
    await expect.poll(() => page.evaluate(() => (window as any).errors.length)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Import plan file', exact: true })).toBeEnabled();
  }
  await page.evaluate(() => { (window as any).failImport = true; });
  await choose(page); await page.getByRole('button', { name: 'Import as drafts' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).errors.includes('Storage failed'))).toBe(true);
  expect(await page.evaluate(() => (window as any).writes)).toBe(0);
  await expect(page.getByRole('button', { name: 'Import plan file', exact: true })).toBeEnabled();
});

test('Escape and closing the review settle cancellation and allow the same file again', async ({ page }) => {
  for (const method of ['escape', 'close']) {
    await choose(page);
    await expect(page.getByRole('heading', { name: 'Review plan file' })).toBeVisible();
    if (method === 'escape') await page.keyboard.press('Escape');
    else await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review plan file' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Import plan file', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => (window as any).writes)).toBe(0);
  }
});

test('JSON and GIS downloads use the selected scope and downloads remain repeatable', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    document.getElementById('downloads')!.appendChild(w.PlanFileUI.controls({ getRecords: () => [w.sample], getTitle: () => 'Selected plan' }));
  });
  for (const label of ['Download editable plan', 'Download GeoJSON', 'Download editable plan']) {
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: label, exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(label.includes('GeoJSON') ? /\.geojson$/ : /\.ugt\.json$/);
    const stream = await download.createReadStream(); const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const json = JSON.parse(Buffer.concat(chunks).toString());
    if (label.includes('GeoJSON')) expect(json.features.every((f: any) => f.properties.ugt_title === '<img src=x onerror=alert(1)>')).toBe(true);
    else { expect(json.plan.title).toBe('Selected plan'); expect(json.designs).toHaveLength(1); }
    await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
  }
});
