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


describe('the plan against the schemes', () => {
    it('marks the schemes the plan does not meet in the dropdown and lists the chosen scheme’s check in its card', () => {
        const config = Setup.withPolicyFromForm(form({ '[data-approval-regime]': 'de-umlegung-developed' }), null);
        const html = Setup.html({ config, schemeStatus: { 'de-umlegung-developed': false, 'de-umlegung-new': true, 'nl-kavelruil': false },
            schemeCheck: { ok: false, lines: [{ ok: false, text: 'Ana gives up 60% of their land; the cap is 10%.' }, { ok: true, text: 'No land goes to a proposer.' }] } });
        expect(html).toContain('<option value="de-umlegung-developed" selected data-scheme-met="false">Germany — Umlegung, already developed land — not met by this plan</option>');
        expect(html).toContain('<option value="de-umlegung-new" data-scheme-met="true">Germany — Umlegung, land developed for the first time</option>');
        expect(html).toContain('<option value="nl-kavelruil" data-scheme-met="false">Netherlands — voluntary urban land exchange (kavelruil) — not met by this plan</option>');
        // A scheme the host did not judge is offered as before.
        expect(html).toContain('<option value="tr-article-18">Turkey — article 18 readjustment</option>');
        expect(html).toContain('<ul class="approval-setup__check" data-approval-scheme-check data-approval-scheme-ok="false">');
        expect(html).toContain('<li data-check-ok="false">Ana gives up 60% of their land; the cap is 10%.</li>');
        expect(html).toContain('<li data-check-ok="true">No land goes to a proposer.</li>');
        expect(html).toContain('This plan against the scheme');
        const plain = Setup.html({ config });
        expect(plain).not.toContain('data-scheme-met'); expect(plain).not.toContain('data-approval-scheme-check');
    });
});

describe('agreement scheme presentation', () => {
    it('shows one experimental pill beside the rules control and keeps scheme facts and sources without disclaimers', () => {
        const config = Setup.withPolicyFromForm(form({ '[data-approval-regime]': 'de-umlegung-new' }), null);
        const html = Setup.html({ config });
        expect(html).toContain('class="cb-badge cb-badge--warning" data-approval-experimental>Experimental</span>');
        expect(html.match(/data-approval-experimental/g)).toHaveLength(1);
        expect(html.indexOf('data-approval-experimental')).toBeLessThan(html.indexOf('<select data-approval-rule data-approval-regime>'));
        expect(html).toContain('Germany — Umlegung'); expect(html).toContain('gesetze-im-internet.de');
        expect(html).not.toMatch(/Research template|Comparative research|not legal advice|approval-setup__caveat|approval-setup__research/);
    });
});

