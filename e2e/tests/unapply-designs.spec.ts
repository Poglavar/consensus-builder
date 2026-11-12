// Taking designs off the map: one from its Design card, all of them from Lists. Each ends in a
// notice that says what came off and offers Undo, which applies them again.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { clickDesignOnMap, clickStack, createSpace, openCity, stackSection } from '../helpers/runtime';

const appliedCount = (page: Page) => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
  .filter((proposal: any) => (window as any).isProposalApplied(proposal)).length);
const notice = (page: Page, text: string | RegExp) => page.locator('#ephemeral-message-container .cb-toast').filter({ hasText: text });

test('a design unapplied from its card can be put back with Undo', async ({ mockApi: page }) => {
  await openCity(page);
  const parkId = await createSpace(page, 'park');
  await page.keyboard.press('Escape');
  await expect(clickStack(page)).toBeHidden();
  await clickDesignOnMap(page, parkId);
  const designs = stackSection(page, 'designs');
  // The card's buttons carry an icon whose glyph is part of their accessible name.
  await designs.getByRole('button', { name: /Unapply$/ }).click();

  await expect.poll(() => appliedCount(page)).toBe(0);
  const unapplied = notice(page, 'was unapplied and remains in Lists.');
  await expect(unapplied).toBeVisible();
  // The card now offers the way back too.
  await expect(designs.getByRole('button', { name: /Apply to map$/ })).toBeVisible();

  await unapplied.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => appliedCount(page)).toBe(1);
  await expect(notice(page, 'is applied again.')).toBeVisible();
  await expect(designs.getByRole('button', { name: /Unapply$/ })).toBeVisible();
});

test('Lists takes every design on the map off it in one change, and Undo puts them back', async ({ mockApi: page }) => {
  await openCity(page);
  await createSpace(page, 'park');
  await page.keyboard.press('Escape');
  await expect(clickStack(page)).toBeHidden();
  await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  const onMap = sheet.locator('[data-lists-on-map]');
  const unapplyAll = sheet.locator('[data-lists-unapply-all]');
  await expect(onMap).toHaveText('On the map (1)');
  await expect(unapplyAll).toHaveText('Unapply all (1)');

  // The pressed toggle keeps only what is on the map.
  await onMap.click();
  await expect(onMap).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('#proposal-list-host .lists-item')).toHaveCount(1);

  await unapplyAll.click();
  const question = page.getByRole('alertdialog');
  await expect(question).toContainText('Unapply every design on the map (1)?');
  await question.getByRole('button', { name: 'Unapply', exact: true }).click();
  await expect.poll(() => appliedCount(page)).toBe(0);
  // Nothing is on the map: the button goes, the toggle is released, and the design is still listed.
  await expect(unapplyAll).toBeHidden();
  await expect(onMap).toHaveText('On the map (0)');
  await expect(onMap).toHaveAttribute('aria-pressed', 'false');
  await expect(sheet.locator('#proposal-list-host .lists-item')).not.toHaveCount(0);

  await notice(page, 'was unapplied and remains in Lists.').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => appliedCount(page)).toBe(1);
  await expect(unapplyAll).toHaveText('Unapply all (1)');
});
