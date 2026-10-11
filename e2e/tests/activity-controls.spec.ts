import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { Page } from '@playwright/test';

// The simulation sits folded in the Activity sheet behind its own "Simulation" summary (fbe3758d).
async function openSimulation(page: Page) {
  await page.locator('#activity-button').click();
  const simulation = page.locator('#activity-sheet details.activity-simulation');
  await expect(simulation).toBeVisible();
  if (!(await simulation.evaluate((details: HTMLDetailsElement) => details.open))) await simulation.locator('> summary').click();
  await expect(simulation).toHaveAttribute('open', '');
}

test.describe('Activity and simulation controls @features', () => {
  for (const width of [1280, 390]) {
    test(`simulation play and pause stay circular at ${width}px`, async ({ mockApi: page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openCity(page);
      await openSimulation(page);
      const play = page.locator('#game-play-pause-btn');
      await expect(play).toBeVisible();
      for (const running of [false, true, false]) {
        if (running !== (await play.getAttribute('aria-pressed') === 'true')) await play.click();
        await expect(play).toHaveAttribute('aria-pressed', String(running));
        const size = await play.boundingBox();
        expect(size).not.toBeNull();
        expect(Math.abs(size!.width - size!.height)).toBeLessThan(1);
      }
      await page.screenshot({ path: `/private/tmp/simulation-circle-${width}.png` });
    });
  }

  test('activity explorer and agents view open from their real sheet actions and filter returned activity', async ({ mockApi: page }) => {
    const requests: string[] = [];
    await page.route('**/agent/activity**', async route => {
      const request = route.request();
      if (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr') return route.continue();
      requests.push(new URL(request.url()).search);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ events: [{
          id: 'e2e-live-activity', occurredAt: '2026-10-01T12:00:00Z', recordedAt: '2026-10-01T12:00:00Z',
          actor: { id: 'e2e-actor', name: 'Map Steward', kind: 'agent', controller: 'algorithm' },
          action: { type: 'publish' }, entity: { type: 'proposal', id: 'e2e-proposal' },
          source: 'live', message: 'Published the river park plan', ok: true,
        }] }),
      });
    });

    await openCity(page);
    await page.locator('#activity-button').click();
    await expect(page.locator('#activity-sheet')).toBeVisible();
    await page.locator('#activity-explorer-button').click();
    const modal = page.locator('.game-log-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#game-log-content')).toContainText('river park plan');
    await modal.locator('[data-activity-filter-field="query"]').fill('no matching title');
    await expect(modal.locator('#game-log-content')).toContainText(/No matching activity/i);
    await modal.locator('[data-activity-filter-field="query"]').fill('river park');
    await expect(modal.locator('#game-log-content')).toContainText('river park plan');
    await modal.locator('[data-activity-view="actors"]').click();
    await expect(modal.locator('[data-activity-view="actors"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('[data-activity-actors]')).toBeVisible();
    await expect(modal.locator('[data-activity-actors]')).toContainText('Map Steward');
    await modal.locator('[data-activity-view="events"]').click();
    await expect(modal.locator('[data-activity-view="events"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('#game-log-content')).toBeVisible();
    await expect(modal.locator('[data-activity-actors]')).toBeHidden();
    await modal.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(modal.locator('[data-activity-filter-field="query"]')).toHaveValue('');
    await expect(modal.locator('#game-log-content')).toContainText('river park plan');
    const beforeRefresh = requests.length;
    await modal.locator('.activity-refresh').click();
    await expect.poll(() => requests.length).toBeGreaterThan(beforeRefresh);
    await expect(modal.locator('#game-log-content')).toContainText('river park plan');
    await modal.locator('.game-log-modal-close').click();
    await expect(modal).toHaveCount(0);

    // Opening the explorer closes its parent Activity sheet. Reopen the sheet to verify its
    // dedicated Actors shortcut reaches the same view as the explorer's internal switch.
    await page.locator('#activity-button').click();
    await expect(page.locator('#activity-sheet')).toBeVisible();
    await page.locator('#activity-agents-button').click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-activity-view="actors"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('[data-activity-actors]')).toContainText('Map Steward');
    expect(requests.length).toBeGreaterThan(0);
  });

  test('the Activity sheet Actors action opens the actor view', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#activity-button').click();
    const sheet = page.locator('#activity-sheet');
    await expect(sheet).toBeVisible();
    await sheet.locator('#activity-agents-button').click();
    const modal = page.locator('.game-log-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-activity-view="actors"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('[data-activity-actors]')).toBeVisible();
    await modal.locator('.game-log-modal-close').click();
    await expect(modal).toHaveCount(0);
  });

  test('the command palette Actors action opens the actor view', async ({ mockApi: page }) => {
    await openCity(page);
    await page.keyboard.press('Meta+k');
    const palette = page.locator('.command-palette-backdrop');
    await expect(palette).toBeVisible();
    await page.locator('.command-palette__input').fill('Actors');
    await page.locator('.command-palette__item').filter({ hasText: 'Actors' }).first().click();

    const modal = page.locator('.game-log-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-activity-view="actors"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('[data-activity-actors]')).toBeVisible();
    await modal.locator('.game-log-modal-close').click();
    await expect(modal).toHaveCount(0);
  });

  test('simulation settings change the interval, play advances turns, pause stops it, and New Game confirms reset', async ({ mockApi: page }) => {
    await openCity(page);
    await openSimulation(page);
    const settings = page.locator('#activity-sheet .activity-simulation-settings');
    await settings.locator('summary').click();
    // The on/off switch is the section's first row, outside the settings fold.
    const gameEnabled = page.locator('#activity-sheet .activity-simulation-switch #gameCheckbox');
    await gameEnabled.check();
    await expect(gameEnabled).toBeChecked();
    const interval = settings.locator('#turn-interval-slider');
    await interval.focus();
    await interval.press('Home');
    await expect(settings.locator('#turn-interval-value')).toHaveText('1');

    const play = page.locator('#game-play-pause-btn');
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.locator('#game-turns').innerText(), { timeout: 15_000 }).not.toBe('0');
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'false');

    const beforeReset = await page.locator('#game-turns').innerText();
    const newGame = settings.getByRole('button', { name: /New Game/i });
    const confirmText = /start a NEW game\?/i;
    let cancelMessage = '';
    page.once('dialog', async dialog => {
      cancelMessage = dialog.message();
      await dialog.dismiss();
    });
    await newGame.click();
    expect(cancelMessage).toMatch(confirmText);
    await expect(page.locator('#game-turns')).toHaveText(beforeReset);

    let acceptMessage = '';
    page.once('dialog', async dialog => {
      acceptMessage = dialog.message();
      await dialog.accept();
    });
    await newGame.click();
    expect(acceptMessage).toMatch(confirmText);
    await expect.poll(() => page.locator('#game-turns').innerText()).toBe('0');
    await expect(play).toHaveAttribute('aria-pressed', 'false');
  });
});
