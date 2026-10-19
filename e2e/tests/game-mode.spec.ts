import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

/**
 * Game mode. gameState.save()/load() go through PersistentStorage (IndexedDB) and executeGameTurn()
 * drives agents against the live map, so both need a browser.
 *
 * These checks exercise persistence through IndexedDB and a real simulation turn.
 */

test.describe('Game mode @features', () => {
  test('gameState.save and load round-trip', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      w.gameState.addLogEntry('E2E test log entry', false, { action: { type: 'e2e-save-round-trip' } });
      const turnBefore = w.gameState.currentTurn;
      w.gameState.save();

      // Modify in-memory state
      w.gameState.currentTurn = 9999;
      w.gameState.load();

      return {
        turnRestored: w.gameState.currentTurn === turnBefore,
        logHasEntry: w.gameState.gameLog.some((e: any) => e.messageHtml?.includes('E2E test log entry')),
      };
    });

    expect(result.turnRestored).toBe(true);
    expect(result.logHasEntry).toBe(true);
  });

  test('executeGameTurn advances the turn counter', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      if (!w.gameState.isInitialized) w.initializeGame();

      const turnBefore = w.gameState.currentTurn;
      await w.executeGameTurn();
      return { advanced: w.gameState.currentTurn > turnBefore };
    });

    expect(result.advanced).toBe(true);
  });
});
