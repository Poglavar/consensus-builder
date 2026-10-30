import { expect, Page } from '@playwright/test';

// Save exact members without applying or publishing them, then use the plan's real list actions.
export async function openPlanActions(page: Page, title = 'Inspection plan', ids?: string[]) {
  await page.evaluate(({ title, ids }) => {
    const w = window as any;
    const records = w.proposalStorage.getAllProposals().filter((r: any) => !ids || ids.includes(r.proposalId));
    const plan = w.PlanComposition.create(title, records, { city: w.resolveCurrentCityCode(), at: '45.8,15.98,17', mode: '2d', language: 'en' });
    w.PlanWorkspace.save(plan);
    w.MapShell.closeSheets();
  }, { title, ids });
  await page.locator('#proposals-button').click();
  await page.locator('[data-list-tab="plans"]').click();
  const row = page.locator('#plan-list-host .lists-item').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(row).toBeVisible();
  return row;
}
