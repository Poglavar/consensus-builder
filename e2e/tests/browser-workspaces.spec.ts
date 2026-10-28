import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';

for (const width of [390, 1280]) test(`a duplicate tab waits for the owner and resumes the same saved workspace at ${width}px`, async ({ mockApi: owner, context }, testInfo) => {
  test.setTimeout(90_000);
  await owner.setViewportSize({ width, height: 844 });
  await stubBasemapTiles(owner);
  await openCity(owner);
  const saved = await owner.evaluate(async () => {
    const w = window as any;
    const draft = w.proposalDraftStore.createDraft({ goal: 'park', fields: { name: 'Saved garden' } });
    await w.PersistentStorage.atomicWrite({ puts: { workspaceProbe: 'saved' } });
    return { workspace: w.BrowserWorkspace.id, draft: draft.id };
  });

  const duplicate = await context.newPage();
  try {
    await duplicate.setViewportSize({ width, height: 844 });
    await mockAllApiRoutes(duplicate);
    await stubBasemapTiles(duplicate);
    const incomingUrl = '/?city=zg&reduceMotion=1';
    await duplicate.goto(incomingUrl, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => duplicate.evaluate(() => (window as any).BrowserWorkspace?.status)).toBe('blocked');
    const screen = duplicate.locator('#workspace-screen');
    await expect(screen).toBeVisible();
    await expect(screen.getByRole('heading', { name: 'Already open in another tab' })).toBeVisible();
    // One plain screen: it covers the whole viewport and carries only the title and Try again.
    expect(await screen.boundingBox()).toEqual({ x: 0, y: 0, width, height: 844 });
    await expect(screen.locator('p')).toHaveCount(0);
    await duplicate.screenshot({ path: testInfo.outputPath('workspace-blocked.png') });
    const retry = screen.getByRole('button', { name: 'Try again' });
    await expect(retry).toHaveAttribute('id', 'workspace-retry');
    expect(new URL(duplicate.url()).pathname + new URL(duplicate.url()).search).toBe(incomingUrl);
    await expect(duplicate.locator('#proposal-details-panel')).toBeHidden();
    expect(await owner.evaluate(() => ({
      value: (window as any).PersistentStorage.getItem('workspaceProbe'),
      draft: (window as any).proposalDraftStore.getActiveDraft()?.fields.name,
    }))).toEqual({ value: 'saved', draft: 'Saved garden' });

    // Closing the owner releases its profile workspace. The blocked page reloads at the same URL
    // and resumes the saved workspace with its existing ID and state.
    await owner.close();
    await retry.click();
    await expect.poll(() => duplicate.evaluate(() => (window as any).BrowserWorkspace?.status)).toBe('ready');
    await waitForMapReady(duplicate);
    expect(await duplicate.evaluate(() => ({
      workspace: (window as any).BrowserWorkspace.id,
      value: (window as any).PersistentStorage.getItem('workspaceProbe'),
      draft: (window as any).proposalDraftStore.getActiveDraft()?.fields.name,
    }))).toEqual({ workspace: saved.workspace, value: 'saved', draft: 'Saved garden' });
    expect(new URL(duplicate.url()).pathname).toBe('/');

    await duplicate.reload({ waitUntil: 'domcontentloaded' });
    await waitForMapReady(duplicate);
    expect(await duplicate.evaluate(() => (window as any).BrowserWorkspace.id)).toBe(saved.workspace);
    expect(await duplicate.evaluate(() => (window as any).proposalDraftStore.getActiveDraft()?.fields.name)).toBe('Saved garden');
  } finally { await duplicate.close(); }
});

test('closing a blocked tab cannot overwrite the owner; a fresh tab reopens the same saved workspace', async ({ mockApi: owner, context }) => {
  test.setTimeout(90_000);
  await stubBasemapTiles(owner);
  await openCity(owner);
  const saved = await owner.evaluate(async () => {
    const w = window as any;
    const draft = w.proposalDraftStore.createDraft({ goal: 'park', fields: { name: 'Initial garden' } });
    await w.PersistentStorage.atomicWrite({ puts: { workspaceProbe: 'initial' } });
    return { workspace: w.BrowserWorkspace.id, draft: draft.id };
  });

  const blocked = await context.newPage();
  await mockAllApiRoutes(blocked);
  await stubBasemapTiles(blocked);
  await blocked.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => blocked.evaluate(() => (window as any).BrowserWorkspace?.status)).toBe('blocked');
  await expect(blocked.locator('#workspace-screen')).toBeVisible();

  await owner.evaluate(async ({ draftId }) => {
    const w = window as any;
    w.proposalDraftStore.updateDraft(draftId, { fields: { name: 'Latest garden' } });
    await w.PersistentStorage.atomicWrite({ puts: { workspaceProbe: 'latest' } });
  }, { draftId: saved.draft });
  await blocked.close();
  expect(await owner.evaluate(draftId => ({
    workspace: (window as any).BrowserWorkspace.id,
    draft: (window as any).proposalDraftStore.getDraft(draftId)?.fields.name,
    probe: (window as any).PersistentStorage.getItem('workspaceProbe'),
  }), saved.draft)).toEqual({ workspace: saved.workspace, draft: 'Latest garden', probe: 'latest' });

  await owner.close();
  const reopened = await context.newPage();
  try {
    await mockAllApiRoutes(reopened);
    await stubBasemapTiles(reopened);
    await reopened.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => reopened.evaluate(() => (window as any).BrowserWorkspace?.status)).toBe('ready');
    await waitForMapReady(reopened);
    expect(await reopened.evaluate(draftId => ({
      workspace: (window as any).BrowserWorkspace.id,
      draft: (window as any).proposalDraftStore.getActiveDraft()?.fields.name,
      probe: (window as any).PersistentStorage.getItem('workspaceProbe'),
    }), saved.draft)).toEqual({ workspace: saved.workspace, draft: 'Latest garden', probe: 'latest' });
  } finally { await reopened.close(); }
});
