import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, zoomToParcelLevel } from '../helpers/app';

test.describe('Proposal details panel @features', () => {
  test('minimizing keeps the proposal selected across the next map action', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);

    const setup = await page.evaluate(async () => {
      const w = window as any;
      if (typeof w.ingestParcelFeatures !== 'function') {
        return { error: 'ingestParcelFeatures missing' };
      }
      if (!w.proposalStorage || typeof w.proposalStorage.addProposal !== 'function') {
        return { error: 'proposalStorage.addProposal missing' };
      }
      if (typeof w.selectAndHighlightProposal !== 'function') {
        return { error: 'selectAndHighlightProposal missing' };
      }

      const parcelId = 'HR-335754-MIN-0001';
      await w.ingestParcelFeatures([{
        type: 'Feature',
        properties: {
          parcelId,
          parcel_id: parcelId,
          id: parcelId,
          BROJ_CESTICE: 'MIN-0001',
          maticni_broj_ko: '335754',
          MATICNI_BROJ_KO: '335754',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [15.9819, 45.8000],
            [15.9825, 45.8000],
            [15.9825, 45.8005],
            [15.9819, 45.8005],
            [15.9819, 45.8000],
          ]],
        },
      }], { replaceExisting: false });

      const proposalSeed = {
        proposalId: 'e2e-proposal-minimize',
        title: 'E2E proposal minimize',
        goal: 'parcelBased',
        status: 'Active',
        parentParcelIds: [parcelId],
      };
      const added = w.proposalStorage.addProposal(proposalSeed);
      const proposalId = added?.proposalId || proposalSeed.proposalId;

      w.selectAndHighlightProposal(proposalId, parcelId, false, true);

      return { proposalId, parcelId };
    });

    expect(setup.error, `setup: ${setup.error}`).toBeUndefined();

    const panel = page.locator('#proposal-details-panel');
    const minimizeButton = panel.locator('#proposal-details-minimize');
    const body = panel.locator('.panel-body');

    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/is-minimized/);
    await expect(minimizeButton).toHaveAttribute('aria-expanded', 'false');
    await expect(body).toBeHidden();

    await minimizeButton.click();

    await expect(panel).not.toHaveClass(/is-minimized/);
    await expect(minimizeButton).toHaveAttribute('aria-expanded', 'true');
    await expect(body).toBeVisible();

    await minimizeButton.click();

    await expect(panel).toHaveClass(/is-minimized/);
    await expect(minimizeButton).toHaveAttribute('aria-expanded', 'false');
    await expect(body).toBeHidden();

    await page.evaluate(() => new Promise<void>((resolve) => {
      const w = window as any;
      if (!w.map || typeof w.map.once !== 'function' || typeof w.map.panBy !== 'function') {
        resolve();
        return;
      }
      w.map.once('moveend', () => resolve());
      w.map.panBy([120, 0], { animate: false });
    }));

    const stateAfterPan = await page.evaluate(() => {
      const w = window as any;
      const panel = document.getElementById('proposal-details-panel');
      const panelBody = panel ? panel.querySelector('.panel-body') : null;
      return {
        proposalId: w.currentlyHighlightedProposalId || null,
        selectedParcelId: w.selectedParcelInProposal || null,
        panelVisible: !!(panel && panel.classList.contains('visible')),
        panelMinimized: !!(panel && panel.classList.contains('is-minimized')),
        bodyHidden: !!(panelBody && panelBody.hidden),
      };
    });

    expect(stateAfterPan.proposalId).toBe(setup.proposalId);
    expect(stateAfterPan.selectedParcelId).toBe(setup.parcelId);
    expect(stateAfterPan.panelVisible).toBe(true);
    expect(stateAfterPan.panelMinimized).toBe(true);
    expect(stateAfterPan.bodyHidden).toBe(true);

    await minimizeButton.click();
    await expect(minimizeButton).toHaveAttribute('aria-expanded', 'true');
    await expect(body).toBeVisible();
  });
});
