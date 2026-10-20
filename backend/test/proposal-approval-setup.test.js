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

// A container whose controls answer querySelector by attribute selector; `tests` are the custom
// test rows, each a map of its own selectors.
function form(values, tests = null) {
    const row = fields => ({ querySelector: selector => (selector in fields ? { value: fields[selector] } : null) });
    return {
        querySelector(selector) {
            if (selector === '[data-approval-tests]') return tests ? {} : null;
            if (selector === '[data-approval-custom-authority]') return '[data-approval-custom-authority]' in values ? { checked: values['[data-approval-custom-authority]'] } : null;
            if (!(selector in values)) return null;
            return { value: values[selector] };
        },
        querySelectorAll(selector) {
            if (selector === '[data-approval-test]') return (tests || []).map(row);
            if (selector === '[data-approval-authority-id]') return '[data-approval-authority-id="0"]' in values ? [{ value: values['[data-approval-authority-id="0"]'] }] : [];
            return [];
        }
    };
}
const test = (strict, fraction, measure, of, scope) => ({
    '[data-approval-test-strict]': strict, '[data-approval-test-fraction]': fraction, '[data-approval-test-measure]': measure,
    '[data-approval-test-of]': of, '[data-approval-test-scope]': scope
});

describe('reading the form back', () => {
    it('stores custom owner and area tests in the older threshold form, so existing hashes hold', () => {
        const config = Setup.withPolicyFromForm(form({ '[data-approval-regime]': 'custom' }, [
            test('false', '1/2', 'headcount', 'owners', 'all'), test('true', ' 7 / 10 ', 'area', 'owners', 'all')
        ]), { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } });
        expect(config.policy).toEqual({
            type: 'threshold',
            owners: { numerator: 1, denominator: 2, strict: false },
            area: { numerator: 7, denominator: 10, strict: true }
        });
        expect(config.regime).toBeUndefined();
        expect(config.rights.parcels).toHaveLength(2);
    });

    it('keeps rules that only the general form can hold, with their authority', () => {
        const config = Setup.withPolicyFromForm(form({ '[data-approval-regime]': 'custom', '[data-approval-custom-authority]': true, '[data-approval-authority-id="0"]': 'city-council' }, [
            test('false', '2/3', 'headcount', 'leaseholders', 'private')
        ]), null);
        expect(config.policy).toEqual({ type: 'rules', tests: [{ measure: 'headcount', of: 'leaseholders', scope: 'private', numerator: 2, denominator: 3, strict: false }],
            authorities: [{ authorityId: 'city-council' }] });
    });

    it('pins a chosen scheme by id and version and takes its rules', () => {
        const config = Setup.withPolicyFromForm(form({ '[data-approval-regime]': 'es-ct-basic', '[data-approval-authority-id="0"]': 'ajuntament' }), null);
        expect(config.regime).toEqual({ id: 'es-ct-basic', version: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
        expect(config.policy).toEqual({ type: 'rules', tests: [{ measure: 'area', of: 'owners', scope: 'all', numerator: 1, denominator: 2, strict: true }],
            authorities: [{ authorityId: 'ajuntament' }] });
        // Switching back to custom keeps the tests and the authority and drops the pin.
        const custom = Setup.withPolicyFromForm(form({ '[data-approval-regime]': 'custom' }), config);
        expect(custom.regime).toBeUndefined();
        expect(custom.policy).toEqual({ type: 'rules', tests: [{ measure: 'area', of: 'owners', scope: 'all', numerator: 1, denominator: 2, strict: true }],
            authorities: [{ authorityId: 'ajuntament' }] });
    });

    it('starts custom rules from the usual majority when chosen from "every owner must agree"', () => {
        const config = Setup.withPolicyFromForm(form({ '[data-approval-regime]': 'custom' }), null);
        expect(config.policy).toEqual({ type: 'threshold', owners: { numerator: 1, denominator: 2, strict: false }, area: { numerator: 7, denominator: 10, strict: false } });
        expect(Setup.ruleChoice(config)).toBe('custom');
        // Once the rows are on the form, what they say is what is saved, even "all of the owners".
        const all = Setup.withPolicyFromForm(form({ '[data-approval-regime]': 'custom' }, [test('false', '1/1', 'headcount', 'owners', 'all')]), config);
        expect(all.policy).toEqual({ type: 'unanimous' });
    });

    it('refuses a malformed fraction instead of guessing', () => {
        expect(() => Setup.withPolicyFromForm(form({ '[data-approval-regime]': 'custom' }, [test('false', 'half', 'headcount', 'owners', 'all')]), null)).toThrow(/fraction/);
    });

    it('reads unanimous when the rules say so, and the lens as unique keys', () => {
        expect(Setup.withPolicyFromForm(form({ '[data-approval-regime]': 'unanimous' }), null).policy).toEqual({ type: 'unanimous' });
        expect(Setup.lensFromText('key-a\nkey-b, key-a\n\n')).toEqual(['key-a', 'key-b']);
        expect(Setup.lensFromForm(form({ '[data-approval-lens]': 'k1\nk2' }))).toEqual(['k1', 'k2']);
    });

    it('adds the first kind of test the rules do not count yet, and removes by index', () => {
        const start = { schema: 'proposal-approval/v1', rights: null, policy: { type: 'threshold', area: { numerator: 1, denominator: 2, strict: false } } };
        const added = Setup.withRuleAction(form({ '[data-approval-regime]': 'custom' }), start, 'approval-test-add');
        expect(added.policy).toEqual({ type: 'threshold', owners: { numerator: 1, denominator: 2, strict: false }, area: { numerator: 1, denominator: 2, strict: false } });
        // Rows follow the canonical order (area, then headcount); index 0 is the area test.
        const removed = Setup.withRuleAction(form({ '[data-approval-regime]': 'custom' }), added, 'approval-test-remove', '0');
        expect(removed.policy).toEqual({ type: 'threshold', owners: { numerator: 1, denominator: 2, strict: false } });
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
            .toBe('Rights for 2 parcel(s), 3 owner(s) · Configured approval rules require at least 1/2 of the owners and at least 7/10 of the area. · 1 lens member(s).');
        expect(Setup.summaryText({ rights, policy: { type: 'unanimous' } }, []))
            .toBe('Rights for 2 parcel(s), 3 owner(s) · Configured approval rules require every owner to accept. · No lens member yet.');
        const scheme = { schema: 'proposal-approval/v1', rights, policy: { type: 'rules', tests: [{ measure: 'area', of: 'owners', scope: 'all', numerator: 1, denominator: 2, strict: true }],
            authorities: [{ authorityId: 'ajuntament' }] }, regime: { id: 'es-ct-basic', version: '2026-10-11' } };
        expect(Setup.summaryText(scheme, ['key-a'])).toBe('Rights for 2 parcel(s), 3 owner(s) · Catalonia — basic compensation: Configured approval rules require more than 1/2 of the area and the municipality’s approval of the compensation project. · 1 lens member(s).');
    });
});

describe('the form', () => {
    it('renders the controls both hosts route on, with readiness against the declared parcels', () => {
        const html = Setup.html({ config: { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } }, lens: ['key-a'], cadastreParcelIds: ['HR-1', 'HR-2'] });
        for (const marker of ['data-approval-source', 'data-approval-file', 'data-editor-action="approval-import"',
            'data-editor-action="approval-template"', 'data-editor-action="approval-remove"', 'data-approval-regime', 'data-approval-lens']) {
            expect(html).toContain(marker);
        }
        expect(html).toContain('Ownership data is complete for the selected parcels.');
        expect(html).toContain('>key-a</textarea>');
        // Every scheme is offered, grouped by how it decides.
        expect(html).toContain('<optgroup label="Authority-led: owners are heard">');
        expect(html).toContain('value="jp-association"');
        const missing = Setup.html({ config: { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } }, lens: [], cadastreParcelIds: ['HR-1', 'HR-9'] });
        expect(missing).toContain('Missing selected parcels: HR-9');
    });

    it('shows the test rows only for custom rules, the scheme card only for a scheme, and escapes what it prints', () => {
        const threshold = { type: 'threshold', owners: { numerator: 1, denominator: 2, strict: false }, area: { numerator: 7, denominator: 10, strict: true } };
        const html = Setup.html({ config: { schema: 'proposal-approval/v1', rights: null, policy: threshold }, lens: ['<b>'], error: 'bad <file>' });
        expect(html).toContain('data-approval-test="0"');
        expect(html).toContain('data-approval-test-fraction value="7/10"');
        expect(html).toContain('bad &lt;file&gt;');
        expect(html).toContain('&lt;b&gt;</textarea>');
        expect(html).not.toContain('data-approval-regime-details');
        expect(Setup.html({ config: null, lens: [] })).not.toContain('data-approval-test=');
        const scheme = Setup.html({ config: { schema: 'proposal-approval/v1', rights: null, policy: { type: 'rules', tests: [
            { measure: 'headcount', of: 'owners', scope: 'private', numerator: 2, denominator: 3, strict: false },
            { measure: 'headcount', of: 'leaseholders', scope: 'private', numerator: 2, denominator: 3, strict: false },
            { measure: 'area', of: 'owners+leaseholders', scope: 'private', numerator: 2, denominator: 3, strict: false }
        ], authorities: [{ authorityId: 'governor' }] }, regime: { id: 'jp-association', version: '2026-10-11' } }, lens: [] });
        expect(scheme).toContain('data-approval-regime-details="jp-association"');
        expect(scheme).toContain('data-approval-authority-id="0" value="governor"');
        expect(scheme).toContain('every lease and its holders and which holders are public bodies');
        expect(scheme).not.toContain('data-approval-test=');
    });
});
