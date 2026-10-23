// A deliberately deferred application makes the gap after Done observable without timing races.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';

for (const mode of ['2d', 'model']) {
  test(`Done keeps the ${mode} design visible until application finishes`, async ({ mockApi: page }, testInfo) => {
    await mockBuildingScene(page);
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--single').click();
    await expect(page.locator('#single-building-confirm')).toBeEnabled();
    if (mode === 'model') {
      await page.locator('#mode-3d-toggle').click();
      await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
    }
    await page.evaluate(() => {
      const w = window as any;
      const apply = w.ProposalManager.applyProposal;
      let pause = true;
      w.ProposalManager.applyProposal = async function (...args: any[]) {
        if (pause) {
          pause = false;
          await new Promise<void>(resolve => { w.releaseSaveHandoff = resolve; });
        }
        return apply.apply(this, args);
      };
    });
    await page.locator('#single-building-confirm').click();
    await expect(page.locator('#single-building-editor')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => typeof (window as any).releaseSaveHandoff)).toBe('function');
    expect(await page.evaluate(() => (window as any).activeProposalDraftComparison?.saving)).toBe(true);
    // The draft is already consumed, so this also checks that the preview owns its geometry.
    expect(await page.evaluate(() => (window as any).proposalDraftStore.getDraft((window as any).activeProposalDraftComparison.draftId))).toBeNull();
    if (mode === '2d') {
      await expect(page.locator('.proposal-draft-preview-geometry').first()).toBeVisible();
    } else {
      await expect.poll(() => page.evaluate(() => {
        let count = 0;
        (window as any).getThreeModeInternals().scene.traverse((object: any) => {
          if (object.isMesh && object.renderOrder === 9200) count++;
        });
        return count;
      })).toBeGreaterThan(0);
    }
    await page.screenshot({ path: testInfo.outputPath('saving-preview.png') });
    await page.evaluate(() => (window as any).releaseSaveHandoff());
    await expect.poll(() => page.evaluate(() => (window as any).activeProposalDraftComparison)).toBeNull();
    await expect(page.locator('.proposal-draft-preview-geometry')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const w = window as any;
      return w.proposalStorage.getAllProposals().filter((proposal: any) => w.isProposalApplied(proposal)).length;
    })).toBe(1);
  });
}
