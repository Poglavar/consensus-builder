// Words for approval rules and agreement schemes, shared by the setup form, the Owner acceptance card,
// the owner review and the land readjustment designer, so a rule reads the same everywhere. Pure:
// callers pass their translator `t(key, fallback, params)`; the English fallbacks live here.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApprovalText = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const approval = () => root.ProposalApproval || (typeof require === 'function' ? require('./approval.js') : null);
    const regimes = () => root.ProposalApprovalRegimes || (typeof require === 'function' ? require('./approval-regimes.js') : null);

    const NOUNS = {
        'headcount:owners:all': 'of the owners',
        'headcount:owners:private': 'of the private owners',
        'headcount:leaseholders:all': 'of the leaseholders',
        'headcount:leaseholders:private': 'of the private leaseholders',
        'headcount:owners+leaseholders:all': 'of the owners and leaseholders together',
        'headcount:owners+leaseholders:private': 'of the private owners and leaseholders together',
        'area:owners:all': 'of the area',
        'area:owners:private': 'of the private land',
        'area:leaseholders:all': 'of the leased area',
        'area:leaseholders:private': 'of the privately leased area',
        'area:owners+leaseholders:all': 'of the owned and leased area',
        'area:owners+leaseholders:private': 'of the private owned and leased area'
    };
    const METERS = {
        'headcount:owners:all': 'Owners', 'headcount:owners:private': 'Private owners',
        'headcount:leaseholders:all': 'Leaseholders', 'headcount:leaseholders:private': 'Private leaseholders',
        'headcount:owners+leaseholders:all': 'Owners and leaseholders', 'headcount:owners+leaseholders:private': 'Private owners and leaseholders',
        'area:owners:all': 'Area', 'area:owners:private': 'Private land',
        'area:leaseholders:all': 'Leased area', 'area:leaseholders:private': 'Privately leased area',
        'area:owners+leaseholders:all': 'Owned and leased area', 'area:owners+leaseholders:private': 'Private owned and leased area'
    };
    // i18n keys cannot hold "+" or ":" readably; this is the key segment for a test.
    const slug = test => `${test.measure}-${test.of.replace('+', '-and-')}-${test.scope}`;
    const keyOf = test => `${test.measure}:${test.of}:${test.scope}`;

    // A stable name for a test's progress meter. The two tests of the older owner/area rule keep
    // the names "owners" and "area"; the rest say what they count.
    function meterName(test) {
        if (test.of === 'owners' && test.scope === 'all') return test.measure === 'headcount' ? 'owners' : 'area';
        return slug(test);
    }

    function thresholdText(test, t) {
        const fraction = `${test.numerator}/${test.denominator}`;
        if (test.numerator === test.denominator && !test.strict) return t('proposalApproval.rules.all', 'every one');
        return test.strict ? t('proposalApproval.moreThan', 'more than {{fraction}}', { fraction })
            : t('proposalApproval.atLeast', 'at least {{fraction}}', { fraction });
    }

    // "at least 2/3 of the private owners"
    function testText(test, t) {
        return `${thresholdText(test, t)} ${t(`proposalApproval.rules.of.${slug(test)}`, NOUNS[keyOf(test)])}`;
    }

    function meterLabel(test, t) {
        if (test.of === 'owners' && test.scope === 'all') {
            return test.measure === 'headcount' ? t('proposalApproval.meterOwners', 'Owners') : t('reparcellization.modal.colArea', 'Area');
        }
        return t(`proposalApproval.rules.meter.${slug(test)}`, METERS[keyOf(test)]);
    }

    function regimeOf(regime) {
        return regime ? regimes()?.get(regime.id, regime.version) || null : null;
    }

    // What the required authority decision is, in the scheme's own terms when there is one.
    function authorityText(regime, t) {
        const template = regimeOf(regime);
        if (template?.text?.authority) return t(`proposalApproval.schemes.${template.id}.authority`, template.text.authority);
        return t('proposalApproval.rules.authorityGeneric', 'an authority’s approval');
    }

    // Heads before area, owners before leaseholders: the order people read a rule in.
    const ORDER = { headcount: 0, area: 1, owners: 0, leaseholders: 1, 'owners+leaseholders': 2, all: 0, private: 1 };
    const orderTests = tests => tests.slice().sort((a, b) => ORDER[a.measure] - ORDER[b.measure] || ORDER[a.of] - ORDER[b.of] || ORDER[a.scope] - ORDER[b.scope]);

    // The whole rule as one sentence.
    function rulesText(policy, t, regime = null) {
        const rules = approval().policyRules(policy);
        if (policy?.type === 'unanimous' || !policy) return t('proposalApproval.ruleUnanimous', 'Configured approval rules require every owner to accept.');
        const tests = orderTests(rules.tests).map(test => testText(test, t));
        const authority = rules.authorities.length ? authorityText(regime, t) : null;
        if (!tests.length) return t('proposalApproval.rules.authorityOnly', 'Configured approval rules require only {{authority}}. Owner responses do not decide this tally.', { authority });
        const joined = tests.length === 1 ? tests[0]
            : tests.slice(0, -1).join(', ') + t('proposalApproval.rules.and', ' and ') + tests[tests.length - 1];
        return authority
            ? t('proposalApproval.rules.passesWithAuthority', 'Configured approval rules require {{tests}} and {{authority}}.', { tests: joined, authority })
            : t('proposalApproval.rules.passesWith', 'Configured approval rules require {{tests}}.', { tests: joined });
    }

    function regimeName(regime, t) {
        const template = regimeOf(regime) || (regime?.id ? regimes()?.latest(regime.id) : null);
        return template ? t(`proposalApproval.schemes.${template.id}.name`, template.text.name) : null;
    }

    function stageText(template, t) {
        const fallback = { agreement: 'a voluntary agreement', initiative: 'starting the procedure (initiative)', association: 'forming the association',
            plan: 'the readjustment plan', execution: 'carrying out the readjustment' }[template.stage] || template.stage;
        return t('proposalApproval.regime.stage', 'What this support is for: {{stage}}', { stage: t(`proposalApproval.regime.stages.${template.stage}`, fallback) });
    }

    function familyText(template, t) {
        const fallback = { voluntary: 'Voluntary agreement', 'support-and-authority': 'Owner support, then an authority decides',
            'authority-led': 'Authority-led: owners are heard' }[template.family];
        return t(`proposalApproval.regime.families.${template.family}`, fallback);
    }

    // How land is distributed under the scheme, one line per rule.
    function allocationLines(template, t) {
        const lines = [];
        const allocation = template?.allocation || {};
        if (allocation.basis === 'area') lines.push(t('proposalApproval.regime.basisArea', 'New plots are distributed by area.'));
        else if (allocation.basis === 'value') lines.push(t('proposalApproval.regime.basisValue', 'New plots are distributed by land value, so the parcels need land values.'));
        const cap = allocation.cap;
        if (cap) {
            const percent = Math.round((cap.numerator / cap.denominator) * 1000) / 10;
            lines.push(cap.per === 'pool'
                ? t('proposalApproval.regime.capPool', 'Land not returned to owners is at most {{percent}}% of the pool.', { percent })
                : cap.basis === 'area'
                    ? t('proposalApproval.regime.capOwnerWhenArea', 'Distributed by area, no owner gives up more than {{percent}}% of their land.', { percent })
                    : t('proposalApproval.regime.capOwner', 'No owner gives up more than {{percent}}% of their land.', { percent }));
        }
        return lines;
    }

    // A plan's check against the scheme (approval-regimes.js checkAllocation), one line per rule.
    function checkLines(check, t, label = id => id) {
        return (check?.rules || []).map(rule => {
            const percent = value => `${Math.round(value * 1000) / 10}%`;
            if (rule.kind === 'basis') {
                return rule.ok ? t('proposalApproval.regime.check.basisOk', 'Distributed by {{basis}}, as the scheme requires.', { basis: t(`proposalApproval.regime.basis.${rule.required}`, rule.required === 'area' ? 'surface area' : 'land value') })
                    : t('proposalApproval.regime.check.basisWrong', 'The scheme distributes by {{basis}}, but this plan distributes by {{actual}}.', {
                        basis: t(`proposalApproval.regime.basis.${rule.required}`, rule.required === 'area' ? 'surface area' : 'land value'), actual: t(`proposalApproval.regime.basis.${rule.actual}`, rule.actual === 'area' ? 'surface area' : 'land value') });
            }
            const limit = percent(rule.limit.numerator / rule.limit.denominator);
            if (rule.per === 'owner') {
                if (!rule.worst) return t('proposalApproval.regime.check.capOwnerNone', 'No owner gives up land.');
                const params = { owner: label(rule.worst.ownerKey), given: percent(rule.worst.given), limit };
                return rule.ok ? t('proposalApproval.regime.check.capOwnerOk', 'The most any owner gives up is {{given}} ({{owner}}); the cap is {{limit}}.', params)
                    : t('proposalApproval.regime.check.capOwnerOver', '{{owner}} gives up {{given}} of their land; the cap is {{limit}}.', params);
            }
            if (rule.given === null) return t('proposalApproval.regime.check.capPoolUnknown', 'The pool area is unknown, so the {{limit}} cap cannot be checked.', { limit });
            return rule.ok ? t('proposalApproval.regime.check.capPoolOk', '{{given}} of the pool is not returned to owners; the cap is {{limit}}.', { given: percent(rule.given), limit })
                : t('proposalApproval.regime.check.capPoolOver', '{{given}} of the pool is not returned to owners, over the {{limit}} cap.', { given: percent(rule.given), limit });
        });
    }

    // The declared snapshot source and selected lens are configuration, not verified attestations.
    function reviewBasisLines({ rightsSource = null, lens = [] } = {}, t, memberLabel = String) {
        const source = [rightsSource?.provider, rightsSource?.reference]
            .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()).join(' · ');
        return [
            source ? t('proposalApproval.review.rightsSource', 'Declared rights source: {{source}}', { source })
                : t('proposalApproval.review.rightsSourceUnknown', 'No rights source is specified in this record.'),
            lens.length ? t('proposalApproval.review.selectedLens', 'Selected verification lens: {{members}}', { members: lens.map(memberLabel).join(', ') })
                : t('proposalApproval.review.noLens', 'No verification lens is selected.')
        ];
    }

    // A consent tally names its evidence source; a local record is not a verified signature.
    function consentLabels(basis, t, counts = {}) {
        const signed = basis === 'signed-receipts';
        const labels = signed ? {
            parcelTitle: 'Parcel consent from verified receipts:',
            ownerTitle: 'Owner approvals from verified receipts:',
            accepted: 'Verified approval for current terms',
            pending: 'No current verified approval',
            hint: 'Signed receipts verified against the current terms and declared approval context. They do not establish legal title or payment.',
            parcelSummary: '{{accepted}}/{{total}} parcels with verified receipts'
        } : {
            parcelTitle: 'Locally recorded parcel consent:',
            ownerTitle: 'Local owner-entry consent:',
            accepted: 'Consent recorded in this browser',
            pending: 'No current local consent record',
            hint: 'Unsigned records in this browser, matched to the current terms and owner roster. They do not verify signing authority or legal ownership.',
            parcelSummary: '{{accepted}}/{{total}} parcels with local consent'
        };
        return Object.fromEntries(Object.entries(labels).map(([key, fallback]) => [key,
            t(`panel.proposal.acceptance.${signed ? 'signed' : 'local'}.${key}`, fallback, counts)]));
    }

    return { orderTests, meterName, meterLabel, thresholdText, testText, rulesText, authorityText, regimeName, regimeOf, stageText, familyText, allocationLines, checkLines, reviewBasisLines, consentLabels };
});
