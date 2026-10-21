// Cover reachable controls left outside the focused feature suites.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, showProposal, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { installAreaMonitorSpaFallback } from '../helpers/mocks/area-monitor-server';
import { selectNativeOption } from '../helpers/controls';
import { waitForMapReady } from '../helpers/app';
import type { Page } from '@playwright/test';

const BLOCK_PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];

async function renderedOutline(page: Page, stroke: string): Promise<string> {
  return page.evaluate(expectedStroke => {
    const pane = (window as any).map?.getPane?.('onMapEditorPane');
    const paths = Array.from((pane?.querySelectorAll('path') || []) as NodeListOf<SVGPathElement>);
    const candidates = paths.map(path => {
      const rect = path.getBoundingClientRect();
      return { path, area: rect.width * rect.height, stroke: getComputedStyle(path).stroke };
    }).filter(candidate => candidate.stroke === expectedStroke && candidate.area > 16)
      .sort((a, b) => b.area - a.area);
    // Compare only the primary live Leaflet outline's rendered geometry. The SVG path data omits
    // proposal IDs and other volatile feature properties, while Undo must restore the same shape.
    return candidates[0]?.path.getAttribute('d') || '';
  }, stroke);
}

async function openRowHouseEditor(page: Page): Promise<void> {
  await installLayerDatasets(page);
  await openCity(page);
  await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, BLOCK_PARCEL_IDS);
  await openParcel(page, 'info', BLOCK_PARCEL_IDS[0]);
  await page.locator('.multi-select-detect-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
  await page.locator('#parcel-info-panel .close-button').click();
  await page.locator('#selection-tray [data-command="selection.propose"]').click();
  await page.locator('.parcel-build-btn--row').click();
  await expect(page.locator('#rowhouse').locator('.on-map-editor__panel')).toBeVisible();
  await expect(page.locator('#btn-rowhouse-done')).toBeEnabled({ timeout: 20_000 });
}

async function openProfile(page: Page, username: string) {
  await page.locator('#username-display').click();
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) {
    await page.locator('#username-input').fill(username);
    await page.locator('#welcome-submit-btn').click();
  }
  await page.locator('#username-display').click();
  const profile = page.locator('.agent-dialog-modal');
  await expect(profile).toBeVisible();
  return profile;
}

