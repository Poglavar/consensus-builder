import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, clickMapAt } from '../helpers/app';
import { selectors } from '../helpers/selectors';

// The map shell replaced the left sidebar (UI-REWORK.md): Layers/Settings buttons top-right, the
// Measure ruler beside the map-mode buttons, Proposals/Bets/Activity bottom-right each toggle a sheet
// (frontend/js/ui/map-shell.js). This file took over sidebar.spec.ts, which clicked the sidebar
// toggle and asserted the `collapsed` class flipped; the equivalent here is that each button really
// shows/hides its sheet and keeps aria-expanded in step, plus the shell's closing rules (one sheet at
// a time, Esc with focus restored, the close button, an outside click).

const SHEETS = [
  { name: 'Buildings and massing', button: '#planning-views-button', sheet: '#planning-views' },
  { name: 'Layers', button: selectors.layersButton, sheet: selectors.layersSheet },
  { name: 'Settings', button: selectors.settingsButton, sheet: selectors.settingsSheet },
  { name: 'Proposals', button: selectors.proposalsButton, sheet: selectors.proposalsSheet },
  { name: 'Measure', button: selectors.measurementButton, sheet: selectors.measurementSheet },
  { name: 'Bets', button: selectors.betsButton, sheet: selectors.betsSheet },
  { name: 'Activity', button: selectors.activityButton, sheet: selectors.activitySheet },
];

test.describe('Map shell sheets @features', () => {
  // Zagreb hides no section, so every button is present (other cities hide e.g. Roads/Area monitor).
  test.beforeEach(async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
  });

  for (const { name, button, sheet } of SHEETS) {
    test(`the ${name} button opens and closes its sheet`, async ({ mockApi: page }) => {
      const trigger = page.locator(button);
      const panel = page.locator(sheet);

      await expect(panel).toBeHidden();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');

      await trigger.click();
      await expect(panel).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator(selectors.openSheet)).toHaveCount(1);

      await trigger.click();
      await expect(panel).toBeHidden();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator(selectors.openSheet)).toHaveCount(0);

      // Exercise the sheet's own close affordance too; every sheet carries this control.
      await trigger.click();
      await expect(panel).toBeVisible();
      await panel.locator(selectors.sheetClose).click();
      await expect(panel).toBeHidden();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator(selectors.openSheet)).toHaveCount(0);
    });
  }

  test('Buildings and massing stays beside the city on narrow screens and starts collapsed after reload', async ({ mockApi: page }) => {
    const trigger = page.getByRole('button', { name: 'Buildings and massing', exact: true });
    const panel = page.locator('#planning-views');
    await expect(trigger).toBeVisible();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const city = await page.locator('.map-search__chip').boundingBox();
      const search = await page.locator('.map-search').boundingBox();
      const button = await trigger.boundingBox();
      const avatar = await page.locator('#username-display').boundingBox();
      if (!city || !search || !button || !avatar) throw new Error('Top-left controls are missing');
      expect(Math.abs(button.y + button.height / 2 - city.y - city.height / 2)).toBeLessThan(3);
      expect(button.x).toBeGreaterThanOrEqual(search.x + search.width);
      expect(button.x + button.width).toBeLessThanOrEqual(avatar.x);
      await trigger.click();
      await expect(panel).toBeVisible();
      const bounds = await panel.boundingBox();
      if (!bounds) throw new Error('Massing controls did not open');
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(trigger).toBeFocused();
    }
    await trigger.click();
    await panel.getByRole('combobox', { name: 'Built appearance', exact: true }).selectOption('off');
    await trigger.click();
    await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getState().existing)).toBe('off');
    await page.reload();
    await waitForMapReady(page);
    await expect(trigger).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getState().existing)).toBe('off');
  });

  test('opening a second sheet closes the first', async ({ mockApi: page }) => {
    await page.locator(selectors.layersButton).click();
    await expect(page.locator(selectors.layersSheet)).toBeVisible();

    await page.locator(selectors.activityButton).click();
    await expect(page.locator(selectors.activitySheet)).toBeVisible();
    await expect(page.locator(selectors.layersSheet)).toBeHidden();
    await expect(page.locator(selectors.layersButton)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(selectors.openSheet)).toHaveCount(1);
  });

  test('Escape closes the open sheet and returns focus to its button', async ({ mockApi: page }) => {
    const trigger = page.locator(selectors.settingsButton);
    await trigger.click();
    await expect(page.locator(selectors.settingsSheet)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator(selectors.settingsSheet)).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('the close button closes the sheet', async ({ mockApi: page }) => {
    await page.locator(selectors.proposalsButton).click();
    const sheet = page.locator(selectors.proposalsSheet);
    await expect(sheet).toBeVisible();

    await sheet.locator(selectors.sheetClose).click();
    await expect(sheet).toBeHidden();
    await expect(page.locator(selectors.proposalsButton)).toHaveAttribute('aria-expanded', 'false');
  });

  test('a click on the map outside the sheet closes it', async ({ mockApi: page }) => {
    await page.locator(selectors.activityButton).click();
    await expect(page.locator(selectors.activitySheet)).toBeVisible();

    // The sheet covers the map center; click the exposed map to its right. Below parcel zoom (the
    // city's default view), so the click cannot open a parcel menu instead.
    await clickMapAt(page, 500, 0);
    await expect(page.locator(selectors.activitySheet)).toBeHidden();
  });

  test('a control kept its old id inside the sheet that now holds it', async ({ mockApi: page }) => {
    // The sheets carry the sidebar's controls with their ids (inline handlers and globals depend on
    // them). revealControl is how commands and the palette reach one: it must open the right sheet.
    // The base-map select lives in Layers and the watched-area tools in Activity since fbe3758d.
    await page.evaluate(() => (window as any).MapShell.revealControl('tile-source-select'));
    await expect(page.locator(selectors.layersSheet)).toBeVisible();
    await expect(page.locator(`${selectors.layersSheet} #tile-source-select`)).toBeVisible();

    await page.evaluate(() => (window as any).MapShell.revealControl('areaMonitorDrawButton'));
    await expect(page.locator(selectors.activitySheet)).toBeVisible();
    await expect(page.locator(selectors.layersSheet)).toBeHidden();
    await expect(page.locator(`${selectors.activitySheet} #areaMonitorDrawButton`)).toBeVisible();
  });

  test('the simulation runs from the Activity sheet and marks the Activity button while it runs', async ({ mockApi: page }) => {
    const dot = page.locator(selectors.simulationRunningDot);
    await expect(dot).toBeHidden();

    await page.locator(selectors.activityButton).click();
    const section = page.locator(selectors.simulationSection);
    await expect(section).toBeVisible();
    // The Simulation section is folded (a <details>) since fbe3758d; its settings fold inside it.
    await expect(section).not.toHaveAttribute('open');
    await page.locator(selectors.simulationSummary).click();
    await expect(section).toHaveAttribute('open', '');
    await expect(page.locator(selectors.simulationSettings)).not.toHaveAttribute('open');

    await page.locator(selectors.simulationPlayPause).click();
    await expect(page.locator(selectors.simulationPlayPause)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator(selectors.activitySheet)).toBeHidden();
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('aria-label', 'Simulation running');

    await page.locator(selectors.activityButton).click();
    await expect(section).toHaveAttribute('open', '');
    await page.locator(selectors.simulationPlayPause).click();
    await expect(page.locator(selectors.simulationPlayPause)).toHaveAttribute('aria-pressed', 'false');
    await expect(dot).toBeHidden();
  });
});
