// Exercise menu and dialog regressions through the rendered map at desktop and phone widths.
import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { fileDesign, pageIndex } from '../helpers/mocks/shared-server';

test('profile history and its accessible close label follow every supported locale in place', async ({ mockApi: page }) => {
  await openCity(page);
  await page.locator('#username-display').click();
  await page.locator('#username-input').fill('Menu regression actor');
  await page.locator('#welcome-submit-btn').click();
  await page.locator('#username-display').click();
  const profile = page.locator('.agent-dialog-modal');
  for (const [locale, empty, close] of [
    ['es-ES', 'Todavía no hay actividades registradas para este agente.', 'Cerrar el diálogo del agente'],
    ['sr-Latn-RS', 'Još nema zabeleženih aktivnosti za ovog agenta.', 'Zatvori dijalog agenta'],
    ['hr-HR', 'Još nema zabilježenih aktivnosti za ovog agenta.', 'Zatvori dijalog agenta'],
    ['en-US', 'No activities recorded for this agent yet.', 'Close agent dialog'],
    ['en-GB', 'No activities recorded for this agent yet.', 'Close agent dialog'],
  ]) {
    await profile.locator(`[data-language="${locale}"]`).click();
    await expect(profile.locator('.empty-log')).toHaveText(empty);
    await expect(profile.locator('.agent-dialog-modal-close')).toHaveAccessibleName(close);
  }
  await profile.locator('.agent-dialog-modal-close').click();
  await expect(profile).toHaveCount(0);
});

test('NYC coverage reports ground area and fits its dialog at desktop and phone widths', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await page.route('**/parcel-nyc?**', route => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
  await page.goto('/?city=new_york&at=40.71236,-74.00595,18&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.waitForFunction(() => (window as any).CadastralParcelRepository?.snapshot().boundsKeys.length > 0);
  await page.locator('#settings-button').click();
  await page.locator('#showParcelCoverageButton').click();
  const coverage = page.locator('#parcel-coverage-modal');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await coverage.locator('#parcel-coverage-refresh-btn').click();
    await expect(coverage.locator('#parcel-coverage-summary')).toContainText(/Cached \d[\d,]* cells/);
    await expect(coverage.locator('#parcel-coverage-summary')).not.toContainText('~0 m²');
    const sizes = await coverage.locator('.cb-dialog__body').evaluate(el => ({ content: el.scrollWidth, available: el.clientWidth }));
    expect(sizes.content).toBeLessThanOrEqual(sizes.available);
  }
});

