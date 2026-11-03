// Chat help must preserve the open parcel editor through replies, failures and returning to save.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID, stubBasemapTiles } from '../helpers/runtime';
import { selectors } from '../helpers/selectors';

const editorTip = 'Explain the tool I have open and how to use its options.';
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
const doneEvent = (turns: number) => `event: done\ndata: ${JSON.stringify({ turns, conversationSpentUsd: turns / 1000 })}\n\n`;

async function openEditedParcelLayout(page: any) {
  await openCity(page, PARCEL_ID);
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--parcel-layout').click();
  const modal = page.locator('.on-map-reparcellization');
  await expect(modal.locator('[data-reparcel-plots-tab="editing"]')).toHaveAttribute('aria-selected', 'true');

  const equal = modal.locator('input[name="reparcel-algorithm"][value="equal"]');
  if (!(await equal.isChecked())) await modal.locator('label.reparcel-alg-option:has(input[value="equal"])').click();
  const count = modal.locator('[data-parcel-layout-count]');
  await count.fill('3');
  await count.press('Tab');
  await expect(count).toHaveValue('3');
  await expect(modal.locator('[data-reparcel-newplots-table] .reparcel-newplot-row')).toHaveCount(3);

  const nodes = modal.locator('[data-reparcel-nodes]');
  if (await nodes.getAttribute('aria-pressed') !== 'true') await nodes.click();
  await expect(nodes).toHaveAttribute('aria-pressed', 'true');
  await expect(modal.locator('[data-reparcel-undo-edit]')).toBeEnabled();
  return modal;
}

async function openChatByKeyboard(page: any) {
  const button = page.getByRole('button', { name: 'Ask Mechaurbanista' });
  await button.focus();
  await page.keyboard.press('Enter');
  const sheet = page.locator(selectors.chatSheet);
  await expect(sheet).toBeVisible();
  const tips = sheet.locator('details.chat-tips');
  await tips.locator('summary').focus();
  await page.keyboard.press('Enter');
  const tip = sheet.getByRole('button', { name: editorTip, exact: true });
  await tip.focus();
  await page.keyboard.press('Enter');
  const composer = sheet.locator('.chat-input');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(editorTip);
  return { sheet, composer };
}

for (const [viewport, width] of [['desktop', 1280], ['360px', 360]] as const) {
  test(`chat explains the open parcel-layout editor at ${viewport} and preserves its draft @core`, async ({ mockApi: page }, testInfo) => {
    await stubBasemapTiles(page);
    await page.setViewportSize({ width, height: 820 });
    const turns: any[] = [];
    await page.route('**/chat/conversations', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        id: `editor-help-${width}`, city: route.request().postDataJSON().city, expiresAt: expiresAt()
      }) });
    });
    await page.route(`**/chat/conversations/editor-help-${width}/turns`, async route => {
      turns.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body:
        `event: reply\ndata: ${JSON.stringify({ text: 'The open editor divides the parcel into three equal plots. Use the node controls to edit their boundaries.' })}\n\n${doneEvent(1)}` });
    });

    const modal = await openEditedParcelLayout(page);
    const { sheet, composer } = await openChatByKeyboard(page);
    await composer.press('Enter');
    const reply = 'The open editor divides the parcel into three equal plots. Use the node controls to edit their boundaries.';
    await expect(sheet.getByText(reply)).toBeVisible();
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe(editorTip);
    expect(turns[0].context.activeEditor).toEqual({
      kind: 'parcel-layout', tab: 'editing', algorithm: 'equal', plotCount: 3, dirty: true, drawing: 'nodes'
    });
    await page.screenshot({ path: testInfo.outputPath('contextual-chat.png'), fullPage: true });

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
    await expect(modal.locator('[data-parcel-layout-count]')).toHaveValue('3');
    await expect(modal.locator('[data-reparcel-undo-edit]')).toBeEnabled();
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled();
    await modal.locator('[data-reparcel-commit]').click();
    await expect(modal).toHaveCount(0);
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout')?.parcelLayout);
    expect(saved.algorithm).toBe('equal');
    expect(saved.plotCount).toBe(3);
    expect(saved.plots).toHaveLength(3);
  });
}