test.describe('Remaining UI controls @features', () => {
  test('row-house Undo restores the prior generated preview after rotation', async ({ mockApi: page }) => {
    await openRowHouseEditor(page);
    const before = await renderedOutline(page, 'rgb(13, 110, 253)');
    expect(before).not.toBe('');
    await page.locator('#rowhouse-rotate-counterclockwise').click();
    await expect.poll(() => renderedOutline(page, 'rgb(13, 110, 253)')).not.toBe(before);
    // The Leaflet-owned Undo control lives in the map container beside the modal.
    const undo = page.locator('.geom-undo-button');
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect.poll(() => renderedOutline(page, 'rgb(13, 110, 253)')).toBe(before);
    await expect(undo).toBeDisabled();
  });

  test('site card and proposal panel minimize, switch tabs, and close independently', async ({ mockApi: page }) => {
    await openCity(page);
    await clickMapPoint(page, 15.9822, 45.80025);
    await page.locator('#parcel-menu [data-command="parcel.useAsSite"]').click();
    const card = page.locator('#site-panel');
    await expect(card).toBeVisible();
    const cardMinimize = card.locator('[data-site-action="minimize"]');
    await cardMinimize.click();
    await expect(cardMinimize).toHaveAttribute('aria-expanded', 'false');
    await expect(card).toHaveClass(/is-minimized/);
    await cardMinimize.click();
    await expect(cardMinimize).toHaveAttribute('aria-expanded', 'true');

    await card.locator('[data-site-action="propose"]').click();
    const panel = page.locator('#site-info-panel');
    await expect(panel).toBeVisible();
    const proposalsTab = panel.locator('[data-site-tab="proposals"]');
    await proposalsTab.click();
    await expect(proposalsTab).toHaveAttribute('aria-selected', 'true');
    const panelMinimize = panel.locator('[data-site-action="minimize-propose"]');
    await panelMinimize.click();
    await expect(panelMinimize).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveClass(/is-minimized/);
    await panelMinimize.click();
    await panel.locator('[data-site-action="close-propose"]').click();
    await expect(panel).toBeHidden();
    await expect(card).toBeVisible();
  });

  test('proposal similarity opens the matching proposal details', async ({ mockApi: page }) => {
    await openCity(page);
    const { sourceId, similarId } = await page.evaluate(({ parcelId, geometry }) => {
      const w = window as any;
      const sourceId = w.proposalStorage.addProposal({
        title: 'Unapplied park source for navigation', goal: 'park', city: 'zagreb', applied: false,
        lifecycleStatus: 'Active', cadastreParcelIds: [parcelId],
        structureProposal: { kind: 'park', applied: false, geometry }, geometry,
      });
      const similarId = w.proposalStorage.addProposal({
        title: 'Related park proposal for navigation', goal: 'park', city: 'zagreb', applied: false,
        lifecycleStatus: 'Active', cadastreParcelIds: [parcelId],
        structureProposal: { kind: 'park', applied: false, geometry }, geometry,
      });
      return { sourceId, similarId };
    }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await showProposal(page, sourceId);
    const details = page.locator('#proposal-details-panel');
    const expand = details.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    const moreActions = details.locator('summary').filter({ hasText: 'More actions' });
    if (await moreActions.isVisible()) await moreActions.click();
    await page.locator('.btn-counterpropose-proposal').click();
    const dialog = page.locator('.create-proposal-modal:visible');
    await expect(dialog).toBeVisible();
    const similar = dialog.locator(`.proposal-similar-item[data-proposal-id="${similarId}"]`);
    await expect(similar).toBeVisible();
    await similar.click();
    await expect(page.locator('#planning-inspector')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(similarId);
    // Opening a similar proposal intentionally keeps the create dialog open; dismiss it before
    // the helper clicks Proposal actions in the inspector underneath.
    await dialog.getByRole('button', { name: 'Close proposal dialog', exact: true }).click();
    await expect(dialog).toBeHidden();
    await showProposal(page, similarId);
    await expect(details).toBeVisible();
    await expect(details).toContainText('Related park proposal for navigation');
  });

  test('logout dialog close keeps the profile open', async ({ mockApi: page }) => {
    await openCity(page);
    const profile = await openProfile(page, 'Logout close control actor');
    await profile.locator('.logout-button').click();
    const modal = page.locator('#logout-modal');
    await expect(modal).toBeVisible();
    await modal.locator('[data-logout-close]').click();
    await expect(modal).toBeHidden();
    await expect(profile).toBeVisible();
  });

  test('track speed picker close does not start a corridor', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--track').click();
    const modal = page.locator('#track-speed-modal');
    await expect(modal).toBeVisible();
    await modal.locator('[data-track-speed-close]').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#road-drawing-controls')).toBeHidden();
  });

  test('parcel coverage header close returns to Settings', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#settings-button').click();
    await page.locator('#showParcelCoverageButton').click();
    const modal = page.locator('#parcel-coverage-modal');
    await expect(modal).toBeVisible();
    await modal.locator('[data-parcel-coverage-close]').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#settings-sheet')).toBeVisible();
  });

  test('status log header close returns to the Activity sheet', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).updateStatus('Status close control fixture'));
    await page.locator('#activity-button').click();
    const technical = page.locator('#activity-sheet details:has(> summary[data-i18n-key="mapShell.reorg.statusLog"])');
    await technical.locator('> summary').click();
    await technical.locator('.status-bar').click();
    await expect(technical.locator('#status-log-expanded')).toBeVisible();
    await technical.locator('[data-status-open-log]').click();
    const modal = page.locator('#status-log-modal');
    await expect(modal).toBeVisible();
    await modal.locator('[data-status-log-close]').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#activity-sheet')).toBeVisible();
  });

  test('activity explorer source, actor, controller, action, and result fields filter events', async ({ mockApi: page }) => {
    await page.route('**/agent/activity**', route => route.fulfill({ json: { events: [
      {
        id: 'filter-human-publish', occurredAt: '2026-10-01T12:00:00Z', recordedAt: '2026-10-01T12:00:00Z',
        actor: { id: 'human-1', name: 'Filter Human', kind: 'human', controller: 'human' },
        action: { type: 'publish' }, entity: { type: 'proposal', id: 'filter-proposal-1' },
        source: 'live', message: 'Published filter test proposal', ok: true,
      },
      {
        id: 'filter-agent-create', occurredAt: '2026-10-01T11:00:00Z', recordedAt: '2026-10-01T11:00:00Z',
        actor: { id: 'agent-1', name: 'Filter Algorithm', kind: 'agent', controller: 'algorithm' },
        action: { type: 'create' }, entity: { type: 'proposal', id: 'filter-proposal-2' },
        source: 'live', message: 'Created filter test proposal', ok: true,
      },
      {
        id: 'filter-agent-failure', occurredAt: '2026-10-01T10:00:00Z', recordedAt: '2026-10-01T10:00:00Z',
        actor: { id: 'agent-2', name: 'Filter LLM', kind: 'agent', controller: 'llm' },
        action: { type: 'publish' }, entity: { type: 'proposal', id: 'filter-proposal-3' },
        source: 'live', message: 'Failed filter test proposal', ok: false,
      },
    ] } }));

    await openCity(page);
    await page.locator('#activity-button').click();
    await page.locator('#activity-explorer-button').click();
    const modal = page.locator('.game-log-modal');
    await expect(modal).toBeVisible();
    const content = modal.locator('#game-log-content');
    await expect(content).toContainText('Published filter test proposal');
    await expect(content).toContainText('Created filter test proposal');
    await expect(content).toContainText('Failed filter test proposal');

    const field = (name: string) => modal.locator(`[data-activity-filter-field="${name}"]`);
    await selectNativeOption(field('source'), 'simulation');
    await expect(content).not.toContainText('Published filter test proposal');
    await selectNativeOption(field('source'), 'live');
    await expect(content).toContainText('Published filter test proposal');

    await selectNativeOption(field('kind'), 'human');
    await expect(content).toContainText('Published filter test proposal');
    await expect(content).not.toContainText('Created filter test proposal');
    await selectNativeOption(field('kind'), 'agent');
    await expect(content).toContainText('Created filter test proposal');
    await expect(content).not.toContainText('Published filter test proposal');

    await selectNativeOption(field('controller'), 'llm');
    await expect(content).toContainText('Failed filter test proposal');
    await expect(content).not.toContainText('Created filter test proposal');

    await selectNativeOption(field('controller'), 'algorithm');
    await selectNativeOption(field('action'), 'create');
    await expect(content).not.toContainText('Failed filter test proposal');
    await expect(content).toContainText('Created filter test proposal');

    await selectNativeOption(field('status'), 'failed');
    await expect(content).toContainText(/No matching activity/i);
    await selectNativeOption(field('status'), 'success');
    await expect(content).toContainText('Created filter test proposal');
    await selectNativeOption(field('controller'), 'all');
    await selectNativeOption(field('kind'), 'all');
    await selectNativeOption(field('action'), 'publish');
    await selectNativeOption(field('status'), 'failed');
    await expect(content).toContainText('Failed filter test proposal');
    await expect(content).not.toContainText('Published filter test proposal');
    await selectNativeOption(field('status'), 'success');
    await expect(content).toContainText('Published filter test proposal');
    await expect(content).not.toContainText('Failed filter test proposal');
  });

  test('actor explorer search narrows profiles and activity, then restores the list', async ({ mockApi: page }) => {
    await page.route('**/agent/activity**', route => route.fulfill({ json: { events: [
      {
        id: 'search-ari', occurredAt: '2026-10-01T12:00:00Z', recordedAt: '2026-10-01T12:00:00Z',
        actor: { id: 'search-human', name: 'Ari Steward', kind: 'human', controller: 'human' },
        action: { type: 'publish' }, entity: { type: 'proposal', id: 'search-park' },
        source: 'proposal', message: 'Published a river park', ok: true,
      },
      {
        id: 'search-agent', occurredAt: '2026-10-01T11:00:00Z', recordedAt: '2026-10-01T11:00:00Z',
        actor: { id: 'search-agent', name: 'Block Planner', kind: 'agent', controller: 'algorithm' },
        action: { type: 'create' }, entity: { type: 'proposal', id: 'search-square' },
        source: 'agent', message: 'Created a square proposal', ok: true,
      },
    ] } }));
    await page.goto('/actor-explorer.html');
    await expect(page.locator('.ae-event')).toHaveCount(2);
    const search = page.getByRole('searchbox', { name: 'Search actor, proposal, run or transaction' });
    await search.fill('Ari');
    await expect(page.locator('.ae-event')).toHaveCount(1);
    await expect(page.locator('.ae-event')).toContainText('Published a river park');
    await expect(page.locator('.ae-profile-grid')).toContainText('Ari Steward');
    await search.fill('search-square');
    await expect(page.locator('.ae-event')).toHaveCount(1);
    await expect(page.locator('.ae-event')).toContainText('Created a square proposal');
    await search.fill('');
    await expect(page.locator('.ae-event')).toHaveCount(2);
  });

  test('both watched-area name filters narrow their real lists', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#activity-button').click();
    const inlineList = page.locator('#activity-watched-areas-list');
    const inlineFilter = inlineList.locator('.area-monitor-list-filter');
    await expect(inlineFilter).toBeVisible();
    await inlineFilter.fill('vukovarska');
    await expect(inlineList.locator('.area-monitor-list-item:not([hidden])')).toHaveCount(1);
    await expect(inlineList.locator('.area-monitor-list-item:not([hidden])')).toContainText('Vukovarska Corridor');
    await inlineFilter.fill('no such area');
    await expect(inlineList.locator('.area-monitor-list-message:not([hidden])')).toContainText('No monitors match');

    await installAreaMonitorSpaFallback(page);
    await page.goto('/monitors/1?city=zg', { waitUntil: 'domcontentloaded' });
    const detail = page.locator('#area-monitor-detail-panel');
    await expect(detail).toBeVisible();
    await detail.locator('#am-list-others').click();
    const modal = page.locator('#area-monitor-list-modal');
    const modalFilter = modal.locator('#am-list-filter');
    await expect(modalFilter).toBeVisible();
    await modalFilter.fill('jarunski');
    await expect(modal.locator('.area-monitor-list-item:not([hidden])')).toHaveCount(1);
    await expect(modal.locator('.area-monitor-list-item:not([hidden])')).toContainText('Zapadni Jarunski Most');
    await modalFilter.fill('unmatched');
    await expect(modal.locator('#am-list-no-match')).toBeVisible();
  });

  test('mint parcel selection checkboxes determine which parcels are submitted', async ({ mockApi: page }) => {
    await page.route('**/metadata', route => route.fulfill({ json: { metadataUrl: 'ipfs://e2e-selected-parcel.json' } }));
    await openCity(page);
    await page.evaluate(() => {
      const w = window as any;
      w.solanaWalletManager = { getState: () => ({ status: 'connected', accounts: ['e2e-owner'], cluster: 'devnet' }) };
      w.resolveParcelNftAddressSolana = async () => '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';
      w.__mintedParcelIds = [];
      w.mintParcelSolana = async (parcelId: string) => {
        w.__mintedParcelIds.push(parcelId);
        return { txHash: 'e2e-parcel-mint' };
      };
      const feature = (parcelId: string) => ({ type: 'Feature', properties: { parcelId }, geometry: null });
      void w.ParcelsUIClaim.openParcelMintModal({ parcels: [
        { parcelId: 'TEST-PARCEL-1', parcelName: 'Test Parcel One', feature: feature('TEST-PARCEL-1') },
        { parcelId: 'TEST-PARCEL-2', parcelName: 'Test Parcel Two', feature: feature('TEST-PARCEL-2') },
      ] });
    });
    const dialog = page.locator('.parcel-mint-modal');
    await expect(dialog).toBeVisible();
    const first = dialog.locator('#parcel-mint-checkbox-0');
    const second = dialog.locator('#parcel-mint-checkbox-1');
    await expect(first).toBeChecked();
    await expect(second).toBeChecked();
    await first.uncheck();
    await expect(first).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Mint', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Mint successful');
    await expect.poll(() => page.evaluate(() => (window as any).__mintedParcelIds)).toEqual(['TEST-PARCEL-2']);
  });

  test('suggested-layout checkbox draws and clears the generated 2D floor plan', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(async ({ parcelId, geometry }) => {
      const w = window as any;
      await w.CadastralParcelRepository.ensureIds([parcelId]);
      w.proposedBuildings = [{
        type: 'Feature', id: 'suggested-layout-control-fixture', geometry,
        properties: { parcelId, height: 10, levels: 3, name: 'Suggested layout fixture' },
      }];
      w.dispatchEvent(new Event('proposedBuildingsUpdated'));
    }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await page.locator('#layers-button').click();
    const checkbox = page.locator('#showSuggestedLayouts');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    expect(await page.evaluate(() => (window as any).__suggestedLayouts2D.isEnabled())).toBe(false);
    await checkbox.check();
    await expect.poll(() => page.evaluate(() => (window as any).__suggestedLayouts2D.isEnabled())).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__suggestedLayouts2D.snapshot().drawn)).toBeGreaterThan(0);
    await checkbox.uncheck();
    await expect.poll(() => page.evaluate(() => (window as any).__suggestedLayouts2D.isEnabled())).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as any).__suggestedLayouts2D.snapshot().drawn)).toBe(0);
  });

  test('station height and bearing controls synchronize and save their new values', async ({ mockApi: page }) => {
    await openCity(page);
    const stationId = await page.evaluate(async ({ parcelId, geometry }) => {
      const w = window as any;
      await w.CadastralParcelRepository.ensureIds([parcelId]);
      const center = [15.9822, 45.80025];
      return w.proposalStorage.addProposal({
        proposalId: 'remaining-controls-station', title: 'Editable elevated station', description: 'Station input test.',
        offer: 100, offerCurrency: 'EUR', city: 'zg', goal: 'station', lifecycleStatus: 'Active', applied: false,
        cadastreParcelIds: [parcelId], structureProposal: {
          kind: 'station', stationType: 'elevated', center, bearing: 37, platformHeightM: 12,
          geometry, modelVersion: w.TransitStationModels?.MODEL_VERSION || 1,
        },
      });
    }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await showProposal(page, stationId);
    await page.locator('#proposal-details-footer .btn-edit-geometry').click();
    const editor = page.locator('#station-geometry-editor');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    const bearingRange = editor.locator('[data-station-editor-bearing-range]');
    const bearing = editor.locator('[data-station-editor-bearing]');
    const height = editor.locator('[data-station-editor-height]');
    await bearing.fill('52');
    await bearing.press('Tab');
    await expect(bearingRange).toHaveValue('52');
    await bearingRange.focus();
    await page.keyboard.press('ArrowRight');
    await expect(bearingRange).toHaveValue('53');
    await expect(bearing).toHaveValue('53');
    await height.fill('14.5');
    await height.press('Tab');
    await expect(height).toHaveValue('14.5');
    await editor.locator('[data-station-editor-action="save"]').click();
    // A local station is saved in place: same record, same id.
    await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.structureProposal?.bearing, stationId)).toBe(53);
    const saved = await page.evaluate(id => {
      const proposal = (window as any).proposalStorage.getProposal(id);
      return {
        id: proposal?.proposalId,
        bearing: proposal?.structureProposal?.bearing,
        height: proposal?.structureProposal?.platformHeightM,
        geometry: proposal?.structureProposal?.geometry,
      };
    }, stationId);
    expect(saved.id).toBe(stationId);
    expect(saved.bearing).toBe(53);
    expect(saved.height).toBe(14.5);
    expect(saved.geometry).toBeTruthy();
    await page.reload();
    await openCity(page);
    const reloaded = await page.evaluate(id => {
      const proposal = (window as any).proposalStorage.getAllProposals().find((item: any) => item.proposalId === id);
      return {
        bearing: proposal?.structureProposal?.bearing,
        height: proposal?.structureProposal?.platformHeightM,
        geometry: proposal?.structureProposal?.geometry,
      };
    }, saved.id);
    expect(reloaded).toEqual({ bearing: 53, height: 14.5, geometry: saved.geometry });
  });

  test('proposal epoch card validates and saves a custom year through its real selector', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
      title: 'Custom epoch park fixture', goal: 'park', city: 'zagreb', applied: false,
      lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], epochYear: 2035,
      geometry, structureProposal: { kind: 'park', applied: false, geometry },
    }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await showProposal(page, proposalId);
    await page.locator('#proposals-button').click();
    const select = page.locator(`.proposal-epoch-card-select[data-proposal-id="${proposalId}"]`);
    await expect(select).toBeVisible();
    await selectNativeOption(select, 'custom');
    const input = page.locator('.cb-dialog__prompt');
    await expect(input).toHaveValue('2077');
    await input.fill('2000');
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.cb-dialog--prompt')).toBeVisible();
    await input.fill('2077');
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    await expect.poll(() => page.evaluate(id => {
      const storage = (window as any).proposalStorage;
      const proposal = storage.getAllProposals().find((item: any) => item.proposalId === id || item.id === id);
      return proposal?.epochYear ?? proposal?.epoch?.year ?? null;
    }, proposalId)).toBe(2077);
    await expect(page.locator('.cb-dialog--prompt')).toHaveCount(0);
  });
});
