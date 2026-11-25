// A contest on a government plan plot with no cadastral parcel (state land in a general plan) is named
// by its plot in the Bets sheet, not as open ground (markets/contests.js planPlots, bets-sheet landText).
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';
import { fileIndexedAgreement, OPEN_POOL, selectDevnetUsdc } from '../helpers/agreements';

test('a contest standing on a plan plot is named by its plot @features', async ({ mockApi: page }) => {
  await selectDevnetUsdc(page);
  // A minted round on plan plot 4411, as the index lists it: no input parcel, one plot from its design.
  fileIndexedAgreement(pageIndex(page), { title: 'Courtyard round', designTitles: ['Courtyard'], minted: { status: 'active' }, pool: OPEN_POOL,
    row: { inputParcelIds: [], planPlots: [{ source: 'alatau-genplan-727', recordId: '4411' }] } });
  await openCity(page);
  await page.locator('#bets-button').click();
  const land = page.locator('#bets-sheet-content .bets-contest__land').first();
  await expect(land).toContainText('Plan plot 4411', { timeout: 30_000 });
  await expect(land).toHaveAttribute('title', '4411');
});
