import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles, PARCEL_GEOMETRY, PARCEL_ID, openCity } from '../helpers/runtime';
import { selectors } from '../helpers/selectors';
import { privatePreview } from '../helpers/private-preview';
const builder = require('../../frontend/js/intent-design.js');
const planRecord = require('../../frontend/js/plan-record.js');
const cid = require('../../frontend/js/cid.js');
const turf = require('../../backend/node_modules/@turf/turf');

test('chat panel sends a turn and announces the streamed reply @core', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
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
      ? 'event: step\ndata: {"tool":"ugt_inspect_plan"}\n\nevent: question\ndata: {"text":"Which direction?","options":[{"label":"Move it north","ref":"design:bafybeigdyrzt5sfp7udm7hu76uh7y26nf3rj6g5z4q3f7zq4xw2gq2l5ty"}]}\n\nevent: done\ndata: {"debugCosts":true,"turnCostUsd":0.0004,"conversationSpentUsd":0.0004,"turns":1}\n\n'
      : 'event: reply\ndata: {"text":"I updated the working plan."}\n\nevent: done\ndata: {"debugCosts":true,"turnCostUsd":0.0012,"conversationSpentUsd":0.0016,"turns":2}\n\n';
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  const openChatButton = page.getByRole('button', { name: 'Ask Mechaurbanista' });
  await expect(openChatButton).toBeVisible();
  await expect(openChatButton).toHaveAttribute('title', 'Ask Mechaurbanista');
  await expect(openChatButton.locator('.fa-robot')).toHaveAttribute('aria-hidden', 'true');
  await openChatButton.click();
  await page.evaluate(() => { (window as any).selectedProposal = { selectedBuildingIndex: 2 }; });
  const sheet = page.locator(selectors.chatSheet);
  await expect(sheet).toBeVisible();
  const chatHeading = sheet.getByRole('heading', { name: 'Ask Mechaurbanista' });
  await expect(chatHeading).toBeVisible();
  await expect(chatHeading.locator('.fa-robot')).toHaveAttribute('aria-hidden', 'true');
  const composer = sheet.locator('.chat-input');
  await composer.fill('Add a park');
  await composer.press('Enter');
  await expect(sheet.getByText('Which direction?')).toBeVisible();
  const steps = sheet.locator('.chat-steps');
  await steps.locator('summary').click();
  await expect(steps).toHaveAttribute('open', '');
  const option = sheet.getByRole('button', { name: 'Move it north' });
  await option.focus();
  await page.evaluate(() => (window as any).i18n.setLanguage('fr', { persist: false }));
  await expect(page.locator(selectors.chatButton)).toHaveAttribute('aria-label', 'Demander à Mechaurbanista');
  await expect(sheet.getByRole('heading', { name: 'Demander à Mechaurbanista' })).toBeVisible();
  await expect(composer).toHaveAttribute('placeholder', 'Que souhaitez-vous modifier ?');
  await expect(option).toBeFocused();
  await option.click();
  await expect(sheet.getByText('I updated the working plan.')).toBeVisible();
  await expect(steps).toHaveAttribute('open', '');
  await expect(composer).toBeFocused();
  expect(sent[0].text).toBe('Add a park');
  expect(sent[1].text).toBe('Move it north');
  expect(sent[0].language).toBe('en');
  expect(sent[1].language).toBe('fr');
  expect(sent[0].context.city).toBeTruthy();
  expect(sent[0].context.selection.buildingIndex).toBe(2);
  await expect(sheet.locator('.chat-cost')).toContainText('0,0016');
  await expect(sheet.locator('.chat-message-cost')).toHaveCount(0);
  const userShade = await sheet.locator('.chat-message--user').first().evaluate(element => getComputedStyle(element).backgroundColor);
  const agentShade = await sheet.locator('.chat-message--agent').last().evaluate(element => getComputedStyle(element).backgroundColor);
  expect(userShade).not.toBe(agentShade);
  const replyCopy = sheet.locator('.chat-message--agent').last().getByRole('button', { name: 'Copier la réponse' });
  await replyCopy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('I updated the working plan.');
  await page.evaluate(() => { const w = window as any; w.__copyText = w.copyTextWithFeedback; w.copyTextWithFeedback = async () => false; });
  await replyCopy.click();
  await expect(sheet.locator('.chat-status')).toHaveText('Impossible de copier le texte.');
  await page.evaluate(() => { const w = window as any; w.copyTextWithFeedback = w.__copyText; delete w.__copyText; });
  await sheet.getByRole('button', { name: 'Copier la conversation' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Vous: Add a park\n\nAgent: Which direction?\nOptions: Move it north\n\nVous: Move it north\n\nAgent: I updated the working plan.');
  await expect(sheet.locator('.chat-status')).toBeEmpty();
  await expect(sheet.getByRole('button', { name: 'Nouvelle conversation' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('chat navigation events begin, add, finish, and replay exact parcel selections @core', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await openCity(page, PARCEL_ID);
  await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.delete('reduceMotion');
    history.replaceState(null, '', url);
    (window as any).__reducedMotion = false;
  });
  const second = 'HR-335754-1235';
  await page.evaluate(async id => (window as any).CadastralParcelRepository.ensureIds([id]), second);
  const sent: any[] = [];
  let turn = 0;
  await page.route('**/chat/conversations', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'nav-conv', expiresAt: new Date(Date.now() + 60_000).toISOString() }) });
  });
  await page.route('**/chat/conversations/nav-conv/turns', async route => {
    const request = route.request().postDataJSON(); sent.push(request); turn += 1;
    const source = request.context.parcelSourceId;
    const view = turn === 1 ? { mode: '2d', at: '45.8003,15.9823,18' } : { mode: '2d', at: '45.80035,15.9824,18' };
    const selection = turn === 1
      ? { parcelSourceId: source, focusParcelId: PARCEL_ID, parcelIds: [], active: true }
      : turn === 2
        ? { parcelSourceId: source, focusParcelId: second, parcelIds: [PARCEL_ID, second], active: true }
        : turn === 3
          ? { parcelSourceId: source, focusParcelId: second, parcelIds: [PARCEL_ID, second], active: false }
          : { parcelSourceId: source, focusParcelId: PARCEL_ID, parcelIds: [PARCEL_ID], active: false };
    const events: string[] = [];
    if (turn === 1) events.push('event: step\ndata: {"tool":"ugt_map_view"}');
    events.push(`event: view\ndata: ${JSON.stringify({ view, ...(turn === 1 ? { parcelIdsVisible: true } : {}) })}`);
    events.push(`event: selection\ndata: ${JSON.stringify({ selection })}`);
    if (turn === 3) events.push(`event: selection\ndata: ${JSON.stringify({ selection })}`);
    events.push(`event: reply\ndata: ${JSON.stringify({ text: turn === 1 ? 'Manual parcel selection is active.' : turn === 2 ? 'Both parcels are selected.' : turn === 3 ? 'Selection is finished.' : 'Selected parcel 1234.' })}`);
    events.push(`event: done\ndata: ${JSON.stringify({ turnCostUsd: 0.001, conversationSpentUsd: turn / 1000, turns: turn })}`);
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: events.join('\n\n') + '\n\n' });
  });
  await page.evaluate(() => {
    const w = window as any;
    w.__chatViewCalls = { set: [], fly: [] };
    const setView = w.map.setView.bind(w.map), flyTo = w.map.flyTo.bind(w.map);
    w.map.setView = (center: unknown, zoom: number, options: unknown) => { w.__chatViewCalls.set.push({ center, zoom, options }); return setView(center, zoom, options); };
    w.map.flyTo = (center: unknown, zoom: number, options: unknown) => { w.__chatViewCalls.fly.push({ center, zoom, options }); return flyTo(center, zoom, options); };
    w.__chatSelectionUpdates = 0;
    const updateUI = w.multiParcelSelection.updateUI.bind(w.multiParcelSelection);
    w.multiParcelSelection.updateUI = () => { w.__chatSelectionUpdates += 1; return updateUI(); };
  });
  await page.locator(selectors.chatButton).click();
  const sheet = page.locator(selectors.chatSheet), composer = sheet.locator('.chat-input');
  await expect(sheet).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await composer.fill('Begin manual parcel selection');
  await composer.press('Enter');
  await expect(sheet.getByText('Manual parcel selection is active.')).toBeVisible();
  expect(sent[0].context.mapContext.parcelSourceId).toBeTruthy();
  expect(sent[0].context.mapContext.display.parcelIds).toBe(false);
  expect(sent[0].context.mapContext.viewBounds).toHaveLength(4);
  expect(sent[0].context.mapContext.visibleParcels).toEqual(expect.arrayContaining([
    expect.objectContaining({ parcelId: PARCEL_ID, label: '1234', point: [expect.any(Number), expect.any(Number)] })
  ]));
  await expect(page.locator('#showParcelNumbers')).toBeChecked();
  await expect(page.locator('.parcel-number-label').filter({ hasText: /^1234$/ })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => ({ active: (window as any).multiParcelSelection.isActive, ids: [...(window as any).multiParcelSelection.selectedParcels], focus: (window as any).ChatNavigation.capture().focusParcelId })))
    .toEqual({ active: true, ids: [], focus: PARCEL_ID });
  expect((await page.evaluate(() => (window as any).__chatViewCalls.set)).at(-1)).toMatchObject({ center: [45.8003, 15.9823], zoom: 18, options: { animate: false } });

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: false }));
  await composer.fill('Add both parcels');
  await composer.press('Enter');
  await expect(sheet.getByText('Both parcels are selected.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort())).toEqual([PARCEL_ID, second].sort());
  expect((await page.evaluate(() => (window as any).__chatViewCalls.fly)).at(-1)).toMatchObject({ center: [45.80035, 15.9824], zoom: 18, options: { animate: true, duration: 0.65 } });

  await composer.fill('Finish selection');
  await composer.press('Enter');
  await expect(sheet.getByText('Selection is finished.')).toBeVisible();
  await expect(sheet.locator('.chat-cost')).toBeHidden();
  await expect.poll(() => page.evaluate(() => ({ active: (window as any).multiParcelSelection.isActive, ids: [...(window as any).multiParcelSelection.selectedParcels].sort() })))
    .toEqual({ active: false, ids: [PARCEL_ID, second].sort() });
  const updates = await page.evaluate(() => (window as any).__chatSelectionUpdates);
  expect(updates).toBe(3);
  await composer.fill('Select parcel 1234');
  await composer.press('Enter');
  await expect(sheet.getByText('Selected parcel 1234.')).toBeVisible();
  expect(sent[3].context.mapContext.visibleParcels).toEqual(expect.arrayContaining([
    expect.objectContaining({ parcelId: PARCEL_ID, label: '1234' })
  ]));
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels]))
    .toEqual([PARCEL_ID]);
  expect(sent[3].text).toBe('Select parcel 1234');
  expect(sent).toHaveLength(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/private/tmp/chat-navigation-360.png' });
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
