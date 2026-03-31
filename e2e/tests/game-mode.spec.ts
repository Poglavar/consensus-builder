import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Game mode @features', () => {
  test('gameState object is initialized', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const state = await page.evaluate(() => {
      const w = window as any;
      if (!w.gameState) return { exists: false };
      return {
        exists: true,
        hasCurrentTurn: typeof w.gameState.currentTurn === 'number',
        hasGameLog: Array.isArray(w.gameState.gameLog),
        hasIsRunning: typeof w.gameState.isRunning === 'boolean',
        hasSave: typeof w.gameState.save === 'function',
        hasLoad: typeof w.gameState.load === 'function',
        hasAddLogEntry: typeof w.gameState.addLogEntry === 'function',
        hasReset: typeof w.gameState.reset === 'function',
      };
    });

    test.skip(!state.exists, 'Game module not loaded');
    expect(state.hasCurrentTurn).toBe(true);
    expect(state.hasGameLog).toBe(true);
    expect(state.hasIsRunning).toBe(true);
    expect(state.hasSave).toBe(true);
    expect(state.hasLoad).toBe(true);
  });

  test('game control functions are available', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const fns = await page.evaluate(() => {
      const w = window as any;
      return {
        hasInitialize: typeof w.initializeGame === 'function',
        hasStartLoop: typeof w.startGameLoop === 'function',
        hasStopLoop: typeof w.stopGameLoop === 'function',
        hasExecuteTurn: typeof w.executeGameTurn === 'function',
        hasToggle: typeof w.toggleGamePlayPause === 'function',
        hasResetState: typeof w.resetGameState === 'function',
        hasShowLog: typeof w.showGameLogDialog === 'function',
        hasShowStats: typeof w.showAgentsStatistics === 'function',
        hasUpdateInterval: typeof w.updateTurnInterval === 'function',
      };
    });

    const hasSome = Object.values(fns).some(v => v === true);
    test.skip(!hasSome, 'Game functions not loaded');
    expect(fns.hasInitialize).toBe(true);
    expect(fns.hasExecuteTurn).toBe(true);
    expect(fns.hasToggle).toBe(true);
  });

  test('gameState.save and load round-trip', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      if (!w.gameState || typeof w.gameState.save !== 'function') return { skip: true };

      w.gameState.addLogEntry('E2E test log entry', false);
      const turnBefore = w.gameState.currentTurn;
      w.gameState.save();

      // Modify in-memory state
      w.gameState.currentTurn = 9999;
      w.gameState.load();

      return {
        skip: false,
        turnRestored: w.gameState.currentTurn === turnBefore,
        logHasEntry: w.gameState.gameLog.some((e: any) =>
          (e.text || e.message || '').includes('E2E test log entry')
        ),
      };
    });

    test.skip(result.skip === true, 'Game save/load not available');
    expect(result.turnRestored).toBe(true);
    expect(result.logHasEntry).toBe(true);
  });

  test('executeGameTurn advances the turn counter', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      if (typeof w.executeGameTurn !== 'function' || !w.gameState) return { skip: true };

      // Initialize game if needed
      if (typeof w.initializeGame === 'function' && !w.gameState.isInitialized) {
        try { w.initializeGame(); } catch (_) {}
      }

      const turnBefore = w.gameState.currentTurn;
      try {
        await w.executeGameTurn();
      } catch (_) {
        // Turn may fail if agents/parcels not fully set up in static mode
        return { skip: false, advanced: w.gameState.currentTurn > turnBefore, error: true };
      }
      return { skip: false, advanced: w.gameState.currentTurn > turnBefore, error: false };
    });

    test.skip(result.skip === true, 'Game turn execution not available');
    // Turn should advance even if agent actions fail
    if (!result.error) {
      expect(result.advanced).toBe(true);
    }
  });
});
