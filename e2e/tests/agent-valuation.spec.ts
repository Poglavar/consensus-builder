import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID } from '../helpers/runtime';

test('modeled totals require known land value and keep their ETH denomination', async ({ mockApi: page }) => {
  await openCity(page);
  const id = await page.evaluate(async parcelId => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    const agent = w.createAgent();
    agent.name = 'Valuation preview';
    agent.ethBalance = 100;
    w.agentStorage.addAgent(agent);
    w.agentDialogTempOwnership[agent.id] = [parcelId];
    w.ethUsdEstimate = 4000;
    // Exercise the dialog's handling of an unavailable calculation and a different active chain.
    w.calculatePortfolioValue = async () => NaN;
    w.getChainCurrencySymbol = () => 'SOL';
    await w.showAgentDialog(agent.id);
    return agent.id;
  }, PARCEL_ID);
  const dialog = page.locator('.agent-dialog-modal');
  await expect(dialog.locator('[data-agent-portfolio-value]')).toHaveText('-');
  await expect(dialog.locator('[data-agent-total-wealth]')).toHaveAttribute('data-portfolio-value', '');
  await expect(dialog.locator('[data-agent-total-wealth]')).toHaveText('-');
  await expect(dialog.locator('[data-agent-portfolio-basis]')).toHaveText('Land model: USD 200/m², converted at USD 4000 per ETH.');
  await expect(dialog).toContainText('Modeled land value');
  await expect(dialog).toContainText('Modeled total');

  await dialog.locator('.agent-dialog-modal-close').click();
  await page.evaluate(async agentId => {
    const w = window as any;
    w.calculatePortfolioValue = async () => 17;
    await w.showAgentDialog(agentId);
  }, id);
  await expect(dialog.locator('[data-agent-portfolio-value]')).toContainText('17');
  await expect(dialog.locator('[data-agent-portfolio-value]')).toContainText('ETH');
  await expect(dialog.locator('[data-agent-portfolio-value]')).not.toContainText('SOL');
  await expect(dialog.locator('[data-agent-total-wealth]')).toContainText('117');
  await expect(dialog.locator('[data-agent-total-wealth]')).toContainText('ETH');
});
