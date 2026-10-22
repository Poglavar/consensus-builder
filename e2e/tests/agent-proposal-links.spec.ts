// Exercise a profile's design links: each names one exact local key, an unloaded key says so, and a
// loaded one opens its own record, never a colliding one. Designs are not minted, so the profile lists
// no chain records and no accepted designs (plan-design-agreement.md, M3).
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID } from '../helpers/runtime';

test('profile design links open the exact local record they name and say when a record is not here', async ({ mockApi: page }) => {
  await openCity(page);
  const ids = await page.evaluate(async parcelId => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    const draftId = w.proposalStorage.addProposal({ proposalId: '77', title: 'Numeric local draft', cadastreParcelIds: [parcelId], lifecycleStatus: 'Active' });
    // A record whose title and content resemble the draft's, under another key: a link to '77' must not open it.
    const otherId = w.proposalStorage.addProposal({ proposalId: 'p-777', title: 'Numeric local draft (copy)', cadastreParcelIds: [parcelId], lifecycleStatus: 'Active' });
    const agent = w.createAgent(); agent.name = 'Proposal link preview'; agent.userControlled = true; agent.proposalsCreated = [draftId, '88'];
    w.agentStorage.addAgent(agent);
    w.__profileFocused = [];
    w.selectAndHighlightProposal = (id: string) => w.__profileFocused.push(id);
    await w.showAgentDialog(agent.id);
    return { agent: agent.id, draftId, otherId };
  }, PARCEL_ID);
  const dialog = page.locator('.agent-dialog-modal');
  const created = dialog.locator('[data-list-type="created"]');
  const items = created.locator('.agent-dialog-proposal-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Numeric local draft (Local ID 77)');
  await expect(items.nth(1)).toContainText('Local proposal record unavailable');
  await expect(items.nth(1)).toContainText('Local ID 88');
  await expect(created).not.toContainText('(copy)');
  // Only the designs the profile created: no accepted or pending lists any more.
  await expect(dialog.locator('[data-list-type="accepted"], [data-list-type="pending"]')).toHaveCount(0);

  // The unavailable key offers nothing to open; the loaded one opens exactly its own record.
  await items.nth(1).click();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).__profileFocused)).toEqual([]);
  await items.nth(0).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__profileFocused)).toEqual([ids.draftId]);
  expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).title, ids.draftId)).toBe('Numeric local draft');
});
