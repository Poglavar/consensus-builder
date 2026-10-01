import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, clickMapAt } from '../helpers/app';
import { selectors } from '../helpers/selectors';

// The map shell replaced the left sidebar (UI-REWORK.md): Layers/Settings buttons top-right,
// Proposals/Tools/Activity bottom-right and the Game pill bottom-left each toggle a sheet
// (frontend/js/ui/map-shell.js). This file took over sidebar.spec.ts, which clicked the sidebar
// toggle and asserted the `collapsed` class flipped; the equivalent here is that each button really
// shows/hides its sheet and keeps aria-expanded in step, plus the shell's closing rules (one sheet at
// a time, Esc with focus restored, the close button, an outside click).

const SHEETS = [
  { name: 'Layers', button: selectors.layersButton, sheet: selectors.layersSheet },
  { name: 'Settings', button: selectors.settingsButton, sheet: selectors.settingsSheet },
  { name: 'Proposals', button: selectors.proposalsButton, sheet: selectors.proposalsSheet },
  { name: 'Tools', button: selectors.toolsButton, sheet: selectors.toolsSheet },
  { name: 'Activity', button: selectors.activityButton, sheet: selectors.activitySheet },
  { name: 'Game', button: selectors.gamePillToggle, sheet: selectors.gameSheet },
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
    });
  }

  test('opening a second sheet closes the first', async ({ mockApi: page }) => {
    await page.locator(selectors.layersButton).click();
    await expect(page.locator(selectors.layersSheet)).toBeVisible();

    await page.locator(selectors.toolsButton).click();
    await expect(page.locator(selectors.toolsSheet)).toBeVisible();
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

    // Below parcel zoom (the city's default view), so the click cannot open a parcel menu instead.
    await clickMapAt(page, -150, 0);
    await expect(page.locator(selectors.activitySheet)).toBeHidden();
  });

  test('a control kept its old id inside the sheet that now holds it', async ({ mockApi: page }) => {
    // The sheets carry the sidebar's controls with their ids (inline handlers and globals depend on
    // them). revealControl is how commands and the palette reach one: it must open the right sheet.
    await page.evaluate(() => (window as any).MapShell.revealControl('tile-source-select'));
    await expect(page.locator(selectors.settingsSheet)).toBeVisible();
    await expect(page.locator(`${selectors.settingsSheet} #tile-source-select`)).toBeVisible();

    await page.evaluate(() => (window as any).MapShell.revealControl('areaMonitorListButton'));
    await expect(page.locator(selectors.toolsSheet)).toBeVisible();
    await expect(page.locator(selectors.settingsSheet)).toBeHidden();
    await expect(page.locator(`${selectors.toolsSheet} #areaMonitorListButton`)).toBeVisible();
  });
});
