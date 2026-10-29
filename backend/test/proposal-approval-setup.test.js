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
    const words = () => require('../../frontend/js/proposals/approval-text.js');
    const t = (key, fallback, params = {}) => String(fallback).replace(/\{\{(\w+)\}\}/g, (_, name) => params[name]);

    it('describes every scheme in the same dimensions, derived from its own data', () => {
        const ids = regimes().DIMENSIONS.flatMap(group => group.ids);
        expect(ids).toEqual(['initiator', 'decider', 'support', 'electorate', 'dissenters', 'stage', 'basis', 'publicLand', 'levelling', 'valueGain', 'minParties']);
        const short = id => ids.map(key => words().dimensionText(key, regimes().dimensionsOf(regimes().latest(id)), t, 'short'));
        expect(short('nl-kavelruil')).toEqual(['Owners', 'Owners alone', 'Owners 100%', 'All owners', 'Veto', 'Agreement', 'Area or value', 'No cap', 'In money', 'Kept in land', 'At least 3']);
        expect(short('tw-owner-organized')).toEqual(['Owners', 'Owners, then authority', 'Private owners ≥ 1/2 · Private land > 1/2', 'Private owners only', 'Bound by the majority',
            'Plan', 'Value', '≤ 45% of the pool', 'In money', 'Kept in land', 'Any number']);
        expect(short('de-umlegung-developed')).toEqual(['Authority', 'Authority alone', 'No vote', 'Nobody', 'Bound by the authority', 'Plan', 'Area or value',
            '≤ 10% per owner (by area)', 'In money', 'All in money', 'Any number']);
        expect(short('tr-article-18')[9]).toBe('—');
        expect(short('in-gj-tps')[9]).toBe('50% in money');
        expect(short('jp-joint')[4]).toBe('Veto');
        // Every scheme has a value in every dimension, short and long.
        for (const template of regimes().list()) {
            const dimensions = regimes().dimensionsOf(template);
            for (const id of ids) for (const form of ['short', 'long']) expect(words().dimensionText(id, dimensions, t, form)).toMatch(/\S/);
        }
    });

    it('organizes the guide by those dimensions: a decision flow, each dimension, the outcome chart, the setup steps and the sources', () => {
        const html = Setup.schemeGuideHtml({ template: regimes().latest('de-umlegung-developed') });
        expect(html).toContain('data-scheme-guide="de-umlegung-developed"');
        expect(html).toContain('Rules checked 2026-10-28');
        // Decided: the authority starts it, nobody votes, the authority decides, the plan follows.
        const decision = html.slice(html.indexOf('data-scheme-guide-group="decision"'), html.indexOf('data-scheme-guide-group="distribution"'));
        expect(decision.match(/class="scheme-flow__step /g)).toHaveLength(4);
        expect(decision).toContain('data-scheme-flow-step="authority"');
        expect(decision).toContain('the Umlegung authority’s decision on the readjustment plan');
        expect(decision).not.toContain('class="scheme-gauge"');
        expect(decision.match(/data-scheme-dimension="/g)).toHaveLength(6);
        expect(decision).toContain('The authority’s decision binds every owner.');
        // Shared: every distribution dimension, then three example owners at the 10% cap.
        expect(html).toContain('Shared by area, each owner gives up at most 10% of their land for public use without compensation.');
        expect(html).toContain('data-scheme-outcome-example');
        expect(html.match(/data-scheme-outcome-row="/g)).toHaveLength(3);
        expect(html).toContain('scheme-outcome__tick--floor');
        expect(html).toContain('Three example owners giving up the most the scheme allows.');
        expect(html).toContain('Rules › Land contribution: the slider stops at 10%');
        expect(html).toContain('Proposer is not available under this scheme.');
        expect(html).toContain('gesetze-im-internet.de');
        expect(html).not.toContain('This agreement against the scheme');
        // A voluntary exchange: one owner-support gauge filled to all owners, no authority step, no cap.
        const exchange = Setup.schemeGuideHtml({ template: regimes().latest('nl-kavelruil') });
        expect(exchange.match(/class="scheme-gauge"/g)).toHaveLength(1);
        expect(exchange).toContain('--scheme-length: 100.0%');
        expect(exchange).not.toContain('data-scheme-flow-step="authority"');
        expect(exchange).not.toContain('scheme-outcome__tick--floor');
        expect(exchange).toContain('Three example owners giving up a quarter of their land: the scheme sets no cap.');
        expect(exchange).toContain('At least 3 parties bring land in.');
        // A value scheme with three tests at once: three gauges, the rights file and the value step.
        const japan = Setup.schemeGuideHtml({ template: regimes().latest('jp-association') });
        expect(japan.match(/class="scheme-gauge"/g)).toHaveLength(3);
        expect(japan).toContain('aria-label="at least 2/3 of the private owners"');
        expect(japan).toContain('Rules › Compensation: “Balance land value differences in money”');
        expect(japan).toContain('Parcel ownership rights: import a rights file (parcel-rights/v2) that lists every lease and its holders and which holders are public bodies.');
        expect(Setup.schemeGuideHtml({})).toBe('');
    });

    it('charts the host’s agreement party by party, marks an owner over the cap, and says what would meet it', () => {
        const template = regimes().latest('de-umlegung-developed');
        const ledger = { valued: false, publicM2: 600, proposerM2: 0, parties: [
            { ownerKey: 'o-b', displayName: 'Ben', contributedM2: 500, assignedM2: 500, entitlementM2: 450, cashCents: -2500, areaUnknown: false },
            { ownerKey: 'o-a', displayName: 'Ana', contributedM2: 1000, assignedM2: 400, entitlementM2: 900, cashCents: 50000, areaUnknown: false }
        ] };
        const model = Setup.outcomeModel(regimes().dimensionsOf(template), ledger, 'area');
        expect(model.rows.map(row => [row.label, row.putIn, row.getsBack, row.owed, row.floor, row.overCap])).toEqual([
            ['Ana', 1000, 400, 900, 900, true], ['Ben', 500, 500, 450, 450, false]]);
        expect(model.extra).toEqual([{ kind: 'public', label: 'Public', getsBack: 600 }]);
        expect(model.scale).toBe(1000);
        const rules = [{ kind: 'cap', per: 'owner', limit: { numerator: 1, denominator: 10 }, worst: { ownerKey: 'o-a', given: 0.6 }, ok: false }, { kind: 'proposer', areaM2: 0, ok: true }];
        const html = Setup.schemeGuideHtml({ template, ledger, rules, currency: 'EUR', check: { ok: false, lines: [{ ok: false, text: 'Ana gives up 60% of their land; the cap is 10%.' }, { ok: true, text: 'No land goes to a proposer.' }] } });
        expect(html).toContain('<li data-check-ok="false">Ana gives up 60% of their land; the cap is 10%.</li>');
        expect(html).toMatch(/class="scheme-outcome__row is-over-cap" data-scheme-outcome-row="o-a">/);
        expect(html).toMatch(/data-scheme-outcome-row="o-b">/);
        expect(html).toContain('gives up 60%');
        expect(html).toContain('scheme-outcome__cash--receives">+500 EUR');
        expect(html).toContain('scheme-outcome__cash--pays">−25 EUR');
        expect(html).toContain('scheme-outcome__row--public');
        expect(html).not.toContain('data-scheme-outcome-example');
        expect(html.indexOf('data-scheme-outcome-row="o-a"')).toBeLessThan(html.indexOf('data-scheme-outcome-row="o-b"'));
        // Ana put in 1000 and may give up 100: 500 m² have to come back.
        expect(html).toContain('In Output parcels, give Ana at least 500 m² more land back, or lower the Land contribution');
        // By value: a valued ledger opens on value for a value scheme and offers the area view too.
        const valued = { ...ledger, valued: true, publicValueCents: 0, proposerValueCents: 0, parties: ledger.parties.map(party => ({ ...party, contributedValueCents: 1000000, assignedValueCents: 2500000, entitlementValueCents: 1200000 })) };
        const value = Setup.schemeGuideHtml({ template: regimes().latest('jp-association'), ledger: valued, currency: 'EUR' });
        expect(value).toContain('data-scheme-outcome="value"');
        expect(value).toContain('10000 EUR → 25000 EUR');
        expect(value).toMatch(/value="area" data-scheme-outcome-measure>/);
        expect(Setup.schemeGuideHtml({ template: regimes().latest('jp-association'), ledger: valued, measure: 'area' })).toContain('data-scheme-outcome="area"');
        // A pool cap draws the pool's share not returned to owners against the cap.
        const pool = Setup.outcomeModel(regimes().dimensionsOf(regimes().latest('tw-owner-organized')), ledger, 'area');
        expect(pool.pool).toEqual({ given: 0.4, limit: 0.45 });
        const few = Setup.schemeGuideHtml({ template: regimes().latest('nl-kavelruil'), ledger, rules: [{ kind: 'parties', required: 3, actual: 2, ok: false }], check: { ok: false, lines: [{ ok: false, text: 'few' }] } });
        expect(few).toContain('2 parties bring land in and this scheme needs 3');
    });

    it('compares every scheme in the same dimensions, the picked one marked and the broken ones flagged', () => {
        const html = Setup.compareHtml('nl-kavelruil', { 'de-umlegung-developed': false });
        expect(html.match(/data-scheme-compare-row="/g)).toHaveLength(regimes().list().length);
        expect(html.match(/<th scope="col">/g)).toHaveLength(12);
        expect(html).toContain('<tr aria-current="true" data-scheme-compare-row="nl-kavelruil">');
        expect(html).toContain('data-scheme-guide-choose="jp-association"');
        expect(html).toMatch(/data-scheme-guide-choose="de-umlegung-developed">[^<]+<\/button> <span class="cb-badge cb-badge--warning">not met by this plan/);
        expect(html).not.toMatch(/<details[^>]* open/);
        expect(Setup.compareHtml('nl-kavelruil', null, true)).toMatch(/<details class="scheme-compare" data-scheme-compare open>/);
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
