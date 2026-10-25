// Verify independent durable workspaces for tabs of the same city.
import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity, showProposal } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';

test.describe('Supporting tertiary controls @core', () => {
  test('same-city tabs remain editable, isolated, and durable across reload', async ({ mockApi: first, context }) => {
    test.setTimeout(90_000);
    await openCity(first);
    const firstId = await createSpace(first, 'park');
    await first.evaluate(id => {
      const record = (window as any).proposalStorage.getProposal(id);
      record.title = 'First tab park';
      return (window as any).proposalStorage.save();
    }, firstId);

    const second = await context.newPage();
    await mockAllApiRoutes(second);
    await second.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
    await waitForMapReady(second);
    await expect(second.locator('#cb-multitab-banner')).toHaveCount(0);

    expect(await second.evaluate(id => (window as any).proposalStorage.getProposal(id)?.title, firstId)).toBe('First tab park');
    await showProposal(second, firstId);
    await second.locator(`#proposal-action-btn-${firstId}`).click();
    await expect.poll(() => second.evaluate(id => (window as any).isApplied((window as any).proposalStorage.getProposal(id)), firstId)).toBe(false);
    await createSpace(second, 'park');
    const secondId = await second.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.applied && p.structureProposal?.kind === 'park').proposalId);
    await second.evaluate(id => {
      const record = (window as any).proposalStorage.getProposal(id);
      record.title = 'Second tab park';
      return (window as any).proposalStorage.save();
    }, secondId);
    const hasTitle = (page: import('@playwright/test').Page, title: string) => page.evaluate(value =>
      (window as any).proposalStorage.getAllProposals().some((p: any) => p.title === value), title);
    expect(await hasTitle(second, 'Second tab park')).toBe(true);
    expect(await hasTitle(first, 'Second tab park')).toBe(false);
    expect(await hasTitle(second, 'First tab park')).toBe(true);
    expect(await first.evaluate(id => (window as any).isApplied((window as any).proposalStorage.getProposal(id)), firstId)).toBe(true);

    await second.reload();
    await waitForMapReady(second);
    await expect(second.locator('#cb-multitab-banner')).toHaveCount(0);
    expect(await hasTitle(second, 'Second tab park')).toBe(true);
  });
});
