// Check agreement badges and available actions against deterministic index and chain states.
import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { proposeOverPark, MINTED_SPONSOR } from '../helpers/agreements';
import { pageIndex, E2E_LENS_MEMBER_KEY } from '../helpers/mocks/shared-server';
import { agreementAccountAddress, encodeAgreementAccount, serveAgreementAccounts, STATUS, DECISION } from '../helpers/agreement-chain';

test('agreement summary follows terminal index and account states without offering another bet', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  const accounts = new Map<string, Buffer>();
  await serveAgreementAccounts(page, accounts);
  await openCity(page);
  const { id, cid } = await proposeOverPark(page, { title: 'Lifecycle fixture', minted: { sponsor: MINTED_SPONSOR, status: 'active' } });
  const account = agreementAccountAddress(cid, MINTED_SPONSOR);
  const row = pageIndex(page).agreements.get(cid)!;
  row.onchain.account = account;
  await page.evaluate(({ id, onchain }) => (window as any).AgreementSync.adoptOnchain(id, onchain), { id, onchain: row.onchain });
  for (const status of ['active', 'executed', 'cancelled', 'expired'] as const) {
    row.onchain.status = status;
    accounts.set(account, encodeAgreementAccount({ cid, authority: MINTED_SPONSOR, payout: MINTED_SPONSOR, lens: E2E_LENS_MEMBER_KEY,
      status: STATUS[status], decision: status === 'executed' ? DECISION.satisfied : DECISION.pending }));
    await page.evaluate(id => (window as any).AgreementPanel.open(id), id);
    const panel = page.locator('#agreement-panel');
    await expect(panel.locator('[data-agreement-chain-status]')).toHaveText(status[0].toUpperCase() + status.slice(1));
    await expect(panel.locator('[data-agreement-remote-status]')).toHaveText(status[0].toUpperCase() + status.slice(1));
    if (status !== 'active') await expect(panel.locator('[data-agreement-action="bet"], [data-approval-action="verify"]')).toHaveCount(0);
    await panel.locator('[data-agreement-action="close"]').click();
  }
  // The account is newer than the index: Active in the cached row cannot mask Executed.
  row.onchain.status = 'active';
  accounts.set(account, encodeAgreementAccount({ cid, authority: MINTED_SPONSOR, payout: MINTED_SPONSOR, lens: E2E_LENS_MEMBER_KEY,
    status: STATUS.executed, decision: DECISION.satisfied }));
  await page.evaluate(id => (window as any).AgreementPanel.open(id), id);
  await expect(page.locator('#agreement-panel [data-agreement-remote-status]')).toHaveText('Executed');
});
