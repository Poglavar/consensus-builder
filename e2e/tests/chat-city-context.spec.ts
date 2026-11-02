import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles, PARCEL_GEOMETRY } from '../helpers/runtime';
import { selectors } from '../helpers/selectors';
import { privatePreview } from '../helpers/private-preview';

const planRecord = require('../../frontend/js/plan-record.js');
const cid = require('../../frontend/js/cid.js');

const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
const asJson = (value: unknown) => JSON.stringify(value);

async function authoredPlan(title: string, city: string) {
  const { buildTypedDesign } = await import('../../backend/agents/mcp-constructors.js');
  const site = city === 'ljubljana' ? { type: 'Polygon', coordinates: [[[14.5055,46.0565],[14.5065,46.0565],
    [14.5065,46.057],[14.5055,46.057],[14.5055,46.0565]]] } : PARCEL_GEOMETRY;
  const design = buildTypedDesign({ kind: 'building', typology: 'row', floors: 3, depthM: 10,
    floorHeightM: 3, site, city, title, authoredAt: '2026-11-02T00:00:00.000Z' });
  const designCid = cid.cidOfObject(design);
  const plan = planRecord.create(`${title} plan`, [designCid], {
    at: city === 'ljubljana' ? '46.0569,14.5058,18' : '45.80025,15.9817,18',
    mode: '2d', city, language: 'en'
  });
  return { design, plan, planCid: cid.cidOfObject(plan) };
}

async function privatePlan(page: any, baseURL: string, title: string, city: string) {
  const value = await authoredPlan(title, city);
  const previewUrl = await privatePreview(page, baseURL, { plan: value.plan, designs: [value.design] });
  return { ...value, previewUrl, draftRef: new URL(previewUrl).searchParams.get('draft')! };
}

