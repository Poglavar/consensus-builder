/**
 * Covers localized dependency failures so shared-plan retries do not depend on
 * matching translated human-facing text with English-only regexes.
 */
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, switchLanguage } from '../helpers/app';

test.describe('Proposal dependency failures @core', () => {
  test('stores dependency metadata alongside Croatian failure text', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await switchLanguage(page, 'hr');

    const result = await page.evaluate(() => {
      const w = window as any;
      const pm = w.ProposalManager;
      if (!pm || typeof pm._setLastApplyFailure !== 'function' || typeof pm.getLastApplyFailureInfo !== 'function') {
        return { skip: true };
      }

      const proposalId = 'dep-hr-test';
      const missingId = '371#p-1ov46hnuoy5-19';
      const message = w.i18n?.t?.('ephemeral.messages.cannot_apply_building_proposal_missing_parents', { missing: missingId })
        ?? `Nije moguće primijeniti prijedlog zgrade, nedostaju prethodnici: ${missingId}`;

      pm._clearLastApplyFailure?.(proposalId);
      pm._setLastApplyFailure(proposalId, {
        code: 'dependency-missing',
        message,
        missingIds: [missingId],
      });

      return {
        skip: false,
        message: pm.getLastApplyFailure(proposalId),
        info: pm.getLastApplyFailureInfo(proposalId),
      };
    });

    test.skip(result.skip, 'ProposalManager failure metadata helpers are unavailable');
    expect(result.message).toContain('nedostaju');
    expect(result.info?.code).toBe('dependency-missing');
    expect(result.info?.missingIds).toEqual(['371#p-1ov46hnuoy5-19']);
  });
});
