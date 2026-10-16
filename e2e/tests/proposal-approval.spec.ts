import { selectNativeOption } from '../helpers/controls';
// Purpose: exercise the shared rights-import, approval-policy and proposal-fork workflow.
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID } from '../helpers/runtime';
import type { Page, TestInfo } from '@playwright/test';

const geometry = {
  type: 'Polygon',
  coordinates: [[[15.9819, 45.8000], [15.9821, 45.8000], [15.9821, 45.8002], [15.9819, 45.8002], [15.9819, 45.8000]]]
};

const rights = (reference: string, areaM2: number) => ({
  schema: 'parcel-rights/v1',
  source: { provider: 'upload', reference },
  parcels: [{ parcelId: PARCEL_ID, complete: true, areaM2, owners: [
    { ownerId: 'owner-a', share: '1/2' }, { ownerId: 'owner-b', share: '1/2' }
  ] }]
});

async function profileAndAuthority(page: Page): Promise<string> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Approval Fixture');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  return page.evaluate(() => {
    const w = window as any;
    const actorId = w.getCurrentUserAgent()?.id;
    const providerId = 'e2e-proposal-approval-authority';
    w.ProposalApprovalAuthorities.register(providerId, {
      authorize({ proposal, ownerId, actor, contextHash }: any) {
        if (actor.id !== actorId || ownerId !== 'owner-a' || !proposal.lens?.includes('e2e-lens')) return null;
        return {
          rights: { member: 'e2e-lens', evidenceRef: 'fixture-rights', contextHash },
          authority: { member: 'e2e-lens', evidenceRef: 'fixture-authority', contextHash, ownerId, actorId }
        };
      },
      async signDecision({ statement }: any) {
        const signature = w.__consentSha256.sha256Hex(w.ProposalApproval.stableStringify(statement));
        return { statement: JSON.parse(JSON.stringify(statement)), signature: `e2e:${signature}` };
      },
      verifyReceipt({ statement, receipt }: any) {
        const signature = w.__consentSha256.sha256Hex(w.ProposalApproval.stableStringify(statement));
        return w.ProposalApproval.stableStringify(receipt.decisionProof?.statement) === w.ProposalApproval.stableStringify(statement)
          && receipt.decisionProof?.signature === `e2e:${signature}`;
      }
    });
    return actorId;
  });
}

async function uploadRights(page: Page, reference: string, areaM2: number, name = 'rights.json'): Promise<void> {
  const json = JSON.stringify(rights(reference, areaM2));
  await page.locator('[data-approval-file]').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(json) });
  await page.locator('[data-editor-action="approval-import"]').click();
  await expect(page.locator('.proposal-editor-approval-status')).toContainText('Ownership data is complete');
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function assertApprovalChromeFits(page: Page, width: number): Promise<void> {
  const chrome = await page.evaluate(() => {
    const rect = (node: Element) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const shell = document.querySelector('.proposal-editor-shell')!;
    return {
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      shell: rect(shell),
      groups: ['.proposal-editor-comparison', '.proposal-editor-tabs'].map(selector => {
        const parent = shell.querySelector(selector)!;
        return { parent: rect(parent), buttons: [...parent.querySelectorAll('button')].map(rect) };
      })
    };
  });
  expect(chrome.viewportWidth).toBe(width);
  expect(chrome.shell.x).toBeGreaterThanOrEqual(0);
  expect(chrome.shell.right).toBeLessThanOrEqual(width);
  expect(chrome.shell.y).toBeGreaterThanOrEqual(0);
  expect(chrome.shell.bottom).toBeLessThanOrEqual(chrome.viewportHeight);
  for (const group of chrome.groups) {
    expect(group.buttons.length).toBeGreaterThan(0);
    expect(group.parent.x).toBeGreaterThanOrEqual(0);
    expect(group.parent.right).toBeLessThanOrEqual(width);
    for (const button of group.buttons) {
      expect(button.height, 'editor navigation controls must retain a usable height').toBeGreaterThanOrEqual(28);
      expect(button.y).toBeGreaterThanOrEqual(group.parent.y - 1);
      expect(button.bottom).toBeLessThanOrEqual(group.parent.bottom + 1);
    }
  }
}