test('the NYC command palette respects source-hidden building rows', async ({ mockApi: page }) => {
  await page.goto('/?city=new_york&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.locator('#settings-button').click();
  await page.locator('#command-palette-button').click();
  const palette = page.locator('.command-palette-backdrop');
  await expect(palette).toBeVisible();
  for (const label of ['3D buildings (GDI)', 'Official cadastre (DGU)']) {
    await palette.locator('input').fill(label);
    const option = palette.getByRole('option').filter({ hasText: label }).first();
    await expect(option).toHaveAttribute('aria-disabled', 'true');
  }
  await palette.locator('input').fill('Map buildings (OSM)');
  await expect(palette.getByRole('option').filter({ hasText: 'Map buildings (OSM)' }).first()).not.toHaveAttribute('aria-disabled', 'true');
});

test('OSM block refresh and browsing remain palette commands when parcel blocks are unavailable', async ({ mockApi: page }) => {
  await page.goto('/?city=new_york&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  // Model the ready OSM dataset at its control boundary; network detection is tested separately.
  await page.evaluate(() => {
    for (const id of ['urban-blocks-refresh', 'urban-blocks-browse']) (document.getElementById(id) as HTMLButtonElement).disabled = false;
  });
  await page.locator('#settings-button').click();
  await page.locator('#command-palette-button').click();
  const palette = page.locator('.command-palette-backdrop');
  for (const label of ['Refresh this area', 'Browse blocks']) {
    await palette.locator('input').fill(label);
    const option = palette.getByRole('option').filter({ hasText: label }).first();
    await expect(option).toBeVisible();
    await expect(option).not.toHaveAttribute('aria-disabled', 'true');
  }
});

test('Activity Clear resets the selected actor, event counts and run provenance', async ({ mockApi: page }) => {
  await page.route('**/agent/activity**', route => route.fulfill({ json: { events: ['Alice', 'Bob'].map((name, i) => ({
    id: `menu-event-${i}`, occurredAt: '2026-10-22T12:00:00Z', recordedAt: '2026-10-22T12:00:00Z',
    actor: { id: name, name, kind: 'agent', controller: 'llm' },
    action: { type: 'propose' }, source: 'live', message: `${name} activity`, runId: `menu-run-${i}`, ok: true,
  })) } }));
  await page.route('**/agent/runs/menu-run-*', route => route.fulfill({ json: { run: {
    id: 'menu-run-0', persona: 'Alice', status: 'done', picks: [], costs: [],
  } } }));
  await openCity(page);
  await page.locator('#activity-button').click();
  await page.locator('#activity-agents-button').click();
  const modal = page.locator('.game-log-modal');
  const actors = modal.locator('[data-activity-actors]');
  await actors.locator('.ae-profiles button').filter({ hasText: 'Alice' }).click();
  await expect(actors.locator('.ae-event')).toHaveCount(1);
  await expect(modal.locator('[data-activity-live-status]')).toHaveText('1 event');
  await actors.getByRole('button', { name: /run menu/ }).click();
  await expect(actors.locator('.ae-run-detail')).toContainText('Run menu-run-0');
  await modal.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(actors.locator('.ae-event')).toHaveCount(2);
  await expect(actors.locator('.ae-profiles [aria-pressed="true"]')).toHaveCount(0);
  await expect(actors.locator('.ae-run-detail')).toBeEmpty();
  await expect(modal.locator('[data-activity-live-status]')).toHaveText('2 events');
});

test('downloading a foreign-city design from Activity discloses the reload and lets the visitor stay', async ({ mockApi: page }) => {
  const cid = fileDesign(pageIndex(page), {
    schema: 'design/v1', goal: 'park', title: 'London park', description: null, author: 'Remote author',
    city: 'london', site: { type: 'Polygon', coordinates: [[[-0.128, 51.507], [-0.127, 51.507], [-0.127, 51.508], [-0.128, 51.508], [-0.128, 51.507]]] }, toleranceM: null, geometry: null, origin: null,
    authoredAt: '2026-10-22T12:00:00.000Z', structureProposal: { kind: 'park', blockName: null },
  });
  await openCity(page);
  const actorId = await page.evaluate(() => (window as any).getCurrentUserAgent().id);
  await page.locator('#activity-button').click();
  await page.locator('#activity-explorer-button').click();
  const openDesign = page.locator(`#game-log-content .activity-entity-link[data-entity-type="design"][data-entity-id="${cid}"]`);
  await expect(openDesign).toBeVisible();
  await openDesign.click();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const prompt = page.locator('.city-switch-dialog');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('London');
  await expect(prompt).toContainText('reloads');
  await prompt.getByRole('button', { name: /^Stay in Zagreb/ }).click();
  await expect(prompt).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('zagreb');
  expect(await page.evaluate(() => (window as any).getCurrentUserAgent().id)).toBe(actorId);
  expect(await page.evaluate(cid => (window as any).DesignSync.localCopyOf(cid), cid)).toBeNull();
});

for (const width of [1180, 390]) test(`expanded proposal filters and tools leave reachable cards at ${width}px`, async ({ mockApi: page }) => {
  await page.setViewportSize({ width, height: 757 });
  await openCity(page);
  await page.evaluate(({ id, geometry }) => {
    for (const title of ['List option A', 'List option B']) (window as any).proposalStorage.addProposal({ goal: 'park', title, applied: false, cadastreParcelIds: [id], geometry, structureProposal: { kind: 'park', geometry } });
  }, { id: PARCEL_ID, geometry: PARCEL_GEOMETRY });
  await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  await sheet.locator('.proposal-filters-toggle').click();
  await sheet.locator('#proposal-list-actions > summary').click();
  const list = sheet.locator('.proposal-list-modal-body');
  expect(await list.evaluate(el => el.clientHeight)).toBeGreaterThanOrEqual(100);
  const details = sheet.locator('.proposal-list-details-btn').first();
  await details.scrollIntoViewIfNeeded();
  await expect(details).toBeInViewport();
  await details.click();
  await expect(page.locator('#planning-inspector')).toBeVisible();
});

test('phone menus open, fit the viewport and dismiss; proposal statuses use the current lifecycle', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCity(page);
  for (const id of ['layers', 'settings', 'measurement', 'proposals', 'bets', 'activity']) {
    await page.locator(`#${id}-button`).click();
    const sheet = page.locator(`#${id}-sheet`);
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    if (id === 'proposals') {
      await sheet.locator('.proposal-filters-toggle').click();
      const status = sheet.locator('#proposal-filter-lifecycle');
      await expect(status).toBeVisible();
      expect(await status.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
        .toEqual(['all', 'draft', 'active', 'executed', 'execution-unverified', 'expired', 'cancelled', 'awaiting-funding', 'unknown']);
      const labels = await status.locator('option').allTextContents();
      expect(new Set(labels).size).toBe(labels.length);
    }
    await page.locator(`#${id}-button`).click();
    await expect(sheet).toBeHidden();
  }
});

test('an explicit World view failure explains recovery and leaves the map usable', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => { (window as any).WorldView.open = async () => { throw new Error('Fixture: WebGL unavailable'); }; });
  await page.locator('#settings-button').click();
  await page.locator('#world-view-button').click();
  await expect(page.locator('#ephemeral-message-container')).toContainText('World view could not start.');
  await expect(page.locator('#map')).toBeVisible();
  await page.locator('#settings-button').click();
  await expect(page.locator('#settings-sheet')).toBeVisible();
});
