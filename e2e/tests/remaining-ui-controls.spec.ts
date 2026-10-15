// Cover reachable controls left outside the focused feature suites.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, showProposal, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
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
  await expect(page.locator('#rowhouse')).toBeVisible();
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
  test('block counterclockwise rotation changes the preview while keeping generated mode', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--buildings').click();
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    // Rotation and manual-shape controls are deliberately under the secondary-options disclosure.
    const moreOptions = page.locator('#blockify-modal .on-map-editor__more-options > summary');
    await moreOptions.click();
    const before = await renderedOutline(page, 'rgb(0, 123, 255)');
    expect(before).not.toBe('');
    await page.locator('#blockify-rotate-counterclockwise').click();
    await expect.poll(() => renderedOutline(page, 'rgb(0, 123, 255)')).not.toBe(before);
    await expect(page.locator('#blockify-manual-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

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
    await expect(details).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(similarId);
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
});
