import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles, PARCEL_GEOMETRY } from '../helpers/runtime';
import { selectors } from '../helpers/selectors';
import { privatePreview } from '../helpers/private-preview';
const builder = require('../../frontend/js/intent-design.js');
const planRecord = require('../../frontend/js/plan-record.js');
const cid = require('../../frontend/js/cid.js');
const turf = require('../../backend/node_modules/@turf/turf');

test('chat panel sends a turn and announces the streamed reply @core', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await page.setViewportSize({ width: 360, height: 800 });
  const sent: any[] = [];
  let turn = 0;
  await page.route('**/chat/conversations', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'conv-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }) });
  });
  await page.route('**/chat/conversations/conv-1/turns', async route => {
    sent.push(route.request().postDataJSON()); turn += 1;
    const body = turn === 1
      ? 'event: step\ndata: {"tool":"ugt_inspect_plan"}\n\nevent: question\ndata: {"text":"Which direction?","options":[{"label":"Move it north","ref":"design:bafybeigdyrzt5sfp7udm7hu76uh7y26nf3rj6g5z4q3f7zq4xw2gq2l5ty"}]}\n\nevent: done\ndata: {"turnCostUsd":0.0004,"conversationSpentUsd":0.0004,"turns":1}\n\n'
      : 'event: reply\ndata: {"text":"I updated the working plan."}\n\nevent: done\ndata: {"turnCostUsd":0.0012,"conversationSpentUsd":0.0016,"turns":2}\n\n';
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.locator(selectors.chatButton).click();
  await page.evaluate(() => { (window as any).selectedProposal = { selectedBuildingIndex: 2 }; });
  const sheet = page.locator(selectors.chatSheet);
  await expect(sheet).toBeVisible();
  const composer = sheet.getByRole('textbox', { name: 'What would you like to change?' });
  await composer.fill('Add a park');
  await composer.press('Enter');
  await expect(sheet.getByText('Which direction?')).toBeVisible();
  const steps = sheet.locator('.chat-steps');
  await steps.locator('summary').click();
  await expect(steps).toHaveAttribute('open', '');
  const option = sheet.getByRole('button', { name: 'Move it north' });
  await option.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('i18n:translationsLoaded')));
  await expect(option).toBeFocused();
  await option.click();
  await expect(sheet.getByText('I updated the working plan.')).toBeVisible();
  await expect(steps).toHaveAttribute('open', '');
  await expect(composer).toBeFocused();
  expect(sent[0].text).toBe('Add a park');
  expect(sent[1].text).toBe('Move it north');
  expect(sent[0].context.city).toBeTruthy();
  expect(sent[0].context.selection.buildingIndex).toBe(2);
  await expect(sheet.locator('.chat-cost')).toContainText('0.0016');
  await expect(sheet.getByRole('button', { name: 'New conversation' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('chat applies a private plan revision and undo removes its first draft @core', async ({ mockApi: page, baseURL }) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  page.on('pageerror', error => console.error(`[chat-panel pageerror] ${error.stack || error.message}`));
  const design = builder.build({ kind: 'space', spaceKind: 'park', site: PARCEL_GEOMETRY, city: 'zg', title: 'Chat park', authoredAt: '2026-10-23T00:00:00.000Z' }, { turf });
  const designCid = cid.cidOfObject(design);
  const planContent = planRecord.create('Chat working plan', [designCid], { at: '45.80025,15.9817,18', mode: '2d', city: 'zg', language: 'en' });
  const planCid = cid.cidOfObject(planContent);
  const previewUrl = await privatePreview(page, baseURL!, { plan: planContent, designs: [design] });
  const draftRef = new URL(previewUrl).searchParams.get('draft');
  let turnCount = 0;
  await page.route('**/chat/conversations', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'conv-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }) });
  });
  await page.route('**/chat/conversations/conv-1/turns', async route => {
    turnCount += 1;
    const events = [
      `event: plan\ndata: ${JSON.stringify({ draftRef, cid: planCid, changes: [{ beforeCid: null, afterCid: planCid }] })}`,
      'event: reply\ndata: {"text":"The park is ready."}',
      'event: done\ndata: {"turnCostUsd":0.001,"conversationSpentUsd":0.001,"turns":1}'
    ].join('\n\n') + '\n\n';
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: events });
  });
  await page.route('**/chat/conversations/conv-1/undo', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ draftRef: null, cid: null }) });
  });
  await page.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.locator(selectors.chatButton).click();
  const sheet = page.locator(selectors.chatSheet);
  await expect(sheet.getByRole('textbox')).toBeVisible();
  const composer = sheet.getByRole('textbox');
  await composer.fill('Add a park');
  await composer.press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const record = (window as any).proposalStorage?.getAllProposals?.().find((item: any) => item.title === 'Chat park');
    const chat = (window as any).ChatPanel?.state?.();
    return { applied: record?.applied === true, planError: chat?.lastPlan?.error, stateError: chat?.error, messages: chat?.messages?.map((message: any) => ({ role: message.role, code: message.code, text: message.text })) };
  }), { timeout: 25_000 }).toMatchObject({ applied: true });
  await sheet.getByRole('button', { name: 'Undo last change' }).click();
  await expect.poll(() => page.evaluate(() => {
    const record = (window as any).proposalStorage?.getAllProposals?.().find((item: any) => item.title === 'Chat park');
    return record?.applied === true;
  }), { timeout: 60_000 }).toBe(false);
  expect(turnCount).toBe(1);
});
