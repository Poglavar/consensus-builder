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
  const data = page.locator('#settings-sheet details.accordion-section[data-section="advanced"]');
  if (!(await data.evaluate((details: HTMLDetailsElement) => details.open))) await data.locator(':scope > summary').click();
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

test('the NYC command palette respects building-source availability', async ({ mockApi: page }) => {
  await page.goto('/?city=new_york&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.keyboard.press('Control+k');
  const palette = page.locator('.command-palette-backdrop');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill('Show buildings');
  const workingProvider = palette.getByRole('option').filter({ hasText: 'Show buildings' }).first();
  await expect(workingProvider).toBeVisible();
  await expect(workingProvider).not.toHaveAttribute('aria-disabled', 'true');
  // Which surveys are used or outlined is the city's building source list, one command away.
  await palette.locator('input').fill('Building sources');
  const sources = palette.getByRole('option').filter({ hasText: 'Building sources' }).first();
  await expect(sources).toBeVisible();
  await expect(sources).not.toHaveAttribute('aria-disabled', 'true');
});

test('OSM block refresh and browsing remain palette commands when parcel blocks are unavailable', async ({ mockApi: page }) => {
  await page.goto('/?city=new_york&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  // Model the ready OSM dataset at its control boundary; network detection is tested separately.
  await page.evaluate(() => {
    for (const id of ['urban-blocks-refresh', 'urban-blocks-browse']) (document.getElementById(id) as HTMLButtonElement).disabled = false;
  });
  await page.keyboard.press('Control+k');
  const palette = page.locator('.command-palette-backdrop');
  for (const label of ['Refresh this area', 'Browse blocks']) {
    await palette.locator('input').fill(label);
    const option = palette.getByRole('option').filter({ hasText: label }).first();
    await expect(option).toBeVisible();
    await expect(option).not.toHaveAttribute('aria-disabled', 'true');
  }
});

test('Activity Clear scope restores the Actors chooser, event count and run provenance', async ({ mockApi: page }) => {
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
  await page.locator('#activity-actors-tab').click();
  const modal = page.locator('#activity-sheet');
  const actors = modal.locator('[data-activity-actors]');
  await actors.locator('.ae-profiles button').filter({ hasText: 'Alice' }).click();
  await expect(actors.locator('.ae-event')).toHaveCount(1);
  await expect(modal.locator('#activity-panel-status')).toContainText('1 event');
  await actors.getByRole('button', { name: /Run menu/i }).click();
  await expect(actors.locator('.ae-run-detail')).toContainText('Run menu-run-0');
  await modal.locator('[data-activity-clear-scope]').click();
  await expect(actors.locator('.ae-event')).toHaveCount(0);
  await expect(actors.locator('.ae-profiles [aria-pressed="true"]')).toHaveCount(0);
  await expect(actors.locator('.ae-run-detail')).toBeEmpty();
  await expect(modal.locator('#activity-panel-status')).toContainText('2 events');
});

test('downloading a foreign-city design from Activity keeps the current map and parks the imported design', async ({ mockApi: page }) => {
  const cid = fileDesign(pageIndex(page), {
    schema: 'design/v1', goal: 'park', title: 'London park', description: null, author: 'Remote author',
    city: 'london', site: { type: 'Polygon', coordinates: [[[-0.128, 51.507], [-0.127, 51.507], [-0.127, 51.508], [-0.128, 51.508], [-0.128, 51.507]]] }, toleranceM: null, geometry: null, origin: null,
    authoredAt: '2026-10-22T12:00:00.000Z', structureProposal: { kind: 'park', blockName: null },
  });
  await openCity(page);
  const actorId = await page.evaluate(() => (window as any).getCurrentUserAgent().id);
  await page.locator('#activity-button').click();
  const openDesign = page.locator(`#activity-sheet #game-log-content .activity-entity-link[data-entity-type="design"][data-entity-id="${cid}"]`);
  await expect(openDesign).toBeVisible();
  await openDesign.click();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect.poll(() => page.evaluate(cid => (window as any).DesignSync.localCopyOf(cid)?.published?.cid, cid)).toBe(cid);
  await expect(page.locator('.city-switch-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('zagreb');
  expect(await page.evaluate(() => (window as any).getCurrentUserAgent().id)).toBe(actorId);
  expect(await page.evaluate(cid => {
    const w = window as any;
    const design = w.DesignSync.localCopyOf(cid);
    return { city: design.city, applied: w.isApplied(design), cid: w.DesignRecord.cidOf(design) };
  }, cid)).toEqual({ city: 'london', applied: false, cid });
});

for (const width of [1180, 390]) test(`Designs Browse keeps filtered draft and published cards reachable at ${width}px`, async ({ mockApi: page }) => {
  await page.setViewportSize({ width, height: 757 });
  await openCity(page);
  await page.evaluate(({ id, geometry }) => {
    (window as any).proposalStorage.addProposal({ goal: 'park', title: 'List option A', applied: true, cadastreParcelIds: [id], geometry, structureProposal: { kind: 'park', geometry } });
    (window as any).proposalStorage.addProposal({ goal: 'park', title: 'List option B', applied: false, cadastreParcelIds: [id], geometry, structureProposal: { kind: 'park', geometry } });
  }, { id: PARCEL_ID, geometry: PARCEL_GEOMETRY });
  const publishedContent = await page.evaluate(() => {
    const w = window as any;
    const proposal = w.proposalStorage.getAllProposals().find((item: any) => item.title === 'List option B');
    return w.DesignRecord.published(proposal);
  });
  const publishedCid = fileDesign(pageIndex(page), publishedContent);
  await page.evaluate(({ title, cid }) => {
    const w = window as any;
    const proposal = w.proposalStorage.getAllProposals().find((item: any) => item.title === title);
    w.DesignSync.markPublished(proposal, { cid, apiBase: w.resolveBackendBaseUrl(), publishedAt: new Date().toISOString() });
  }, { title: 'List option B', cid: publishedCid });
  await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  await expect(sheet.locator('#designs-browse-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(sheet.locator('#shareAppliedProposalsButton')).toBeVisible();
  // Lists (01268caee): publication and order are the only filters, behind the shared Filters disclosure.
  await sheet.locator('.lists-filter-details > summary').click();
  await expect(sheet.locator('#lists-controls select')).toHaveCount(2);
  const status = sheet.locator('select[data-list-filter="publication"]');
  await expect(status).toBeVisible();
  expect(await status.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).textContent?.trim())))
    .toEqual(['Draft & published', 'Draft', 'Published']);
  const list = sheet.locator('.lists-body');
  expect(await list.evaluate(el => el.clientHeight)).toBeGreaterThanOrEqual(100);
  const rows = sheet.locator('#proposal-list-host .lists-item');
  await expect(rows).toHaveCount(2);
  const draft = rows.filter({ hasText: 'List option A' });
  const published = rows.filter({ hasText: 'List option B' });
  await expect(draft.locator('.cb-badge--draft')).toBeVisible();
  await expect(draft.locator('.cb-badge--applied')).toBeVisible();
  await expect(published.locator('.cb-badge--published')).toBeVisible();
  await expect(published.locator('.cb-badge--applied')).toHaveCount(0);
  await status.selectOption('published');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('List option B');
  await status.selectOption('all');
  await expect(rows).toHaveCount(2);
  const details = draft.locator('.lists-item__open');
  await details.scrollIntoViewIfNeeded();
  await expect(details).toBeInViewport();
  await details.click();
  await expect(page.locator('#proposal-details-panel')).toBeVisible();
});

test('phone menus fit the viewport and dismiss; Designs separates publication from map application', async ({ mockApi: page }) => {
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
      await sheet.locator('.lists-filter-details > summary').click();
      await expect(sheet.locator('#lists-controls select')).toHaveCount(2);
      const status = sheet.locator('select[data-list-filter="publication"]');
      await expect(status).toBeVisible();
      expect(await status.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
        .toEqual(['all', 'draft', 'published']);
      expect((await status.locator('option').allTextContents()).map(label => label.trim()))
        .toEqual(['Draft & published', 'Draft', 'Published']);
    }
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.locator(`#${id}-button`)).toHaveAttribute('aria-expanded', 'false');
  }
});

test('an explicit World view failure explains recovery and leaves the map usable', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => { (window as any).WorldView.open = async () => { throw new Error('Fixture: WebGL unavailable'); }; });
  await page.locator('.map-search__chip').click();
  await expect(page.locator('#ephemeral-message-container')).toContainText('World view could not start.');
  await expect(page.locator('#map')).toBeVisible();
  await page.locator('#settings-button').click();
  await expect(page.locator('#settings-sheet')).toBeVisible();
});
