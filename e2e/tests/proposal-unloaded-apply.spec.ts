import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test('direct Apply explains an unloaded proposal without attempting a map mutation', async ({ mockApi: page }) => {
  await page.goto('/?city=new_york&lang=en');
  await waitForMapReady(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    const id = 'unloaded-proposal-regression';
    if (w.proposalStorage.getProposal(id)) throw new Error('Fixture must not be in local proposal storage.');
    const originalApply = w.ProposalManager.applyProposal;
    let calls = 0;
    w.ProposalManager.applyProposal = async () => { calls += 1; return true; };
    try {
      return { applied: await w.applyProposalToMap(id), calls, failure: w.__proposalMapActionFailures[id] };
    } finally { w.ProposalManager.applyProposal = originalApply; }
  });
  expect(result.applied).toBe(false);
  expect(result.calls).toBe(0);
  expect(result.failure).toBe('This design is not loaded in this browser. Open it from the designs list, then try again.');
  await expect(page.locator('#ephemeral-message-container')).toContainText(result.failure);
  await expect(page.locator('#ephemeral-message-container')).not.toContainText('does not support map application');
});
