// Isolated real-browser file/UI checks. No production plans, source API or wallet is contacted.
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
const root = path.resolve(__dirname, '../../frontend');
const test = base.extend<{ checkPageErrors: void }>({
  checkPageErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use();
    expect(errors, 'Uncaught browser errors').toEqual([]);
  }, { auto: true }],
});

test.beforeEach(async ({ page }) => {
  await page.route('http://localhost/plan-file-fixture', route => route.fulfill({ contentType: 'text/html', body: '<div id="plan-file-actions"></div><div id="downloads"></div><div id="status-log-modal"><div class="cb-dialog__footer"></div></div>' }));
  await page.goto('http://localhost/plan-file-fixture');
  await page.evaluate(() => { (window as any).MapHighlight = { color: '#469973' }; });
  for (const file of ['js/app-diagnostics.js', 'vendor/noble-hashes-1.8.0/sha256.js', 'vendor/ipfs-file-cid/ipfs-file-cid.js', 'js/cid.js',
    'js/proposals/authored-record.js', 'js/proposals/formation-depth.js', 'js/design-record.js', 'js/plan-record.js',
    'js/plan-file.js', 'js/data-source.js', 'js/ui/busy-control.js', 'js/ui/modal-escape.js', 'js/ui/dialogs.js', 'js/proposals/dialog-share.js']) {
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
  await expect.poll(() => page.evaluate(() => (window as any).AppDiagnostics.snapshot().entries.some((row: any) => row.code === 'plan-import-failed'))).toBe(true);
  expect(await page.evaluate(() => (window as any).errors.some((message: string) => message.includes('Storage failed')))).toBe(false);
  expect(await page.evaluate(() => (window as any).writes)).toBe(0);
  await expect(page.getByRole('button', { name: 'Import plan file', exact: true })).toBeEnabled();
});

test('diagnostic download redacts private error text and sends nothing automatically', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.evaluate(() => {
    (window as any).AppDiagnostics.report(new Error('alice@example.com ?token=SECRET wallet=PRIVATE 192.0.2.1'), {
      code: 'plan-export-failed', context: { surface: 'plan-file', title: 'Private plan', url: 'https://private.example/?token=SECRET' }
    });
  });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download diagnostics', exact: true }).click();
  const download = await downloading;
  const stream = await download.createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString(), data = JSON.parse(text);
  expect(download.suggestedFilename()).toBe('ugt-diagnostics.json');
  expect(data.entries[0].code).toBe('plan-export-failed');
  for (const value of ['SECRET', 'alice@example.com', 'PRIVATE', '192.0.2.1', 'Private plan']) expect(text).not.toContain(value);
  await expect(page.getByRole('button', { name: 'Send diagnostic report', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear diagnostics', exact: true }).click();
  expect(await page.evaluate(() => (window as any).AppDiagnostics.snapshot().entries)).toEqual([]);
  expect(requests).toEqual([]);
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

for (const [label, reference, expectedUrl] of [
  ['served path', '/uploads/models/portable.glb', 'http://localhost:4020/uploads/models/portable.glb'],
  ['old development origin', 'http://localhost:4999/uploads/models/portable.glb', 'http://localhost:4020/uploads/models/portable.glb'],
  ['public absolute URL', 'https://models.example/uploads/models/portable.glb', 'https://models.example/uploads/models/portable.glb'],
]) {
  test(`model download resolves ${label} and embeds the fetched bytes`, async ({ page }) => {
    // A self-contained GLB with an empty scene is enough to check lossless file transport.
    const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }));
    const jsonLength = Math.ceil(json.length / 4) * 4;
    const glb = Buffer.alloc(20 + jsonLength, 32);
    glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(jsonLength, 12); glb.writeUInt32LE(0x4e4f534a, 16); json.copy(glb, 20);
    const requests: string[] = [];
    let release!: () => void;
    const responseReady = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/uploads/models/portable.glb', async route => {
      requests.push(route.request().url());
      await responseReady;
      await route.fulfill({ body: glb, contentType: 'model/gltf-binary', headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.evaluate(modelUrl => {
      const w = window as any;
      const url = new URL(location.href);
      url.searchParams.set('backend', 'http://localhost:4020');
      history.replaceState(null, '', url);
      w.sample = { ...w.sample, goal: 'single', structureProposal: undefined, buildingProposal: {},
        geometry: { buildings: [{ type: 'Feature', geometry: w.sample.site, properties: { modelUrl } }] } };
      document.getElementById('downloads')!.appendChild(w.PlanFileUI.controls({ getRecords: () => [w.sample] }));
    }, reference);
    const button = page.getByRole('button', { name: 'Download editable plan', exact: true });
    const downloading = page.waitForEvent('download');
    try {
      await button.click();
      await expect.poll(() => requests.length).toBe(1);
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await expect(button).toBeDisabled();
    } finally { release(); }
    const download = await downloading;
    const stream = await download.createReadStream(); const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const file = JSON.parse(Buffer.concat(chunks).toString());
    expect(requests).toEqual([expectedUrl]);
    expect(download.suggestedFilename()).toBe('plan.ugt.json');
    expect(file.designs[0].content.geometry.buildings[0].properties.modelUrl).toBe('data:model/gltf-binary;base64,' + glb.toString('base64'));
    expect(await page.evaluate(file => { const w = window as any; return w.PlanFile.parse(JSON.stringify(file)).schema; }, file)).toBe('ugt-plan-file/v1');
    expect(await page.evaluate(() => (window as any).sample.geometry.buildings[0].properties.modelUrl)).toBe(reference);
    expect(await page.evaluate(() => (window as any).errors)).toEqual([]);
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('aria-busy', 'true');
  });
}