test('chat ignores stale navigation and plan events while parcel layout is open, including stream recovery @core', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  const turns: any[] = [];
  let recoveryReads = 0;
  await page.route('**/chat/conversations', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
      id: 'editor-stale-events', city: route.request().postDataJSON().city, expiresAt: expiresAt()
    }) });
  });
  await page.route('**/chat/conversations/editor-stale-events/turns', async route => {
    turns.push(route.request().postDataJSON());
    if (turns.length > 1) return route.fulfill({ status: 503, json: { code: 'editor_stream_failed' } });
    const stalePlan = { draftRef: 'draft-from-stale-stream', cid: 'stale-plan-cid', changes: [] };
    const events = [
      `event: plan\ndata: ${JSON.stringify(stalePlan)}`,
      'event: view\ndata: {"view":{"mode":"2d","at":"44.00000,16.00000,8"}}',
      'event: selection\ndata: {"selection":{"active":true,"parcelIds":["HR-FOREIGN-1"]}}',
      `event: reply\ndata: ${JSON.stringify({ text: 'I will leave the open editor and its draft untouched.' })}`,
      doneEvent(1).trimEnd()
    ].join('\n\n') + '\n\n';
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: events });
  });
  await page.route('**/chat/conversations/editor-stale-events', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    recoveryReads += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: 'editor-stale-events', city: turns[0].context.city, expiresAt: expiresAt(), turns: 1, spentUsd: 0.001,
      plan: { draftRef: 'draft-from-failed-stream-recovery', cid: 'recovered-foreign-plan' }
    }) });
  });

  const modal = await openEditedParcelLayout(page);
  await page.getByRole('button', { name: 'Ask Mechaurbanista' }).click();
  const sheet = page.locator(selectors.chatSheet);
  const composer = sheet.locator('.chat-input');
  await expect(composer).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.__editorChatCalls = { draftLoad: 0, navigationApply: 0 };
    const load = w.DraftLink.load.bind(w.DraftLink);
    w.DraftLink.load = (...args: any[]) => { w.__editorChatCalls.draftLoad += 1; return load(...args); };
    const navigation = w.ChatNavigation;
    w.ChatNavigation = { ...navigation, apply: (...args: any[]) => {
      w.__editorChatCalls.navigationApply += 1; return navigation.apply(...args);
    } };
  });
  await composer.fill('Explain the current layout');
  await composer.press('Enter');
  await expect(sheet.getByText('I will leave the open editor and its draft untouched.')).toBeVisible();
  expect(turns[0].context.activeEditor).toEqual({
    kind: 'parcel-layout', tab: 'editing', algorithm: 'equal', plotCount: 3, dirty: true, drawing: 'nodes'
  });
  expect(await page.evaluate(() => (window as any).__editorChatCalls)).toEqual({ draftLoad: 0, navigationApply: 0 });
  await expect(modal.locator('[data-parcel-layout-count]')).toHaveValue('3');
  await expect(modal.locator('[data-reparcel-undo-edit]')).toBeEnabled();

  await composer.fill('Try again after the stream failure');
  await composer.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).ChatPanel.state().error?.code)).toBe('editor_stream_failed');
  expect(recoveryReads).toBe(1);
  expect(turns).toHaveLength(2);
  expect(await page.evaluate(() => (window as any).__editorChatCalls)).toEqual({ draftLoad: 0, navigationApply: 0 });
  await expect(modal.locator('[data-parcel-layout-count]')).toHaveValue('3');
  await expect(modal.locator('[data-reparcel-undo-edit]')).toBeEnabled();
  expect(await page.evaluate(() => (window as any).getParcelLayoutEditorContext())).toMatchObject({
    kind: 'parcel-layout', tab: 'editing', algorithm: 'equal', plotCount: 3, dirty: true, drawing: 'nodes'
  });
});
