// Mobile object tabs and shared content tabs retain the real editors, lists and selection state.
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal, drawCorridor, stackSection, PARCEL_ID } from '../helpers/runtime';
import { proposeOverPark } from '../helpers/agreements';
import { fileAgreement, fileDesign, filePlan, pageIndex } from '../helpers/mocks/shared-server';

for (const width of [390, 1280]) {
  test(`inspection navigation preserves rich content at ${width}px`, async ({ mockApi: page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 844 });
    await openCity(page);
    const id = await createSpace(page, 'park');
    await showProposal(page, id);
    const stack = page.locator('#click-stack');
    const tabs = stack.locator('.is-expanded .click-stack__content-tabs');
    await expect(tabs.getByRole('tab').first()).toHaveText('Actions');
    await expect(tabs.locator('[data-page="actions"]')).toHaveAttribute('aria-selected', 'true');
    await tabs.locator('[data-page="design-overview"]').click();
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
    await expect(tabs.locator('[data-page="actions"]')).toHaveAttribute('aria-selected', 'true');
    await tabs.locator('[data-page="info"]').click();
    await expect(stack.locator('.click-stack__schedule-plan')).toBeVisible();
    await expect(stack.locator('.click-stack__revision')).toBeVisible();
    await tabs.locator('[data-page="relation-designs"]').click();
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
    await tabs.locator('[data-page="actions"]').click();
    await expect(stack.locator('.parcel-build-btn--park')).toBeVisible();
    await expect(stack.locator('#parcel-manual-selection')).toBeVisible();
    await expect(stack.locator('.multi-select-detect-btn')).toBeVisible();
    await stack.locator('#parcel-manual-selection').click();
    await expect(tabs.getByRole('tab', { name: 'Actions', exact: true })).toHaveCount(1);
    await expect(stack.locator('[data-command="selection.clear"]')).toBeVisible();
    await tabs.locator('[data-page="parcel-info-tab"]').click();
    await expect(stack.locator('[data-command="selection.clear"]')).toBeVisible();
  });
}

test('mobile agreement content tabs retain controls and exact plan references', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCity(page);
  const agreement = await proposeOverPark(page, { title: 'Navigation agreement' });
  await page.evaluate(id => (window as any).ClickStack.showAgreement((window as any).AgreementStore.get(id)), agreement.id);
  const stack = page.locator('#click-stack');
  const tabs = stack.locator('.click-stack__content-tabs');
  await expect(tabs.locator('[data-page="actions"]')).toHaveAttribute('aria-selected', 'true');
  await tabs.locator('[data-page="agreement-overview"]').click();
  await expect(stack.locator('[data-agreement-action="plan"]')).toBeVisible();
  await tabs.locator('[data-page="agreement-inputs"]').click();
  await expect(stack.locator('[data-agreement-inspect="input"]')).toBeVisible();
  await tabs.locator('[data-page="agreement-rules"]').click();
  await expect(stack.locator('[data-agreement-action="counter"]')).toBeHidden();
  await tabs.locator('[data-page="actions"]').click();
  await expect(stack.locator('[data-agreement-action="counter"]')).toBeVisible();
  await expect(stack.locator('[data-agreement-action="download"]')).toBeVisible();
  await expect(stack.locator('[data-agreement-action="compare"]')).toBeVisible();
  await tabs.locator('[data-page="agreement-overview"]').click();
  await stack.locator('[data-agreement-action="plan"]').click();
  await tabs.locator('[data-page="relation-agreements"]').click();
  await expect(stack.locator('[data-stack-agreements] .click-stack__link')).toHaveCount(1);
  await expect(stack.locator('[data-stack-agreements]')).toContainText('Navigation agreement');
  await expect(tabs.locator('[data-page="relation-agreements"]')).toHaveText('Agreements (1)');
});

