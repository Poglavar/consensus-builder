// A city change does not open a second editable map in the same browser profile.
import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity, stubBasemapTiles } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';

test.describe('Supporting tertiary controls @core', () => {
  test('a different-city tab stays blocked until the profile workspace owner closes', async ({ mockApi: owner, context }) => {
    test.setTimeout(90_000);
    await stubBasemapTiles(owner);
    await openCity(owner);
    const proposalId = await createSpace(owner, 'park');
    const saved = await owner.evaluate(async id => {
      const w = window as any;
      const record = w.proposalStorage.getProposal(id);
      record.title = 'Saved Zagreb park';
      await w.proposalStorage.save();
      const draft = w.proposalDraftStore.createDraft({ goal: 'park', fields: { name: 'Saved agreement draft' } });
      await w.PersistentStorage.atomicWrite({ puts: { workspaceProbe: 'owner-data' } });
      return { workspace: w.BrowserWorkspace.id, draftId: draft.id };
    }, proposalId);
    const workspace = saved.workspace;

    const newYork = await context.newPage();
    try {
      await mockAllApiRoutes(newYork);
      await stubBasemapTiles(newYork);
      const incomingUrl = '/?city=new_york&reduceMotion=1';
      await newYork.goto(incomingUrl, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => newYork.evaluate(() => (window as any).BrowserWorkspace?.status)).toBe('blocked');
      const screen = newYork.locator('#workspace-screen');
      await expect(screen).toBeVisible();
      await expect(screen.getByRole('heading', { name: 'Already open in another tab' })).toBeVisible();
      await expect(screen.getByRole('button', { name: 'Try again' })).toHaveAttribute('id', 'workspace-retry');
      expect(new URL(newYork.url()).pathname + new URL(newYork.url()).search).toBe(incomingUrl);
      await expect(newYork.locator('#proposal-details-panel')).toBeHidden();
      expect(await owner.evaluate(({ proposalId, draftId }) => ({
        probe: (window as any).PersistentStorage.getItem('workspaceProbe'),
        title: (window as any).proposalStorage.getProposal(proposalId)?.title,
        draft: (window as any).proposalDraftStore.getDraft(draftId)?.fields.name,
      }), { proposalId, draftId: saved.draftId })).toEqual({ probe: 'owner-data', title: 'Saved Zagreb park', draft: 'Saved agreement draft' });

      await owner.close();
      await newYork.locator('#workspace-retry').click();
      await expect.poll(() => newYork.evaluate(() => (window as any).BrowserWorkspace?.status)).toBe('ready');
      await waitForMapReady(newYork);
      expect(await newYork.evaluate(() => ({
        workspace: (window as any).BrowserWorkspace.id,
        city: (window as any).CityConfigManager.getCurrentCityId(),
        draft: (window as any).proposalDraftStore.getActiveDraft()?.fields.name,
        probe: (window as any).PersistentStorage.getItem('workspaceProbe'),
        proposalCount: (window as any).proposalStorage.getAllProposals().length,
      }))).toEqual({
        workspace, city: 'new_york', draft: 'Saved agreement draft', probe: null, proposalCount: 0
      });

      // The profile draft is global; authored plans and IndexedDB rows remain partitioned by city.
      await newYork.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
      await waitForMapReady(newYork);
      expect(await newYork.evaluate(id => ({
        workspace: (window as any).BrowserWorkspace.id,
        city: (window as any).CityConfigManager.getCurrentCityId(),
        proposal: (window as any).proposalStorage.getProposal(id)?.title,
        draft: (window as any).proposalDraftStore.getActiveDraft()?.fields.name,
        probe: (window as any).PersistentStorage.getItem('workspaceProbe'),
      }), proposalId)).toEqual({
        workspace, city: 'zagreb', proposal: 'Saved Zagreb park', draft: 'Saved agreement draft', probe: 'owner-data'
      });
    } finally { await newYork.close(); }
  });
});
