import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, clickMapAt, afterFrames } from '../helpers/app';
import { selectors } from '../helpers/selectors';

// The toolbar and dock buttons share the sheet controller in frontend/js/ui/map-shell.js.

const SHEETS = [
  { name: 'Buildings and zoning', button: '#planning-views-button', sheet: '#planning-views' },
  { name: 'Compare', button: '#compare-button', sheet: '#compare-sheet' },
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

  test('Layers opens with ordered, collapsed sections every time', async ({ mockApi: page }, testInfo) => {
    await page.locator(selectors.layersButton).click();
    const sheet = page.locator(selectors.layersSheet);
    const sections = sheet.locator('.map-sheet-body > .accordion-section');
    expect(await sections.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.section))).toEqual([
      'base-map', 'parcels', 'blocks', 'parks-squares', 'roads', 'schelling-plan', 'scenery'
    ]);
    await expect(sections.locator(':scope > .sheet-section-title')).toHaveText([
      'Base map', 'Parcels', 'Parcel blocks', 'Parks and squares', 'Roads', 'Schelling plan', 'Scenery and sound'
    ]);
    await expect(sheet.locator('#layers-open-buildings')).toHaveText('Buildings and zoning');
    await expect(sheet.locator('details.accordion-section[open]')).toHaveCount(0);
    await expect(sheet.locator('[data-section="schelling-plan"] > summary .fa-bullseye')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('layers-collapsed.png') });
    await sheet.locator('[data-section="base-map"] > summary').click();
    await expect(sheet.locator('#tile-source-select')).toBeVisible();
    await sheet.locator('[data-section="roads"] > summary').click();
    await expect(sheet.locator('details.accordion-section[open]')).toHaveCount(2);
    await sheet.locator(selectors.sheetClose).click();
    await page.locator(selectors.layersButton).click();
    await expect(sheet.locator('details.accordion-section[open]')).toHaveCount(0);
    // Commands still reveal the specific section containing their target control.
    await page.evaluate(() => (window as any).MapShell.revealControl('tile-source-select'));
    await expect(sheet.locator('#tile-source-select')).toBeVisible();
    await expect(sheet.locator('details.accordion-section[open]')).toHaveCount(1);
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

  test('the bottom-right scale bar hosts the Measure button, updates on zoom, and 3D Layers folds 2D sections into Open in 2D', async ({ mockApi: page }) => {
    const scaleButton = page.locator('.leaflet-bottom.leaflet-right .leaflet-control-scale #measurement-button');
    const scaleLine = scaleButton.locator('.leaflet-control-scale-line');
    await expect(scaleButton).toBeVisible();
    await expect(scaleLine).toContainText(/\d+\s*(?:m|km)/);
    // The scale bracket stays upright (open at top, closed at bottom) even after the ruler icon.
    const borders = await scaleLine.evaluate(el => {
      const style = getComputedStyle(el);
      return { top: style.borderTopWidth, bottom: style.borderBottomWidth };
    });
    expect(borders).toEqual({ top: '0px', bottom: '2px' });

    const beforeZoom = (await scaleLine.innerText()).trim();
    await page.evaluate(() => (window as any).map.setZoom((window as any).map.getZoom() + 2, { animate: false }));
    await expect.poll(async () => (await scaleLine.innerText()).trim()).not.toBe(beforeZoom);

    // Clicking the live scale pill opens Measure directly above it.
    await scaleButton.click();
    const sheet = page.locator(selectors.measurementSheet);
    await expect(sheet).toBeVisible();
    const [btnBox, sheetBox] = await Promise.all([scaleButton.boundingBox(), sheet.boundingBox()]);
    expect(sheetBox!.y + sheetBox!.height).toBeLessThanOrEqual(btnBox!.y + 2);

    // Entering 3D model view hides the 2D scale pill, places Compare and Sun on the left strip with no gap,
    // and folds 2D-only map layers into a single Open in 2D row that returns to 2D Layers when clicked.
    await page.locator('#mode-3d-toggle').click();
    await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
    await expect(scaleButton).toBeHidden();
    const [compareBox, twoDBox, threeDBox, photoBox, sunBox] = await Promise.all(
      ['#compare-button', '#mode-2d-toggle', '#mode-3d-toggle', '#mode-realistic-toggle', '#sun-button']
        .map(sel => page.locator(sel).boundingBox())
    );
    expect([compareBox, twoDBox, threeDBox, photoBox, sunBox].every(Boolean)).toBe(true);
    const stripBoxes = [compareBox!, twoDBox!, threeDBox!, photoBox!, sunBox!];
    const tops = stripBoxes.map(b => b.y);
    for (let i = 1; i < tops.length; i++) expect(Math.round(tops[i] - tops[i - 1])).toBe(48);
    for (const box of stripBoxes) expect(Math.round(box.x)).toBe(Math.round(compareBox!.x));

    await page.locator(selectors.layersButton).click();
    const layers = page.locator(selectors.layersSheet);
    await expect(layers).toBeVisible();
    for (const section of ['base-map', 'blocks', 'parks-squares', 'roads', 'schelling-plan']) {
      await expect(layers.locator(`[data-section="${section}"]`)).toBeHidden();
    }
    const open2d = layers.locator('#layers-open-2d');
    await expect(open2d).toBeVisible();
    await open2d.click();
    await expect(layers).toBeVisible();
    await expect(layers.locator('[data-section="base-map"]')).toBeVisible();
    await expect(open2d).toBeHidden();
    await expect(scaleButton).toBeVisible();
    await scaleButton.click();
    await expect(sheet).toBeVisible();
  });

  test('Compare and Buildings and zoning open as separate left sheets beside the view strip', async ({ mockApi: page }) => {
    const compareBtn = page.locator('#compare-button');
    const compareSheet = page.locator('#compare-sheet');
    const buildingsBtn = page.locator('#planning-views-button');
    const buildingsSheet = page.locator('#planning-views');

    await compareBtn.click();
    await expect(compareSheet).toBeVisible();
    await expect(buildingsSheet).toBeHidden();
    const [stripBox, compareBox] = await Promise.all([compareBtn.boundingBox(), compareSheet.boundingBox()]);
    expect(compareBox!.x).toBeGreaterThanOrEqual(stripBox!.x + stripBox!.width);

    await buildingsBtn.click();
    await expect(buildingsSheet).toBeVisible();
    await expect(compareSheet).toBeHidden();
    await expect(compareBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(buildingsSheet.locator('[role="tab"]')).toHaveCount(0);
  });

  test('Layers and Buildings and massing dock beside the view strip on desktop and the bottom edge on phones', async ({ mockApi: page }) => {
    const height = 844;
    const layersButton = page.locator(selectors.layersButton);
    const buildingsButton = page.locator('#planning-views-button');
    const layers = page.locator(selectors.layersSheet);
    const buildings = page.locator('#planning-views');
    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height });
      await layersButton.press('Enter');
      await expect(layers).toBeVisible();
      await afterFrames(page);
      const layerBox = (await layers.boundingBox())!;
      await layers.getByRole('button', { name: 'Buildings and zoning', exact: true }).press('Enter');
      await expect(layers).toBeHidden();
      await expect(buildings).toBeVisible();
      await afterFrames(page);
      const buildingBox = (await buildings.boundingBox())!;
      if (width >= 768) {
        // Docked beside the view strip, so the 2D/3D/photo tiles stay clickable with a sheet open.
        const strip = (await page.locator('#mode-2d-toggle').boundingBox())!;
        expect(layerBox.x).toBeGreaterThanOrEqual(strip.x + strip.width);
        expect(layerBox.x).toBeLessThanOrEqual(strip.x + strip.width + 20);
        expect(buildingBox.x).toBe(layerBox.x);
        const toolbar = (await layersButton.boundingBox())!;
        expect(layerBox.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
        expect(buildingBox.y).toBe(layerBox.y);
        expect(layerBox.width).toBe(400);
        expect(buildingBox.width).toBe(440);
      } else {
        for (const box of [layerBox, buildingBox]) {
          expect(box.x).toBe(0);
          expect(box.width).toBe(width);
          expect(box.y + box.height).toBe(height);
        }
      }
      await page.keyboard.press('Escape');
      await buildingsButton.press('Enter');
      await expect(buildings).toBeVisible();
      const fromToolbar = (await buildings.boundingBox())!;
      expect(fromToolbar.x).toBe(buildingBox.x);
      if (width >= 768) expect(fromToolbar.y).toBe(buildingBox.y);
      await page.keyboard.press('Escape');
      await expect(buildingsButton).toBeFocused();
    }
  });

  test('Buildings and zoning stays beside the city on narrow screens and starts collapsed after reload', async ({ mockApi: page }) => {
    const trigger = page.getByRole('button', { name: 'Buildings and zoning', exact: true });
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

  test('phone sheets shrink when their sections collapse', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(selectors.layersButton).click();
    const sheet = page.locator(selectors.layersSheet);
    const section = sheet.locator('[data-section="parcels"]');
    await sheet.locator(':scope > .mobile-dock-sheet-handle').focus();
    await page.keyboard.press('End');
    const collapsed = (await sheet.boundingBox())!.height;
    await section.locator(':scope > summary').click();
    await expect.poll(async () => (await sheet.boundingBox())!.height).toBeGreaterThan(collapsed + 50);
    await sheet.locator(':scope > .mobile-dock-sheet-handle').focus();
    await page.keyboard.press('End');
    await section.locator(':scope > summary').click();
    await expect.poll(async () => (await sheet.boundingBox())!.height).toBeLessThanOrEqual(collapsed + 1);
  });

  test('bottom navigation disappears in 3D and returns in 2D without reserving space', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const bar = page.locator('#map-shell-bottom-right');
    await expect(bar).toBeVisible();
    // Exercise the shell's actual mode reaction without starting a WebGL renderer.
    await page.evaluate(() => document.body.classList.add('three-mode-active'));
    await expect(bar).toBeHidden();
    await expect.poll(() => page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.height = 'var(--map-shell-dock-height)';
      document.body.appendChild(probe);
      const height = probe.getBoundingClientRect().height;
      probe.remove();
      return height;
    })).toBe(0);
    await page.evaluate(() => document.body.classList.remove('three-mode-active'));
    await expect(bar).toBeVisible();
    await page.locator(selectors.proposalsButton).click();
    await expect(page.locator(selectors.proposalsSheet)).toBeVisible();
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
    // city's default view), so the click cannot open the click stack on a parcel instead.
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

  test('Run simulation in Settings, the simulation bar and the Activity running indicator stay in sync', async ({ mockApi: page }) => {
    const dot = page.locator(selectors.simulationRunningDot);
    await expect(dot).toBeHidden();

    await page.locator(selectors.settingsButton).click();
    const advanced = page.locator(selectors.settingsAdvanced);
    const run = page.locator(selectors.runSimulation);
    // Run simulation is the only simulation control in Settings, inside the collapsed Advanced accordion.
    await expect(advanced).not.toHaveAttribute('open');
    await expect(run).toBeHidden();
    await page.locator(selectors.settingsAdvancedSummary).click();
    await expect(advanced).toHaveAttribute('open', '');
    await expect(run).toBeVisible();
    await expect(page.locator('#settings-sheet [data-section="game"]')).toHaveText('Run simulation');

    // It starts the game, folds Settings away and opens the simulation bar.
    await run.click();
    await expect(page.locator(selectors.settingsSheet)).toBeHidden();
    const barPlay = page.locator('#simulation-bar-play');
    await expect(barPlay).toHaveAttribute('aria-pressed', 'true');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('aria-label', 'Simulation running');

    // Pause is on the bar; the dot follows it.
    await barPlay.click();
    await expect(barPlay).toHaveAttribute('aria-pressed', 'false');
    await expect(dot).toBeHidden();
  });
});
