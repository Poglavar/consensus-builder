// Start form-component coverage from an authored draft; explicit map copying uses Duplicate.
import { Page, expect } from '@playwright/test';

export async function openDesignReview(page: Page, sourceId: string): Promise<void> {
  await page.evaluate(async id => {
    const w = window as any;
    const source = w.proposalStorage.getProposal(id);
    const seeded = w.getProposalEditorAdapter(source.goal).draftFromProposal(source);
    const fields = { ...seeded.fields, selectedParcelIds: [], site: seeded.fields.site || w.__siteBinding.siteOf(source) };
    const draft = w.proposalDraftStore.createDraft({ ...seeded, fields, goal: source.goal, cityId: w.CityConfigManager.getCurrentCityId(),
      sourceLocalProposalId: null, sourceSnapshot: null });
    await w.stageProposalDraftForPublishing(draft.id);
  }, sourceId);
  await expect(page.locator('.create-proposal-modal:visible')).toBeVisible();
}