test('a design stack switches its nested input and output parcel tabs', async ({ mockApi: page }) => {
  await openCity(page);
  await drawCorridor(page, 'road');

  const designs = stackSection(page, 'designs');
  const tabs = designs.locator('.click-stack__choices--tabs');
  const contentTabs = designs.locator('.click-stack__content-tabs');
  const inputTab = contentTabs.getByRole('tab', { name: /^Input parcels \(\d+\)$/ });
  const outputTab = contentTabs.getByRole('tab', { name: /^Output parcels \(\d+\)$/ });
  await inputTab.click();
  await expect(inputTab).toHaveAttribute('aria-selected', 'true');
  await expect(outputTab).toHaveAttribute('aria-selected', 'false');

  const inputPanel = tabs.locator('[role="tabpanel"]').nth(0);
  await expect(inputPanel.locator('.click-stack__chip').first()).toBeVisible();
  const input = inputPanel.locator('.click-stack__chip').first();
  await input.click();
  await expect(input).toHaveAttribute('aria-pressed', 'true');
  const focusedShape = page.locator('path.click-stack-map-focus').first();
  await expect(focusedShape).toBeVisible();
  const inputShape = await focusedShape.getAttribute('d');

  await outputTab.click();
  await expect(outputTab).toHaveAttribute('aria-selected', 'true');
  await expect(inputPanel).toBeHidden();
  const outputPanel = tabs.locator('[role="tabpanel"]').nth(1);
  await expect(outputPanel.locator('.click-stack__chip').first()).toBeVisible();
  const output = outputPanel.locator('.click-stack__chip').first();
  await output.click();
  await expect(output).toHaveAttribute('aria-pressed', 'true');
  await expect(focusedShape).toBeVisible();
  expect(await focusedShape.getAttribute('d')).not.toBe(inputShape);

  await inputTab.click();
  await expect(inputTab).toHaveAttribute('aria-selected', 'true');
  await expect(inputPanel).toBeVisible();
  await expect(inputPanel.locator('.click-stack__chip').first()).toHaveText(/\S+/);
});

test('a published plan agreement membership can be retried after the feed fails', async ({ mockApi: page }) => {
  await openCity(page);
  const index = pageIndex(page);
  const city = await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId());
  const createdAt = new Date().toISOString();
  const designCid = fileDesign(index, {
    schema: 'design/v1', goal: 'park', title: 'Membership retry park', description: null, author: 'fixture', city,
    site: { type: 'Polygon', coordinates: [[[15.96, 45.8], [15.9601, 45.8], [15.9601, 45.8001], [15.96, 45.8001], [15.96, 45.8]]] },
    toleranceM: null, geometry: null, origin: null, authoredAt: createdAt,
    structureProposal: { kind: 'park', blockName: null },
  });
  const planContent = {
    schema: 'plan/v1', title: 'Published membership retry plan', designCids: [designCid],
    view: { at: '45.8,15.96,16', mode: '2d', city, language: 'en' },
  };
  const planCid = filePlan(index, planContent);
  const agreementContent = {
    schema: 'agreement/v1', title: 'Published membership retry agreement', author: 'fixture', sponsor: null, city,
    createdAt, planCid, inputs: { parcels: [{ parcelId: 'HR-335614-2311', areaM2: 120, holders: [] }], openGroundM2: 0 },
    outputs: [], allocations: [], money: { currency: 'EUR', lines: [] },
    rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] }, deadline: null,
  };
  const agreementCid = fileAgreement(index, agreementContent);
  let membershipRequests = 0;
  await page.route(url => url.pathname.endsWith('/agreements') && url.searchParams.get('plan') === planCid, async route => {
    membershipRequests++;
    if (membershipRequests === 1) return route.fulfill({ status: 503, json: { error: 'Temporary membership feed failure' } });
    return route.fallback();
  });

  await page.evaluate(async ({ planCid, planContent, designCid, agreementCid, agreementContent, city, createdAt }) => {
    const w = window as any;
    const agreement = {
      id: 'remote-membership-agreement', title: agreementContent.title, author: agreementContent.author, city, createdAt,
      plan: { cid: planCid, content: planContent },
      designs: [{ proposalId: designCid, cid: designCid, title: 'Membership retry park', goal: 'park' }],
      inputs: agreementContent.inputs, outputs: [], allocations: [], money: agreementContent.money,
      rule: agreementContent.rule, deadline: null,
      published: { cid: agreementCid, publishedAt: createdAt, apiBase: w.DesignSync.apiBase(), sponsor: null },
    };
    await w.ClickStack.showAgreement(agreement, { readOnly: true });
  }, { planCid, planContent, designCid, agreementCid, agreementContent, city, createdAt });

  const stack = page.locator('#click-stack');
  const retry = stack.locator('.click-stack__agreement-more');
  await expect(retry).toHaveText('Retry', { timeout: 30_000 });
  await retry.click();
  await expect.poll(() => membershipRequests).toBe(2);
  await expect(retry).toHaveCount(0);
  await expect.poll(() => index.requests.filter(request => request.method === 'GET'
    && request.path.startsWith('/agreements?plan=')).length).toBe(1);
  await stack.locator('.click-stack__section[data-kind="plans"] .click-stack__heading').click();
  const memberships = stack.locator('[data-stack-agreements]');
  await expect(memberships).toContainText('Published membership retry agreement');
  await expect(memberships.locator('.click-stack__chip')).toHaveAttribute('data-id', agreementCid);
});