async function boot(page: any, city = 'zagreb') {
  await stubBasemapTiles(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/?city=${city}&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
}

async function openChatByKeyboard(page: any) {
  const button = page.locator(selectors.chatButton);
  await expect(button).toBeVisible();
  await button.focus();
  await button.press('Enter');
  const sheet = page.locator(selectors.chatSheet);
  await expect(sheet).toBeVisible();
  return { sheet, composer: sheet.getByRole('textbox') };
}

async function submitByKeyboard(page: any, text: string) {
  const { sheet, composer } = await openChatByKeyboard(page);
  await composer.focus();
  await composer.fill(text);
  await composer.press('Enter');
  return { sheet, composer };
}

function planStream(plan: { draftRef: string; planCid: string }, title: string) {
  return [
    `event: plan\ndata: ${asJson({ draftRef: plan.draftRef, cid: plan.planCid, changes: [{ beforeCid: null, afterCid: plan.planCid }] })}`,
    `event: reply\ndata: ${asJson({ text: `${title} is ready.` })}`,
    'event: done\ndata: {"turns":1,"conversationSpentUsd":0.001}'
  ].join('\n\n') + '\n\n';
}

async function expectApplied(page: any, title: string) {
  await expect.poll(() => page.evaluate((name: string) => {
    const row = (window as any).proposalStorage?.getAllProposals?.().find((item: any) => item.title === name);
    return { applied: row?.applied === true, typology: row?.buildingProposal?.typologyType };
  }, title), { timeout: 30_000 }).toEqual({ applied: true, typology: 'row' });
}

async function saveConversationPointer(page: any, value: Record<string, unknown>) {
  await page.evaluate((stored: Record<string, unknown>) => {
    const base = (window as any).getBackendBase().replace(/\/+$/, '');
    localStorage.setItem(`chat-conversation-v1:${base}`, JSON.stringify(stored));
  }, value);
}

function watchedPreviewRequests(page: any, draftRef: string) {
  const watched: string[] = [];
  page.on('request', (request: any) => {
    if (request.url().includes(draftRef)) watched.push(request.url());
  });
  return watched;
}

test('chat reload ignores foreign and cityless saved pointers, then applies a Zagreb plan @core', async ({ mockApi: page, baseURL }) => {
  const oldPlan = { ...await authoredPlan('Ljubljana saved rule', 'ljubljana'), draftRef: 'https://api.example/mcp/previews/ljubljana-saved-rule' };
  const newPlan = await privatePlan(page, baseURL!, 'Zagreb rule after reload', 'zagreb');
  const oldReads: string[] = [], oldDeletes: string[] = [], creates: any[] = [], turns: any[] = [];
  let createCount = 0;
  await page.route('**/chat/conversations', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    creates.push(route.request().postDataJSON());
    createCount += 1;
    await route.fulfill({ status: 201, contentType: 'application/json', body: asJson({ id: `conv-zg-${createCount}`, city: 'zagreb', expiresAt: expiresAt() }) });
  });
  await page.route('**/chat/conversations/conv-ljubljana', async route => {
    if (route.request().method() === 'DELETE') { oldDeletes.push(route.request().method()); await route.fulfill({ status: 204 }); }
    else if (route.request().method() === 'GET') {
      oldReads.push(route.request().method());
      await route.fulfill({ status: 200, contentType: 'application/json', body: asJson({ id: 'conv-ljubljana', city: 'ljubljana', expiresAt: expiresAt(), turns: 1, spentUsd: 0.001,
        plan: { draftRef: oldPlan.draftRef, cid: oldPlan.planCid } }) });
    } else await route.fallback();
  });
  await page.route('**/chat/conversations/conv-zg-*/turns', async route => {
    turns.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: planStream(newPlan, newPlan.design.title) });
  });
  await page.route('**/chat/conversations/conv-ljubljana/turns', async route => route.fulfill({ status: 409, json: { code: 'conversation_city_mismatch' } }));
  const oldArtifactRequests = watchedPreviewRequests(page, oldPlan.draftRef);

  await boot(page);
  await saveConversationPointer(page, { id: 'conv-ljubljana', city: 'ljubljana', expiresAt: expiresAt() });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  let chat = await submitByKeyboard(page, 'Add a new Zagreb rule');
  await expect(chat.sheet.getByText('Zagreb rule after reload is ready.')).toBeVisible();
  await expectApplied(page, 'Zagreb rule after reload');

  await saveConversationPointer(page, { id: 'conv-ljubljana', expiresAt: expiresAt() });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  chat = await submitByKeyboard(page, 'Add another Zagreb rule');
  await expect(chat.sheet.getByText('Zagreb rule after reload is ready.')).toBeVisible();
  await expectApplied(page, 'Zagreb rule after reload');

  expect(creates.map(row => row.city)).toEqual(['zagreb', 'zagreb']);
  expect(turns.map(row => row.text)).toEqual(['Add a new Zagreb rule', 'Add another Zagreb rule']);
  expect(turns.every(row => row.context.city === 'zagreb')).toBe(true);
  expect(oldReads).toEqual([]);
  expect(oldDeletes).toEqual([]);
  expect(oldArtifactRequests).toEqual([]);
  await expect(page.locator('.city-switch-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('chat retries a city-mismatched conversation once with the same text @core', async ({ mockApi: page, baseURL }) => {
  const oldPlan = { ...await authoredPlan('Old Ljubljana rule', 'ljubljana'), draftRef: 'https://api.example/mcp/previews/old-ljubljana-rule' };
  const newPlan = await privatePlan(page, baseURL!, 'Fresh Zagreb rule', 'zagreb');
  const oldTurns: any[] = [], newTurns: any[] = [], oldReads: string[] = [], oldDeletes: string[] = [], creates: any[] = [];
  const oldArtifactRequests = watchedPreviewRequests(page, oldPlan.draftRef);
  let oldExists = true;
  await page.route('**/chat/conversations', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    creates.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, contentType: 'application/json', body: asJson({
      id: oldExists ? 'conv-old-mismatch' : 'conv-zg-retry', city: oldExists ? 'ljubljana' : 'zagreb', expiresAt: expiresAt()
    }) });
  });
  await page.route('**/chat/conversations/conv-old-mismatch', async route => {
    if (route.request().method() === 'DELETE') { oldExists = false; oldDeletes.push(route.request().method()); await route.fulfill({ status: 204 }); }
    else if (route.request().method() === 'GET') {
      oldReads.push(route.request().method());
      await route.fulfill({ status: 200, contentType: 'application/json', body: asJson({ id: 'conv-old-mismatch', city: 'ljubljana', expiresAt: expiresAt(), turns: 1, spentUsd: 0.001,
        plan: { draftRef: oldPlan.draftRef, cid: oldPlan.planCid } }) });
    } else await route.fallback();
  });
  await page.route('**/chat/conversations/conv-old-mismatch/turns', async route => {
    oldTurns.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: { code: 'conversation_city_mismatch' } });
  });
  await page.route('**/chat/conversations/conv-zg-retry/turns', async route => {
    newTurns.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: planStream(newPlan, newPlan.design.title) });
  });
  await boot(page);
  await saveConversationPointer(page, { id: 'conv-old-mismatch', city: 'zagreb', expiresAt: expiresAt() });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  const chat = await submitByKeyboard(page, 'Create a fresh Zagreb building rule');
  await expect(chat.sheet.getByText('Fresh Zagreb rule is ready.')).toBeVisible();
  await expectApplied(page, 'Fresh Zagreb rule');

  expect(oldTurns).toHaveLength(1);
  expect(newTurns).toHaveLength(1);
  expect(oldTurns[0].text).toBe('Create a fresh Zagreb building rule');
  expect(newTurns[0].text).toBe(oldTurns[0].text);
  expect(creates).toEqual([expect.objectContaining({ city: 'zagreb' }), expect.objectContaining({ city: 'zagreb' })]);
  expect(oldReads).toEqual([]);
  expect(oldDeletes).toEqual(['DELETE']);
  expect(oldArtifactRequests).toEqual([]);
  await expect(page.locator('.city-switch-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('chat does not apply a foreign plan returned while recovering an unrelated stream error @core', async ({ mockApi: page, baseURL }) => {
  const oldPlan = await privatePlan(page, baseURL!, 'Saved Ljubljana rule', 'ljubljana');
  const turns: any[] = [], reads: string[] = [], deletes: string[] = [];
  await page.route('**/chat/conversations/conv-zg-stream', async route => {
    if (route.request().method() === 'DELETE') { deletes.push(route.request().method()); await route.fulfill({ status: 204 }); }
    else if (route.request().method() === 'GET') {
      reads.push(route.request().method());
      await route.fulfill({ status: 200, contentType: 'application/json', body: asJson({ id: 'conv-zg-stream', city: 'ljubljana', expiresAt: expiresAt(), turns: 1, spentUsd: 0.001,
        plan: { draftRef: oldPlan.draftRef, cid: oldPlan.planCid } }) });
    } else await route.fallback();
  });
  await page.route('**/chat/conversations/conv-zg-stream/turns', async route => {
    turns.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: { code: 'turn_interrupted' } });
  });
  const oldArtifactRequests = watchedPreviewRequests(page, oldPlan.draftRef);

  await boot(page);
  await saveConversationPointer(page, { id: 'conv-zg-stream', city: 'zagreb', expiresAt: expiresAt() });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  const chat = await submitByKeyboard(page, 'Describe this Zagreb city rule');
  await expect.poll(() => page.evaluate(() => (window as any).ChatPanel.state().error?.code)).toBe('turn_interrupted');
  await expect.poll(() => page.evaluate(() => (window as any).ChatPanel.state().conversation?.city)).toBe('zagreb');
  await expect.poll(() => page.evaluate(() => (window as any).ChatPanel.state().lastPlan)).toBeNull();

  expect(turns).toHaveLength(1);
  expect(turns[0].text).toBe('Describe this Zagreb city rule');
  expect(reads).toEqual(['GET']);
  expect(deletes).toEqual([]);
  expect(oldArtifactRequests).toEqual([]);
  await expect(page.locator('.city-switch-dialog')).toHaveCount(0);
  await expect(chat.sheet.getByText('Saved Ljubljana rule is ready.')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
