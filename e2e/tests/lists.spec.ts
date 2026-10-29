import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { proposeOverPark } from '../helpers/agreements';

for (const width of [1280, 390]) {
  test(`Lists shares filters, composes and inspects plans, and removes only browser copies at ${width}px`, async ({ mockApi: page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 844 }); await stubBasemapTiles(page); await openCity(page);
    const agreement = await proposeOverPark(page, { title: 'Residents agreement' });
    await page.locator('#proposals-button').click();
    const sheet = page.locator('#proposals-sheet');
    await expect(page.locator('#proposals-button')).toHaveAccessibleName('Lists');
    await expect(sheet.getByRole('tab')).toHaveCount(3);
    await expect(sheet.locator('#lists-controls')).toHaveCount(1);
    await expect(sheet.getByRole('button', { name: 'Import plan file', exact: true })).toBeHidden();
    await expect(sheet.locator('#proposal-list-host .fa-tree')).toBeVisible();
    await expect(sheet.locator('#proposal-list-host .fa-share-nodes')).toBeVisible();
    await expect(sheet.locator('#proposal-list-host .fa-trash-can')).toBeVisible();
    const expectInsets = async () => {
      const insets = await sheet.evaluate(el => {
        const body = el.querySelector('.lists-body')!.getBoundingClientRect();
        return ['#lists-controls', '#lists-actions', '#lists-status', '[role="tabpanel"]:not([hidden])']
          .map(selector => { const rect = el.querySelector(selector)!.getBoundingClientRect();
            return { left: rect.left - body.left, right: body.right - rect.right }; });
      });
      for (const inset of insets) { expect(inset.left).toBeGreaterThanOrEqual(10); expect(inset.right).toBeGreaterThanOrEqual(10); }
    };
    await expectInsets();
    await expect(sheet.locator('input[type=checkbox]')).toHaveCount(0);
    await sheet.locator('#lists-actions').getByRole('button', { name: 'Create plan', exact: true }).click();
    const next = sheet.getByRole('button', { name: 'Continue', exact: true }); await expect(next).toBeDisabled();
    await sheet.locator('#proposal-list-host input[type=checkbox]').check(); await expect(next).toBeEnabled(); await next.click();
    const form = page.locator('.plan-composer'); await expect(form.locator('input[type=checkbox]')).toBeChecked();
    await form.getByLabel('Plan name', { exact: true }).fill('Residents plan');
    await form.getByRole('button', { name: 'Create plan', exact: true }).click();
    await expect(page.locator('#click-stack .click-stack__section[data-kind="plans"] .click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await page.locator('#proposals-button').click(); await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
    await expect(sheet.locator('#designs-browse')).toBeHidden();
    const planRow = sheet.locator('#designs-plans .lists-item').filter({ hasText: 'Residents plan' });
    await expect(sheet.locator('#designs-plans').getByRole('button', { name: 'Import plan file', exact: true })).toBeVisible();
    await expect(sheet.locator('#designs-plans [data-plan-file-action="import"] .fa-file-import')).toBeVisible();
    await expect(planRow.locator('.lists-item__icon .cb-icon-plan')).toBeVisible();
    await expect(planRow.getByRole('button', { name: 'Plan stats', exact: true })).toBeVisible();
    const rooster = planRow.getByRole('button', { name: 'Urban rooster', exact: true });
    await expect(rooster.locator('img')).toBeVisible();
    expect(await rooster.locator('img').evaluate(img => getComputedStyle(img).filter)).toBe('none');
    await planRow.getByRole('button', { name: 'Plan stats', exact: true }).click();
    await expect(page.locator('#plan-stats-modal [data-plan-stat="scope"]')).toContainText('Residents plan');
    await page.keyboard.press('Escape');
    await expect(page.locator('#plan-stats-modal')).toBeHidden();
    await expectInsets();
    await expect(planRow).toContainText('Draft'); await expect(planRow).toContainText('This browser');
    // The title shows the plan on the map and keeps the list open; Open selects it.
    const parkInView = () => page.evaluate(id => {
      const w = window as any;
      const [west, south, east, north] = w.__proposalCounts.proposalBounds(w.proposalStorage.getProposal(id));
      return w.map.getBounds().contains([[south, west], [north, east]]);
    }, agreement.parkId);
    await page.evaluate(() => (window as any).map.setView([45.70, 15.80], 17, { animate: false }));
    expect(await parkInView()).toBe(false);
    await planRow.getByRole('button', { name: 'Residents plan', exact: true }).click();
    await expect.poll(parkInView).toBe(true);
    await expect(planRow).toHaveClass(/is-selected/);
    await expect(sheet).toBeVisible();
    await expect(page.locator('#click-stack .click-stack__section[data-kind="plans"]')).toBeHidden();
    await planRow.getByRole('button', { name: 'Open Residents plan', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('#click-stack .click-stack__section[data-kind="plans"]')).toBeVisible();
    await expect(page.locator('#click-stack')).toContainText('Residents plan');
    await expect(page.locator('#click-stack').getByRole('button', { name: 'Remove from browser', exact: true })).toHaveCount(0);
    await page.locator('#proposals-button').click();
    await sheet.getByRole('searchbox').fill('Residents');
    await sheet.getByRole('tab', { name: 'Agreements', exact: true }).click();
    await expect(sheet.getByRole('searchbox')).toHaveValue('Residents');
    await expect(sheet.locator('#designs-browse')).toBeHidden();
    await expect(sheet.locator('#designs-plans')).toBeHidden();
    const agreementRow = sheet.locator('#designs-agreements .lists-item').filter({ hasText: 'Residents agreement' });
    await expect(sheet.getByRole('button', { name: 'Import plan file', exact: true })).toBeHidden();
    await expect(agreementRow.locator('.lists-item__icon .cb-icon-agreement')).toBeVisible();
    await expectInsets();
    await page.evaluate(() => (window as any).map.setView([45.70, 15.80], 17, { animate: false }));
    await agreementRow.getByRole('button', { name: 'Residents agreement', exact: true }).click();
    await expect.poll(parkInView).toBe(true);
    await expect(sheet).toBeVisible();
    await agreementRow.getByRole('button', { name: 'Open Residents agreement', exact: true }).click();
    await expect(page.locator('#click-stack')).toContainText('Residents agreement');
    await expect(page.locator('[data-agreement-action="delete"]')).toHaveCount(0);
    await page.locator('#proposals-button').click();
    await sheet.locator('[data-list-source="published"]').click(); await expect(agreementRow).toBeVisible();
    await agreementRow.getByRole('button', { name: 'Share', exact: true }).click();
    await agreementRow.getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await page.locator('.cb-dialog').getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await expect(agreementRow).toBeVisible(); // publication remains; local-copy action disappears
    await expect(agreementRow.getByRole('button', { name: 'Remove from browser', exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(id => (window as any).AgreementStore.get(id), agreement.id)).toBeNull();
    await sheet.locator('[data-list-source="local"]').click(); await expect(sheet.locator('#designs-agreements .lists-item')).toHaveCount(0);
    await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
    await planRow.getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await page.locator('.cb-dialog').getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await expect(planRow).toHaveCount(0);
    expect(await page.evaluate(id => !!(window as any).proposalStorage.getProposal(id), agreement.parkId)).toBe(true);
    expect(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await sheet.getByRole('searchbox').fill('');
    await sheet.getByRole('tab', { name: 'Designs', exact: true }).click();
    await sheet.locator('#proposal-list-host .lists-item').getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await page.locator('.cb-dialog').getByRole('button', { name: 'Remove from browser', exact: true }).click();
    await expect(sheet.locator('#proposal-list-host .lists-item')).toHaveCount(0);
  });
}