test('shared proposal editor imports rights, saves approval policy and forks without old consent', async ({ mockApi: page }, testInfo) => {
  test.setTimeout(90_000);
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  const actorId = await profileAndAuthority(page);
  const sourceId = await page.evaluate(({ parcelId, shape, rightsData, actorId }) => {
    const w = window as any;
    const source: any = {
      title: 'Approval workflow fixture', author: w.getCurrentUserAgent().name, goal: 'as-is', lifecycleStatus: 'Active',
      city: w.CityConfigManager.getCurrentCityId(), cadastreParcelIds: [parcelId], acceptedParcelIds: [], funded: false,
      offer: 40, offerCurrency: 'EUR', geometry: shape, approvalConfig: {
        schema: 'proposal-approval/v1', rights: rightsData,
        policy: { type: 'unanimous' }
      }, lens: ['e2e-lens']
    };
    const id = w.proposalStorage.addProposal(source);
    const saved = w.proposalStorage.getProposal(id);
    const contextHash = w.ProposalApproval.contextHash(saved);
    const effectHash = w.ProposalApproval.consentHash(saved, w.proposalConsentFingerprint(saved));
    const receipt: any = {
      ownerId: 'owner-a', actorId, effectHash, decision: 'approve', acceptedAt: '2026-02-03T04:05:06.000Z',
      providerId: 'e2e-proposal-approval-authority',
      evidence: {
        rights: { member: 'e2e-lens', evidenceRef: 'fixture-rights', contextHash },
        authority: { member: 'e2e-lens', evidenceRef: 'fixture-authority', contextHash, ownerId: 'owner-a', actorId }
      }
    };
    const statement = w.ProposalApproval.decisionContent(saved, receipt);
    const signature = w.__consentSha256.sha256Hex(w.ProposalApproval.stableStringify(statement));
    receipt.decisionProof = { statement, signature: `e2e:${signature}` };
    saved.ownerApprovals = { 'owner-a': receipt };
    w.proposalStorage._indexProposal?.(saved);
    w.proposalStorage.save();
    return id;
  }, { parcelId: PARCEL_ID, shape: geometry, rightsData: rights('original-rights', 100), actorId });

  await page.evaluate(id => (window as any).editProposal(id), sourceId);
  await expect(page.locator('.proposal-editor-shell')).toBeVisible();
  await page.locator('[data-editor-action="tab"][data-editor-tab="approval"]').click();
  await expect(page.locator("[data-editor-section='approval']")).toBeVisible();
  await uploadRights(page, 'updated-rights', 125);

  // Custom rules start from the usual majority; rows are in canonical order (area, then owners).
  await selectNativeOption(page.locator('[data-approval-regime]'), 'custom');
  const areaRow = page.locator('[data-approval-test="0"]');
  const ownersRow = page.locator('[data-approval-test="1"]');
  await expect(ownersRow.locator('[data-approval-test-measure]')).toHaveValue('headcount');
  await ownersRow.locator('[data-approval-test-fraction]').fill('1/2');
  await areaRow.locator('[data-approval-test-fraction]').fill('3/4');
  await selectNativeOption(ownersRow.locator('[data-approval-test-strict]'), 'true');
  await selectNativeOption(areaRow.locator('[data-approval-test-strict]'), 'true');
  await expect.poll(() => page.evaluate(() => (window as any).proposalDraftStore.getActiveDraft().fields.approvalConfig.policy.area.strict)).toBe(true);
  await selectNativeOption(areaRow.locator('[data-approval-test-strict]'), 'false');
  // A scheme pins itself; choosing Custom rules again drops the pin and keeps the scheme's tests.
  await selectNativeOption(page.locator('[data-approval-regime]'), 'es-md-compensation');
  await expect.poll(() => page.evaluate(() => (window as any).proposalDraftStore.getActiveDraft().fields.approvalConfig.regime?.id)).toBe('es-md-compensation');
  await expect(page.locator('[data-approval-regime-details="es-md-compensation"]')).toBeVisible();
  await selectNativeOption(page.locator('[data-approval-regime]'), 'custom');
  await expect.poll(() => page.evaluate(() => (window as any).proposalDraftStore.getActiveDraft().fields.approvalConfig.regime)).toBeUndefined();
  await expect(page.locator('[data-approval-test]')).toHaveCount(1);
  // Back to the majority this test goes on with. A typed fraction is saved on change (the form
  // re-renders), so flush it before the next click lands on a rebuilt button.
  const fraction = (index: number) => page.locator(`[data-approval-test="${index}"] [data-approval-test-fraction]`);
  await fraction(0).fill('3/4');
  await fraction(0).dispatchEvent('change');
  await expect.poll(() => page.evaluate(() => (window as any).proposalDraftStore.getActiveDraft().fields.approvalConfig.policy.tests[0].denominator)).toBe(4);
  await page.locator('[data-editor-action="approval-test-add"]').click();
  await expect(page.locator('[data-approval-test]')).toHaveCount(2);
  await fraction(1).fill('1/2');
  await fraction(1).dispatchEvent('change');
  await selectNativeOption(page.locator('[data-approval-test="1"] [data-approval-test-strict]'), 'true');
  await page.locator('[data-approval-custom-authority]').uncheck();
  await page.locator('[data-approval-lens]').fill('e2e-lens\nreviewer-lens');
  await page.locator('[data-approval-lens]').dispatchEvent('change');
  await expect(page.locator('.proposal-editor-autosave')).toContainText('Autosaved locally');

  const draftId = await page.evaluate(source => (window as any).proposalDraftStore.findDraftForSource(source)?.id, sourceId);
  const savedConfig = await page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).fields.approvalConfig, draftId);
  expect(savedConfig.rights).toMatchObject({ source: { provider: 'upload', reference: 'updated-rights' } });
  expect(savedConfig.policy).toEqual({ type: 'threshold', owners: { numerator: 1, denominator: 2, strict: true }, area: { numerator: 3, denominator: 4, strict: false } });
  await assertApprovalChromeFits(page, 1280);
  await screenshot(page, testInfo, 'proposal-approval-desktop');

  const previousSnapshot = await page.evaluate(id => JSON.parse(JSON.stringify((window as any).proposalDraftStore.getDraft(id).fields.approvalConfig.rights)), draftId);
  await page.locator('[data-approval-file]').setInputFiles({
    name: 'malformed.json', mimeType: 'application/json', buffer: Buffer.from('{"schema":"parcel-rights/v1","parcels":[{"complete":true}]')
  });
  await page.locator('[data-editor-action="approval-import"]').click();
  await expect(page.locator('.proposal-editor-approval-error[role="alert"]')).toBeVisible();
  await expect.poll(() => page.evaluate(id => JSON.stringify((window as any).proposalDraftStore.getDraft(id).fields.approvalConfig.rights), draftId))
    .toBe(JSON.stringify(previousSnapshot));

  await page.locator('[data-editor-action="close"]').click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).proposalDraftStore?.getDraft);
  const persistedDraftId = await page.evaluate(source => (window as any).proposalDraftStore.findDraftForSource(source)?.id, sourceId);
  expect(persistedDraftId).toBe(draftId);
  await page.evaluate(({ id, draft }) => (window as any).openProposalEditorShell(draft, { tab: 'approval' }), { id: sourceId, draft: draftId });
  await expect(page.locator("[data-editor-section='approval']")).toBeVisible();
  expect(await page.locator('[data-approval-lens]').inputValue()).toContain('reviewer-lens');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).resolves.toBe(false);
  await assertApprovalChromeFits(page, 390);
  const rightsRow = page.locator('.proposal-editor-approval-row').first();
  await rightsRow.scrollIntoViewIfNeeded();
  const rightsRowInBody = await rightsRow.evaluate(row => {
    const body = row.closest('.proposal-editor-body')!;
    const rowBox = row.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    return rowBox.bottom > bodyBox.top && rowBox.top < bodyBox.bottom;
  });
  expect(rightsRowInBody, 'an imported parcel-owner row must be in the mobile editor viewport').toBe(true);
  await screenshot(page, testInfo, 'proposal-approval-mobile-rights-preview-390');
  const thresholds = page.locator('[data-approval-tests]');
  await thresholds.scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'proposal-approval-mobile-policy-thresholds-390');
  await page.locator('[data-approval-lens]').scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'proposal-approval-mobile-policy-lens-390');
  await screenshot(page, testInfo, 'proposal-approval-mobile-390');

  const fork = await page.evaluate(id => {
    const w = window as any;
    const draft = w.proposalDraftStore.getDraft(id);
    const replacement = w.proposalDraftStore.buildProposalFromDraft(id);
    const newId = w.proposalStorage.addProposal(replacement);
    const saved = w.proposalStorage.getProposal(newId);
    const source = w.proposalStorage.getProposal(draft.sourceProposalId);
    return {
      newId, sourceId: draft.sourceProposalId,
      sourceGeometry: source.geometry, replacementGeometry: saved.geometry,
      sourceRights: source.approvalConfig.rights, replacementRights: saved.approvalConfig.rights,
      sourceApprovals: source.ownerApprovals || {},
      ownerApprovals: saved.ownerApprovals || {}, ownerApprovalHistory: saved.ownerApprovalHistory || [],
      designHash: w.proposalContentFingerprint(saved)
    };
  }, draftId);
  expect(fork.newId).not.toBe(fork.sourceId);
  expect(fork.replacementGeometry).toEqual(fork.sourceGeometry);
  expect(fork.replacementRights.source.reference).toBe('updated-rights');
  expect(fork.replacementRights.parcels[0].areaM2).toBe(125);
  expect(fork.replacementRights).not.toEqual(fork.sourceRights);
  expect(fork.sourceApprovals['owner-a']).toMatchObject({ actorId, ownerId: 'owner-a', decision: 'approve' });
  expect(fork.ownerApprovals).toEqual({});
  expect(fork.ownerApprovalHistory).toEqual([]);

  await page.locator('[data-editor-action="approval-remove"]').click();
  const removed = await page.evaluate(id => {
    const w = window as any;
    const draft = w.proposalDraftStore.getDraft(id);
    const proposal = w.proposalDraftStore.buildProposalFromDraft(id);
    return { rights: draft.fields.approvalConfig.rights, geometry: proposal.geometry, valid: draft.validation.valid };
  }, draftId);
  expect(removed.rights).toBeNull();
  expect(removed.geometry).toEqual(geometry);
  expect(removed.valid).toBe(true);
  expect(fork.designHash).toBeTruthy();
  expect(actorId).toBeTruthy();
});
