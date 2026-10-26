// The Activity sheet, its explorer and the simulation controls. Live activity is about agreements
// and designs (plan-design-agreement.md, M3): GET /agent/activity from the page's index
// (mocks/shared-server.ts), an agreement's row opening its panel and scoping the explorer to it.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { cidOfObject, pageIndex } from '../helpers/mocks/shared-server';
import { fileIndexedAgreement, proposeOverPark } from '../helpers/agreements';
import { Page } from '@playwright/test';

const shortCid = (cid: string) => `${cid.slice(0, 12)}…${cid.slice(-6)}`;

// Simulation controls live in their own top-level Settings section.
async function openSimulation(page: Page) {
  await page.locator('#settings-button').click();
  const simulation = page.locator('#settings-sheet details.activity-simulation[data-section="game"]');
  await expect(simulation).toBeVisible();
  if (!(await simulation.evaluate((details: HTMLDetailsElement) => details.open))) await simulation.locator(':scope > summary').click();
  await expect(simulation).toHaveAttribute('open', '');
}

async function openActivityPanel(page: Page, options: Record<string, unknown> = {}) {
  await page.evaluate(opts => (window as any).openActivityPanel(opts), options);
  const panel = page.locator('#activity-sheet');
  await expect(panel).toBeVisible();
  return panel;
}

async function expandActivityFilters(panel: import('@playwright/test').Locator) {
  const details = panel.locator('#activity-panel-controls details').first();
  if (!(await details.evaluate((node: HTMLDetailsElement) => node.open))) await details.locator('> summary').click();
  await expect(details).toHaveAttribute('open', '');
}

