import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';
import { readFile } from 'node:fs/promises';

const RIGHTS = {
  schema: 'parcel-rights/v1',
  source: { provider: 'upload', reference: 'approval-control-fixture' },
  parcels: [{ parcelId: 'HR-335754-1234', complete: true, areaM2: 100, owners: [{ ownerId: 'owner-a', share: '1/1' }] }],
};

test('approval setup exposes usable rights and custom rule controls', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => (window as any).ProposalApprovalSetup.openDialog({
    cadastreParcelIds: ['HR-335754-1234'],
    onApply: (value: unknown) => { (window as any).__approvalControlApplied = value; },
  }));
  const form = page.locator('.approval-setup-dialog');
  await expect(form).toBeVisible();

  const template = page.waitForEvent('download');
  await form.locator('[data-editor-action="approval-template"]').click();
  const download = await template;
  expect(download.suggestedFilename()).toBe('parcel-rights-template.json');
  const downloadedTemplate = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(downloadedTemplate).toMatchObject({
    schema: 'parcel-rights/v1',
    source: { provider: 'upload' },
    parcels: [{ parcelId: 'HR-335754-1234', complete: false, areaM2: null, owners: [] }],
  });

  await form.locator('[data-approval-file]').setInputFiles({ name: 'rights.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(RIGHTS)) });
  await form.locator('[data-editor-action="approval-import"]').click();
  await expect(form.locator('.proposal-editor-approval-status')).toContainText('complete');
  await expect(form.locator('.proposal-editor-approval-list')).toContainText('HR-335754-1234');
  await form.locator('[data-editor-action="approval-remove"]').click();
  await expect(form.locator('[data-editor-action="approval-remove"]')).toBeDisabled();
  await expect(form.locator('[data-approval-rule-text]')).toBeVisible();

  const regime = form.locator('[data-approval-regime]');
  await selectNativeOption(regime, 'custom');
  await expect(form.locator('[data-approval-test="0"]')).toBeVisible();
  const row = form.locator('[data-approval-test="0"]');
  await selectNativeOption(row.locator('[data-approval-test-strict]'), 'true');
  await row.locator('[data-approval-test-fraction]').fill('2/3');
  await selectNativeOption(row.locator('[data-approval-test-measure]'), 'area');
  await selectNativeOption(row.locator('[data-approval-test-of]'), 'owners+leaseholders');
  await selectNativeOption(row.locator('[data-approval-test-scope]'), 'private');
  await form.locator('[data-editor-action="approval-test-add"]').click();
  await expect(form.locator('[data-approval-test]')).toHaveCount(3);
  await form.locator('[data-approval-test="1"] [data-editor-action="approval-test-remove"]').click();
  await expect(form.locator('[data-approval-test]')).toHaveCount(2);
  await form.locator('[data-approval-custom-authority]').check();
  await expect(form.locator('[data-approval-authority-id="0"]')).toBeVisible();
  await form.locator('[data-approval-authority-id="0"]').fill('city-council');
  await form.locator('.cb-dialog__footer .btn-primary').click();
  await expect(form).toHaveCount(0);
  const applied = await page.evaluate(() => (window as any).__approvalControlApplied);
  expect(applied.approvalConfig).toMatchObject({
    schema: 'proposal-approval/v1',
    rights: null,
    policy: {
      type: 'rules',
      tests: expect.arrayContaining([
        expect.objectContaining({ strict: true, numerator: 2, denominator: 3, measure: 'area', of: 'owners+leaseholders', scope: 'private' }),
      ]),
      authorities: [{ authorityId: 'city-council' }],
    },
  });
});
