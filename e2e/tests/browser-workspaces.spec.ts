import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';

for (const width of [390, 1280]) test(`duplicated tabs fork drafts and saved work at ${width}px`, async ({ mockApi: first, context }) => {
  test.setTimeout(90_000);
  await first.setViewportSize({ width, height: 844 });
  await stubBasemapTiles(first);
  await openCity(first);
  const original = await first.evaluate(async () => {
    const w = window as any;
    const draft = w.proposalDraftStore.createDraft({ goal: 'park', fields: { name: 'Original garden' } });
    await w.PersistentStorage.atomicWrite({ puts: { workspaceProbe: 'original' } });
    return { workspace: w.BrowserWorkspace.id, draft: draft.id };
  });
  const duplicate = await context.newPage();
  try {
    await duplicate.setViewportSize({ width, height: 844 });
    await mockAllApiRoutes(duplicate);
    await stubBasemapTiles(duplicate);
    // Browsers duplicate sessionStorage with a tab. Reproduce that inherited identity while the
    // original document holds its Web Lock, without opening a popup over the user's work.
    await duplicate.addInitScript(id => {
      if (!sessionStorage.getItem('cb.workspace.v1')) sessionStorage.setItem('cb.workspace.v1', id);
    }, original.workspace);
    await duplicate.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
    await waitForMapReady(duplicate);
    const forkId = await duplicate.evaluate(() => (window as any).BrowserWorkspace.id);
    expect(forkId).not.toBe(original.workspace);
    const state = (page: typeof first) => page.evaluate(() => {
      const w = window as any;
      return { saved: w.PersistentStorage.getItem('workspaceProbe'), name: w.proposalDraftStore.getActiveDraft()?.fields.name };
    });
    expect(await state(duplicate)).toEqual({ saved: 'original', name: 'Original garden' });
    await duplicate.evaluate(async draftId => {
      const w = window as any;
      w.proposalDraftStore.updateDraft(draftId, { fields: { name: 'Fork garden' } });
      await w.PersistentStorage.atomicWrite({ puts: { workspaceProbe: 'fork' } });
    }, original.draft);
    expect(await state(first)).toEqual({ saved: 'original', name: 'Original garden' });
    await duplicate.reload({ waitUntil: 'domcontentloaded' });
    await waitForMapReady(duplicate);
    expect(await duplicate.evaluate(() => (window as any).BrowserWorkspace.id)).toBe(forkId);
    expect(await state(duplicate)).toEqual({ saved: 'fork', name: 'Fork garden' });
    await first.reload({ waitUntil: 'domcontentloaded' });
    await waitForMapReady(first);
    expect(await first.evaluate(() => (window as any).BrowserWorkspace.id)).toBe(original.workspace);
    expect(await state(first)).toEqual({ saved: 'original', name: 'Original garden' });
    await expect(first.locator('#cb-multitab-banner')).toHaveCount(0);
    await expect(duplicate.locator('#cb-multitab-banner')).toHaveCount(0);
  } finally { await duplicate.close(); }
});