describe('the scheme guide', () => {
    const regimes = () => require('../../frontend/js/proposals/approval-regimes.js');
    it('explains a scheme from its own data: who decides, the distribution with a schematic, the setup steps and the sources', () => {
        const html = Setup.schemeGuideHtml({ template: regimes().latest('de-umlegung-developed') });
        expect(html).toContain('data-scheme-guide="de-umlegung-developed"');
        expect(html).toContain('Rules checked 2026-10-28');
        expect(html).toContain('Configured approval rules require only the Umlegung authority’s decision on the readjustment plan.');
        expect(html).toContain('Owners are heard; the authority decides.');
        expect(html).toContain('Distributed by area, no owner gives up more than 10% of their land.');
        // The schematic: three example owners above, the public take and the owners' plots below.
        expect(html).toContain('<svg class="scheme-guide__svg"');
        expect(html.match(/scheme-guide__slice--owner-/g)).toHaveLength(6);
        expect(html).toContain('scheme-guide__slice--public');
        expect(html).toContain('Each owner gives up at most 10% of their land for public use without compensation and gets a plot back');
        expect(html).toContain('Three example owners');
        expect(html).toContain('Rules › Land contribution: the slider stops at 10%');
        expect(html).toContain('Proposer is not available under this scheme.');
        expect(html).toContain('Rules › Authority: an id for the Umlegung authority’s decision on the readjustment plan');
        expect(html).toContain('gesetze-im-internet.de');
        expect(html).not.toContain('This agreement against the scheme');
        // A voluntary exchange: no public slice, every party agrees, the party count.
        const exchange = Setup.schemeGuideHtml({ template: regimes().latest('nl-kavelruil') });
        expect(exchange).not.toContain('scheme-guide__slice--public');
        expect(exchange).toContain('The parties agree what each gets back; the scheme sets no cap on public land');
        expect(exchange).toContain('At least 3 parties bring land in.');
        expect(exchange).toContain('Rules › Compensation: by area (a rate per m²) or by value');
        // A value scheme with leases in its tests: the rights file and the value compensation step.
        const japan = Setup.schemeGuideHtml({ template: regimes().latest('jp-association') });
        expect(japan).toContain('Rules › Compensation: “Balance land value differences in money”');
        expect(japan).toContain('Parcel ownership rights: import a rights file (parcel-rights/v2) that lists every lease and its holders and which holders are public bodies.');
        expect(japan).toContain('at least 2/3 of the private owners');
        expect(Setup.schemeGuideHtml({})).toBe('');
    });

    it('shows the host’s agreement against the scheme, with the parties and what would meet a broken rule', () => {
        const template = regimes().latest('de-umlegung-developed');
        const ledger = { valued: false, parties: [
            { ownerKey: 'o-a', displayName: 'Ana', contributedM2: 1000, assignedM2: 400, areaUnknown: false },
            { ownerKey: 'o-b', displayName: 'Ben', contributedM2: 500, assignedM2: 500, areaUnknown: false }
        ] };
        const rules = [{ kind: 'cap', per: 'owner', limit: { numerator: 1, denominator: 10 }, worst: { ownerKey: 'o-a', given: 0.6 }, ok: false }, { kind: 'proposer', areaM2: 0, ok: true }];
        const html = Setup.schemeGuideHtml({ template, ledger, rules, check: { ok: false, lines: [{ ok: false, text: 'Ana gives up 60% of their land; the cap is 10%.' }, { ok: true, text: 'No land goes to a proposer.' }] } });
        expect(html).toContain('<li data-check-ok="false">Ana gives up 60% of their land; the cap is 10%.</li>');
        expect(html).toContain('<th scope="row">Ana</th>');
        expect(html).toContain('<td>60%</td>'); expect(html).toContain('<td>0%</td>');
        // Ana put in 1000 and may give up 100: 500 m² have to come back.
        expect(html).toContain('In Output parcels, give Ana at least 500 m² more land back, or lower the Land contribution');
        // The real parties replace the example owners in the schematic, largest first.
        expect(html.match(/scheme-guide__slice--owner-/g)).toHaveLength(4);
        expect(html).not.toContain('Three example owners');
        expect(html.indexOf('>Ana<')).toBeLessThan(html.indexOf('>Ben<'));
        const value = Setup.schemeGuideHtml({ template: regimes().latest('jp-association'), ledger: { ...ledger, valued: true, parties: ledger.parties.map(party => ({ ...party, contributedValueCents: 1000000, assignedValueCents: 2500000 })) },
            rules: [{ kind: 'basis', required: 'value', actual: 'area', ok: false }], check: { ok: false, lines: [{ ok: false, text: 'basis' }] }, currency: 'EUR' });
        expect(value).toContain('10000 EUR'); expect(value).toContain('25000 EUR');
        expect(value).toContain('set Compensation to “Balance land value differences in money”');
        const few = Setup.schemeGuideHtml({ template: regimes().latest('nl-kavelruil'), ledger, rules: [{ kind: 'parties', required: 3, actual: 2, ok: false }], check: { ok: false, lines: [{ ok: false, text: 'few' }] } });
        expect(few).toContain('2 parties bring land in and this scheme needs 3');
    });

    it('offers the whole catalogue in its picker, the current scheme selected and the broken ones marked', () => {
        const html = Setup.schemePickerHtml('nl-kavelruil', { 'nl-kavelruil': true, 'de-umlegung-developed': false });
        expect(html).toContain('<select data-scheme-guide-pick>');
        expect(html).toMatch(/<option value="nl-kavelruil" selected data-scheme-met="true">/);
        expect(html).toMatch(/<option value="de-umlegung-developed" data-scheme-met="false">[^<]*— not met by this plan</);
        expect(html).toContain('<option value="jp-association">');
        expect((html.match(/<optgroup /g) || []).length).toBeGreaterThan(1);
    });

    it('pins a scheme on a config with withScheme, keeping the authority id already typed', () => {
        const regime = regimes().latest('de-umlegung-developed');
        const pinned = Setup.withScheme(null, regime);
        expect(pinned.regime).toEqual({ id: regime.id, version: regime.version });
        expect(pinned.policy.type).toBe('rules');
        const typed = Setup.withScheme({ ...pinned, policy: { ...pinned.policy, authorities: [{ authorityId: 'city-of-x' }] } }, regimes().latest('jp-association'));
        expect(typed.regime.id).toBe('jp-association');
        expect(typed.policy.authorities.map(row => row.authorityId)).toEqual(['city-of-x']);
        const voluntary = Setup.withScheme(pinned, regimes().latest('nl-kavelruil'));
        expect(require('../../frontend/js/proposals/approval.js').policyRules(voluntary.policy).authorities).toEqual([]);
    });
});
