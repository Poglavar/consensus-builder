// Mobile object tabs and shared content tabs retain the real editors, lists and selection state.
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal, PARCEL_ID } from '../helpers/runtime';
import { proposeOverPark } from '../helpers/agreements';

for (const width of [390, 1280]) {
  test(`inspection navigation preserves rich content at ${width}px`, async ({ mockApi: page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 844 });
    await openCity(page);
    const id = await createSpace(page, 'park');
    await showProposal(page, id);
    const stack = page.locator('#click-stack');
    const tabs = stack.locator('.is-expanded .click-stack__content-tabs');
    await expect(tabs.locator('[data-page="design-overview"]')).toHaveAttribute('aria-selected', 'true');
    await expect(stack.locator('.proposal-overview-facts')).toBeVisible();
    await page.evaluate(() => (window as any).setProposalDetailsPanelMinimized(document.getElementById('proposal-details-panel'), true));
    await expect(stack.locator('.proposal-overview-facts')).toBeVisible();
    await tabs.locator('[data-page="actions"]').click();
    await expect(stack.locator('[data-design-action="add-to-plan"]')).toBeVisible();
    await expect(stack.locator('.proposal-primary-actions')).toBeVisible();
    await expect(stack.locator('.proposal-overview-facts')).toBeHidden();
    // Existing application state still changes through the original action button.
    await stack.locator(`#proposal-action-btn-${id}`).click();
    await expect.poll(() => page.evaluate(id => !!(window as any).proposalStorage.getProposal(id).applied, id)).toBe(false);
    await expect(tabs.locator('[data-page="actions"]')).toHaveAttribute('aria-selected', 'true');
    await tabs.locator('[data-page="design-overview"]').click();
    await expect(tabs.locator('[data-page="design-details"]')).toHaveCount(0);
    await expect(stack.locator('[data-proposal-section="land"]')).toHaveCount(0);
    await stack.locator('[data-proposal-section="record"] > summary').click();
    await expect(stack.locator('.proposal-id-copy')).toBeVisible();
    await expect(stack.locator('.proposal-primary-actions')).toBeHidden();

    await page.evaluate(async id => {
      const w = window as any;
      const proposal = w.proposalStorage.getProposal(id);
      const plan = w.PlanComposition.create('Navigation plan', [proposal], w.MapShare.capture(w));
      w.PlanWorkspace.save(plan);
      await w.ClickStack.showPlan({ cid: plan.cid, content: plan.content }, { designs: [proposal] });
    }, id);
    await expect(tabs.locator('[data-page="relation-designs"]')).toHaveAttribute('aria-selected', 'true');
    await expect(stack.locator('.click-stack__membership-details .click-stack__link')).toHaveCount(1);
    await expect(tabs.locator('[data-page="relation-designs"]')).toHaveText('Designs (1)');
    await tabs.locator('[data-page="relation-agreements"]').click();
    await expect(stack).toContainText('No agreements reference this plan yet.');
    await expect(tabs.locator('[data-page="relation-agreements"]')).toHaveText('Agreements (0)');
    await tabs.locator('[data-page="actions"]').click();
    await expect(stack.locator('.click-stack__create-agreement')).toBeVisible();
    await expect(stack.locator('.click-stack__share-plan')).toBeVisible();
    if (width < 768) {
      await expect(stack.locator('.mobile-dock-sheet-handle')).toHaveCount(0);
      await expect(stack.locator('.click-stack__object-tab[data-kind="plans"] .cb-icon-plan')).toHaveCount(1);
      await expect(stack.locator('.click-stack__section:visible')).toHaveCount(1);
      await stack.locator('.click-stack__size').click();
      expect((await stack.boundingBox())!.height).toBeGreaterThan(800);
      await stack.locator('.click-stack__size').click();
      expect((await stack.boundingBox())!.height).toBeLessThanOrEqual(465);
      await stack.locator('.is-selected .click-stack__row').click();
      expect((await stack.boundingBox())!.height).toBeLessThan(110);
      await stack.locator('.click-stack__object-tab[data-kind="plans"]').click();
      await tabs.locator('[data-page="relation-designs"]').click();
      await stack.locator('.click-stack__size').click();
      await stack.locator('.click-stack__membership-details .click-stack__chip').click();
      await expect(stack).not.toHaveClass(/is-mobile-full/);
      await expect(stack.locator('.click-stack__object-tab[data-kind="plans"]')).toHaveAttribute('aria-selected', 'true');
      await stack.locator('.click-stack__dismiss').click();
      await expect(stack).toBeHidden();
    }
    await showProposal(page, id);
    await expect(tabs.locator('[data-page="relation-plans"]')).toHaveText('Plans (1)');
    // Parcel editors and tools remain reachable through the promoted native tabs.
    await page.evaluate(id => (window as any).ClickStack.showParcel((window as any).CadastralParcelRepository.get(id)), PARCEL_ID);
    await tabs.locator('[data-page="parcel-info-tab"]').click();
    await expect(stack.locator('#info-tab')).toBeVisible();
    await expect(stack.locator('#parcel-manual-selection')).toBeHidden();
    await expect(stack.locator('.multi-select-detect-btn')).toBeHidden();
    await tabs.locator('[data-page="parcel-tools-tab"]').click();
    await expect(stack.locator('#tools-tab')).toBeVisible();
    await expect(stack.locator('#parcel-manual-selection')).toBeHidden();
    await expect(stack.locator('.multi-select-detect-btn')).toBeHidden();
    await tabs.locator('[data-page="parcel-propose-tab"]').click();
    await expect(stack.locator('.parcel-build-btn--park')).toBeVisible();
    await expect(stack.locator('#parcel-manual-selection')).toBeVisible();
    await expect(stack.locator('.multi-select-detect-btn')).toBeVisible();
  });
}

test('mobile agreement content tabs retain controls and exact plan references', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCity(page);
  const agreement = await proposeOverPark(page, { title: 'Navigation agreement' });
  await page.evaluate(id => (window as any).ClickStack.showAgreement((window as any).AgreementStore.get(id)), agreement.id);
  const stack = page.locator('#click-stack');
  const tabs = stack.locator('.click-stack__content-tabs');
  await expect(tabs.locator('[data-page="agreement-overview"]')).toHaveAttribute('aria-selected', 'true');
  await expect(stack.locator('[data-agreement-action="plan"]')).toBeVisible();
  await tabs.locator('[data-page="agreement-inputs"]').click();
  await expect(stack.locator('[data-agreement-inspect="input"]')).toBeVisible();
  await tabs.locator('[data-page="agreement-rules"]').click();
  await expect(stack.locator('[data-agreement-action="counter"]')).toBeVisible();
  await tabs.locator('[data-page="actions"]').click();
  await expect(stack.locator('[data-agreement-action="download"]')).toBeVisible();
  await expect(stack.locator('[data-agreement-action="compare"]')).toBeVisible();
  await tabs.locator('[data-page="agreement-overview"]').click();
  await stack.locator('[data-agreement-action="plan"]').click();
  await tabs.locator('[data-page="relation-agreements"]').click();
  await expect(stack.locator('[data-stack-agreements] .click-stack__link')).toHaveCount(1);
  await expect(stack.locator('[data-stack-agreements]')).toContainText('Navigation agreement');
  await expect(tabs.locator('[data-page="relation-agreements"]')).toHaveText('Agreements (1)');
});