test.describe('Activity and simulation controls @features', () => {
  for (const width of [1280, 390]) {
    test(`simulation play and pause stay circular at ${width}px`, async ({ mockApi: page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openCity(page);
      await openSimulation(page);
      const play = page.locator('#game-play-pause-btn');
      await expect(play).toBeVisible();
      await page.locator('#gameCheckbox').check();
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

  test('one Activity panel filters returned activity and keeps its ordinary filters after reopening', async ({ mockApi: page }) => {
    const requests: string[] = [];
    const cid = cidOfObject({ schema: 'agreement/v1', title: 'River park plan' });
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
          action: { type: 'propose', agreementCid: cid }, entity: { type: 'agreement', id: cid },
          source: 'live', message: 'Proposed the river park plan', ok: true,
        }] }),
      });
    });

    await openCity(page);
    const modal = await openActivityPanel(page);
    await expandActivityFilters(modal);
    await expect(modal.locator('#game-log-content')).toContainText('river park plan');
    await expect(page.locator('.game-log-modal')).toHaveCount(0);
    await expect(modal.locator('[role="tab"]')).toHaveCount(3);
    // The row names what it is about: an agreement, opened from its link.
    await expect(modal.locator(`#game-log-content .activity-entity-link[data-entity-type="agreement"][data-entity-id="${cid}"]`)).toHaveText('Open agreement');
    await modal.locator('[data-activity-filter-field="query"]').fill('no matching title');
    await expect(modal.locator('#game-log-content')).toContainText(/No matching activity/i);
    await modal.locator('[data-activity-filter-field="query"]').fill('river park');
    await expect(modal.locator('#game-log-content')).toContainText('river park plan');
    await modal.locator('[data-activity-view="actors"]').click();
    await expect(modal.locator('[data-activity-view="actors"]')).toHaveAttribute('aria-selected', 'true');
    await expect(modal.locator('[data-activity-actors]')).toBeVisible();
    await expect(modal.locator('[data-activity-actors]')).toContainText('Map Steward');
    await modal.locator('[data-activity-view="events"]').click();
    await expect(modal.locator('[data-activity-view="events"]')).toHaveAttribute('aria-selected', 'true');
    await expect(modal.locator('#game-log-content')).toBeVisible();
    await expect(modal.locator('[data-activity-actors]')).toBeHidden();
    await modal.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(modal.locator('[data-activity-filter-field="query"]')).toHaveValue('');
    await expect(modal.locator('#game-log-content')).toContainText('river park plan');
    await modal.locator('[data-activity-filter-field="query"]').fill('river park');
    await expect(modal.locator('#game-log-content')).toContainText('river park plan');
    const beforeRefresh = requests.length;
    await modal.locator('.activity-refresh').click();
    await expect.poll(() => requests.length).toBeGreaterThan(beforeRefresh);
    await expect(modal.locator('#game-log-content')).toContainText('river park plan');
    await modal.locator('[data-sheet-close]').click();
    await expect(modal).toBeHidden();
    await openActivityPanel(page);
    await expect(modal.locator('[data-activity-filter-field="query"]')).toHaveValue('river park');
    await expect(modal.locator('#game-log-content')).toContainText('river park plan');
    await expect(modal.locator('[data-activity-view="events"]')).toHaveAttribute('aria-selected', 'true');
    await modal.locator('[data-activity-view="watched"]').click();
    await expect(modal.locator('#activity-panel-controls')).toBeHidden();
    await expect(modal.locator('#activity-events-pane')).toBeHidden();
    await expect(modal.locator('#activity-watched-pane')).toBeVisible();
    await modal.locator('[data-activity-view="events"]').click();
    await expect(modal.locator('#activity-panel-controls')).toBeVisible();
    await expect(modal.locator('#activity-watched-pane')).toBeHidden();
    await expect(modal.locator('[data-activity-filter-field="query"]')).toHaveValue('river park');
    expect(requests.length).toBeGreaterThan(0);
  });

  test('the Activity sheet Actors action opens the actor view', async ({ mockApi: page }) => {
    await openCity(page);
    const panel = await openActivityPanel(page, { view: 'actors' });
    await expect(panel.locator('[data-activity-view="actors"]')).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('[data-activity-actors]')).toBeVisible();
    await panel.locator('[data-sheet-close]').click();
    await expect(panel).toBeHidden();
  });

  test('the command palette Actors and Events actions open their respective views', async ({ mockApi: page }) => {
    await openCity(page);
    await page.keyboard.press('Meta+k');
    const palette = page.locator('.command-palette-backdrop');
    await expect(palette).toBeVisible();
    await page.locator('.command-palette__input').fill('Actors');
    await page.locator('.command-palette__item').filter({ hasText: 'Actors' }).first().click();

    const panel = page.locator('#activity-sheet');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-activity-view="actors"]')).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('[data-activity-actors]')).toBeVisible();
    await panel.locator('[data-sheet-close]').click();
    await expect(panel).toBeHidden();

    await page.keyboard.press('Meta+k');
    await expect(palette).toBeVisible();
    await page.locator('.command-palette__input').fill('Events');
    await page.locator('.command-palette__item').filter({ hasText: 'Events' }).first().click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-activity-view="events"]')).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('#activity-events-pane')).toBeVisible();
  });

  test('ordinary filters are temporarily overridden by a deep scope and restored when it clears', async ({ mockApi: page }) => {
    await page.goto('/?city=zg&reduceMotion=1');
    const currentCity = await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId());
    const index = pageIndex(page);
    const first = fileIndexedAgreement(index, {
      title: 'Scoped north square', createdAt: '2026-10-20T09:00:00.000Z', community: true,
      row: { city: currentCity },
    });
    const firstRow = index.agreements.get(first.cid);
    if (firstRow) firstRow.city = currentCity;
    for (const designCid of first.designCids) {
      const design = index.designs.get(designCid);
      if (design) design.city = currentCity;
    }
    const second = fileIndexedAgreement(index, {
      title: 'Scoped south park', createdAt: '2026-10-21T09:00:00.000Z', community: true,
      row: { city: currentCity },
    });
    const secondRow = index.agreements.get(second.cid);
    if (secondRow) secondRow.city = currentCity;
    for (const designCid of second.designCids) {
      const design = index.designs.get(designCid);
      if (design) design.city = currentCity;
    }
    const panel = await openActivityPanel(page, {
      filter: { query: 'north square', cityScope: 'current', source: 'live' },
    });
    await expandActivityFilters(panel);
    const controls = panel.locator('#activity-panel-controls');
    await expect(controls.locator('[data-activity-filter-field="query"]')).toHaveValue('north square');
    await expect(controls.locator('[data-activity-filter-field="cityScope"]')).toHaveValue('current');
    await expect(controls.locator('[data-activity-filter-field="source"]')).toHaveValue('live');

    const row = panel.locator('#game-log-content .activity-entry').filter({ hasText: 'Scoped north square was proposed.' });
    await row.locator('details.activity-entry-meta > summary').click();
    await row.locator('[data-activity-scope="agreementCid"]').click();
    await expect(panel.locator('[data-activity-scope-chip]')).toBeVisible();
    await expect(panel.locator('#activity-panel-notices')).toContainText('Scoped results scan the most recent 1000 records per source.');
    await expect(controls.locator('[data-activity-filter-field="cityScope"]')).toHaveValue('all');
    await expect(controls.locator('[data-activity-filter-field="source"]')).toHaveValue('combined');
    await expect(controls.locator('[data-activity-filter-field="query"]')).toHaveValue('');

    await panel.locator('[data-activity-scope-chip] button').click();
    await expect(panel.locator('[data-activity-scope-chip]')).toBeHidden();
    await expect(controls.locator('[data-activity-filter-field="cityScope"]')).toHaveValue('current');
    await expect(controls.locator('[data-activity-filter-field="source"]')).toHaveValue('live');
    await expect(controls.locator('[data-activity-filter-field="query"]')).toHaveValue('north square');
    const restoredRows = panel.locator('#game-log-content .activity-entry');
    await expect(restoredRows).toHaveCount(2);
    await expect(restoredRows.filter({ hasText: 'Agreement Scoped north square was proposed.' })).toHaveCount(1);
    await expect(restoredRows.filter({ hasText: 'Design Scoped north square park was published.' })).toHaveCount(1);
    expect(index.requests.some(request => request.method === 'GET' && request.path.includes('/agent/activity?')
      && request.path.includes(`agreement=${first.cid}`))).toBe(true);
  });

  test('current-city and all-city feeds include only matching activity, with unlocated rows available in all cities', async ({ mockApi: page }) => {
    await page.goto('/?city=zg&reduceMotion=1');
    const { currentCity, otherCity } = await page.evaluate(() => {
      const manager = (window as any).CityConfigManager;
      const current = manager.getCurrentCityId();
      const other = manager.getAvailableCities().find((city: any) => city.id !== current)?.id;
      if (!other) throw new Error('The city directory needs at least two configured cities for this test');
      return { currentCity: current, otherCity: other };
    });
    const index = pageIndex(page);
    const addCityAgreement = (title: string, createdAt: string, city: string | null) => {
      const fixture = fileIndexedAgreement(index, {
        title, createdAt, community: true, row: { city },
      });
      const agreement = index.agreements.get(fixture.cid);
      if (agreement) agreement.city = city;
      for (const designCid of fixture.designCids) {
        const design = index.designs.get(designCid);
        if (design) design.city = city;
      }
    };
    addCityAgreement('Current city activity row', '2026-10-20T09:00:00.000Z', currentCity);
    addCityAgreement('Other city activity row', '2026-10-21T09:00:00.000Z', otherCity);
    addCityAgreement('Unlocated activity row', '2026-10-22T09:00:00.000Z', null);
    const panel = await openActivityPanel(page);
    await expandActivityFilters(panel);
    const controls = panel.locator('#activity-panel-controls');
    await controls.locator('[data-activity-filter-field="source"]').selectOption('live');
    await controls.locator('[data-activity-filter-field="cityScope"]').selectOption('current');
    const rows = panel.locator('#game-log-content .activity-entry');
    await expect(rows.filter({ hasText: 'Current city activity row was proposed.' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Other city activity row was proposed.' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'Unlocated activity row was proposed.' })).toHaveCount(0);

    await controls.locator('[data-activity-filter-field="cityScope"]').selectOption('all');
    await expect(rows.filter({ hasText: 'Other city activity row was proposed.' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Unlocated activity row was proposed.' })).toHaveCount(1);
    expect(index.requests.some(request => request.method === 'GET'
      && request.path === `/agent/activity?limit=250&city=${currentCity}`)).toBe(true);
  });

  test('activity labels update in Spanish and Croatian, and folded filters fit on mobile', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCity(page);
    const panel = await openActivityPanel(page);
    const eventsTab = panel.locator('#activity-events-tab');
    const english = await eventsTab.innerText();
    await page.evaluate(async () => (window as any).i18n.setLanguage('es'));
    await expect(eventsTab).toHaveText('Eventos');
    const spanish = await eventsTab.innerText();
    expect(spanish).toBe('Eventos');
    await page.evaluate(async () => (window as any).i18n.setLanguage('hr'));
    await expect(eventsTab).toHaveText('Događaji');
    const croatian = await eventsTab.innerText();
    expect(croatian).toBe('Događaji');
    expect(spanish).not.toBe(english);
    expect(croatian).not.toBe(spanish);
    await page.evaluate(async () => (window as any).i18n.setLanguage('en'));
    await expect(eventsTab).toHaveText('Events');

    const filterDetails = panel.locator('#activity-panel-controls details').first();
    await expect(filterDetails).not.toHaveAttribute('open', '');
    const width = await panel.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
    await expect(panel.locator('#activity-events-pane')).toBeVisible();
  });

  test('an activity deep link opens the explorer scoped to one agreement, and clearing the scope shows the rest', async ({ mockApi: page }) => {
    const index = pageIndex(page);
    // Two community agreements over parcel 2311 proposed elsewhere, each with its design.
    const first = fileIndexedAgreement(index, { title: 'North square agreement', createdAt: '2026-10-20T09:00:00.000Z', community: true, author: 'Activity fixture' });
    const second = fileIndexedAgreement(index, { title: 'South park agreement', createdAt: '2026-10-21T09:00:00.000Z', community: true, author: 'Activity fixture' });
    await page.goto(`/?city=zg&reduceMotion=1&activity=agreement:${first.cid}`);
    const modal = page.locator('#activity-sheet');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    const chip = modal.locator('[data-activity-scope-chip]');
    await expect(chip).toBeVisible();
    await expect(chip.locator('span')).toHaveText(`Agreement: ${shortCid(first.cid)}`);
    // The scope is the API's: it is asked for this agreement's activity only.
    await expect.poll(() => index.requests.some(request => request.method === 'GET'
      && request.path === `/agent/activity?limit=250&agreement=${first.cid}`)).toBe(true);
    const rows = modal.locator('#game-log-content .activity-entry');
    await expect(rows.filter({ hasText: 'Agreement North square agreement was proposed.' })).toHaveCount(1, { timeout: 30_000 });
    await expect(rows.filter({ hasText: 'South park agreement' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'was published.' })).toHaveCount(0);
    // Clearing the scope shows the whole feed: both agreements and their designs.
    await chip.getByRole('button', { name: 'Clear scope' }).click();
    await expect(chip).toBeHidden();
    await expect(rows.filter({ hasText: 'Agreement South park agreement was proposed.' })).toHaveCount(1, { timeout: 30_000 });
    await expect(rows.filter({ hasText: 'Design North square agreement park was published.' })).toHaveCount(1);
    await expect(modal.locator(`.activity-entity-link[data-entity-type="design"][data-entity-id="${second.designCid}"]`)).toHaveText('Open design');
  });

  test('an agreement row narrows the explorer to it and opens its panel; a design row opens the design', async ({ mockApi: page }) => {
    test.setTimeout(150_000);
    await openCity(page);
    const title = 'Riverside park agreement';
    // A community agreement over a park applied here, proposed from this device: the feed's agreement and design.
    const { cid, designCid, parkId, parkTitle } = await proposeOverPark(page, { title, author: 'Activity fixture' });
    const index = pageIndex(page);
    await openActivityPanel(page);
    const modal = page.locator('#activity-sheet');
    await expect(modal).toBeVisible();
    const rows = modal.locator('#game-log-content .activity-entry');
    const agreementRow = rows.filter({ hasText: `Agreement ${title} was proposed.` });
    await expect(agreementRow).toHaveCount(1, { timeout: 30_000 });
    await expect(rows.filter({ hasText: `Design ${parkTitle} was published.` })).toHaveCount(1);

    // Its details hold the scope: all activity on this agreement, asked of the API.
    await agreementRow.locator('details.activity-entry-meta > summary').click();
    await agreementRow.locator('[data-activity-scope="agreementCid"]').click();
    await expect(modal.locator('[data-activity-scope-chip] span')).toHaveText(`Agreement: ${shortCid(cid)}`);
    await expect.poll(() => index.requests.some(request => request.method === 'GET'
      && request.path === `/agent/activity?limit=250&agreement=${cid}`)).toBe(true);
    await expect(rows.filter({ hasText: 'was published.' })).toHaveCount(0);

    // Its link opens the agreement over the map.
    await agreementRow.locator(`.activity-entity-link[data-entity-type="agreement"][data-entity-id="${cid}"]`).click();
    await expect(modal).toBeHidden();
    const panel = page.locator('section#agreement-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#agreement-panel-title')).toHaveText(title);
    await expect(panel.locator('code.agreement-panel-cid')).toHaveAttribute('title', cid);
    await panel.locator('[data-agreement-action="close"]').click();
    await expect(panel).toBeHidden();

    // A design's link opens the design this device holds under that CID.
    await openActivityPanel(page);
    await expect(modal).toBeVisible();
    await modal.locator('[data-activity-scope-chip] button').click();
    await expect(modal.locator('[data-activity-scope-chip]')).toBeHidden();
    await modal.locator(`.activity-entity-link[data-entity-type="design"][data-entity-id="${designCid}"]`).click({ timeout: 30_000 });
    await expect(modal).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection?.getKey?.())).toBe(parkId);
  });

  test('simulation settings change the interval, play advances turns, pause stops it, and New Game confirms reset', async ({ mockApi: page }) => {
    await openCity(page);
    await openSimulation(page);
    const settings = page.locator('#settings-sheet .activity-simulation-settings');
    // The on/off switch is the section's first row, outside the settings fold.
    const gameEnabled = page.locator('#settings-sheet .activity-simulation-switch #gameCheckbox');
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
    const confirm = page.locator('.cb-dialog--confirm');
    const confirmText = /start a NEW game\?/i;
    await newGame.click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(confirmText);
    await confirm.locator('[data-action-id="cancel"]').click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator('#game-turns')).toHaveText(beforeReset);

    await newGame.click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(confirmText);
    await confirm.locator('[data-action-id="ok"]').click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => page.locator('#game-turns').innerText()).toBe('0');
    await expect(play).toHaveAttribute('aria-pressed', 'false');
  });
});
