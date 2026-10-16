// proposals/approval-setup.js — the one Ownership and approval form, shared by the proposal editor's
// Approval tab and the create dialog / readjustment designer. Reading the form back, the summary
// line and the rendered form, without a DOM.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let Setup;
const rights = {
    schema: 'parcel-rights/v1',
    source: { provider: 'upload', reference: 'notary-2026' },
    parcels: [
        { parcelId: 'HR-1', complete: true, areaM2: 100, owners: [{ ownerId: 'owner-a', share: '1/1' }] },
        { parcelId: 'HR-2', complete: true, areaM2: 50, owners: [{ ownerId: 'owner-b', share: '1/2' }, { ownerId: 'owner-c', share: '1/2' }] }
    ]
};

beforeAll(() => {
    globalThis.ProposalApproval = require('../../frontend/js/proposals/approval.js');
    Setup = require('../../frontend/js/proposals/approval-setup.js');
});

// A container whose controls answer querySelector by attribute selector.
function form(values) {
    return {
        querySelector(selector) {
            if (!(selector in values)) return null;
            return { value: values[selector] };
        }
    };
}

describe('reading the form back', () => {
    it('turns threshold controls into a canonical policy and keeps the rights', () => {
        const config = Setup.withPolicyFromForm(form({
            '[data-approval-policy-type]': 'threshold',
            '[data-approval-fraction="owners"]': '1/2',
            '[data-approval-fraction="area"]': ' 7 / 10 ',
            '[data-approval-strict="owners"]': 'false',
            '[data-approval-strict="area"]': 'true'
        }), { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } });
        expect(config.policy).toEqual({
            type: 'threshold',
            owners: { numerator: 1, denominator: 2, strict: false },
            area: { numerator: 7, denominator: 10, strict: true }
        });
        expect(config.rights.parcels).toHaveLength(2);
    });

    it('refuses a malformed fraction instead of guessing', () => {
        expect(() => Setup.withPolicyFromForm(form({
            '[data-approval-policy-type]': 'threshold',
            '[data-approval-fraction="owners"]': 'half'
        }), null)).toThrow(/fraction/);
    });

    it('reads unanimous when the policy says so, and the lens as unique keys', () => {
        expect(Setup.withPolicyFromForm(form({ '[data-approval-policy-type]': 'unanimous' }), null).policy).toEqual({ type: 'unanimous' });
        expect(Setup.lensFromText('key-a\nkey-b, key-a\n\n')).toEqual(['key-a', 'key-b']);
        expect(Setup.lensFromForm(form({ '[data-approval-lens]': 'k1\nk2' }))).toEqual(['k1', 'k2']);
    });

    it('removes rights and keeps the policy', () => {
        const config = Setup.withoutRights({ schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } });
        expect(config.rights).toBeNull();
        expect(config.policy).toEqual({ type: 'unanimous' });
    });
});

describe('summary line', () => {
    it('says what is missing, then what the setup covers', () => {
        expect(Setup.summaryText(null, [])).toBe('Not set up yet — owners cannot accept until it is.');
        const threshold = { type: 'threshold', owners: { numerator: 1, denominator: 2, strict: false }, area: { numerator: 7, denominator: 10, strict: false } };
        expect(Setup.summaryText({ rights, policy: threshold }, ['key-a']))
            .toBe('Rights for 2 parcel(s), 3 owner(s) · Approval uses owner-count 1/2 and area 7/10 thresholds. · 1 lens member(s).');
        expect(Setup.summaryText({ rights, policy: { type: 'unanimous' } }, []))
            .toBe('Rights for 2 parcel(s), 3 owner(s) · Every declared owner must approve. · No lens member yet.');
    });
});

describe('the form', () => {
    it('renders the controls both hosts route on, with readiness against the declared parcels', () => {
        const html = Setup.html({ config: { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } }, lens: ['key-a'], cadastreParcelIds: ['HR-1', 'HR-2'] });
        for (const marker of ['data-approval-source', 'data-approval-file', 'data-editor-action="approval-import"',
            'data-editor-action="approval-template"', 'data-editor-action="approval-remove"', 'data-approval-policy-type', 'data-approval-lens']) {
            expect(html).toContain(marker);
        }
        expect(html).toContain('Ownership data is complete for the selected parcels.');
        expect(html).toContain('>key-a</textarea>');
        const missing = Setup.html({ config: { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } }, lens: [], cadastreParcelIds: ['HR-1', 'HR-9'] });
        expect(missing).toContain('Missing selected parcels: HR-9');
    });

    it('shows the threshold fields only for a threshold policy, and escapes what it prints', () => {
        const threshold = { type: 'threshold', owners: { numerator: 1, denominator: 2, strict: false }, area: { numerator: 7, denominator: 10, strict: true } };
        const html = Setup.html({ config: { schema: 'proposal-approval/v1', rights: null, policy: threshold }, lens: ['<b>'], error: 'bad <file>' });
        expect(html).toContain('data-approval-fraction="owners" value="1/2"');
        expect(html).toContain('bad &lt;file&gt;');
        expect(html).toContain('&lt;b&gt;</textarea>');
        expect(Setup.html({ config: null, lens: [] })).not.toContain('data-approval-fraction');
    });
});
