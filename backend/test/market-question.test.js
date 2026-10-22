// The market question builder (streamline.md A1/K3): one tuple renders the question people bet on,
// the sentence saying how it settles and the recipe body hashed on-chain, so the three cannot drift;
// and the Bets sheet's undated questions of one agreement's pool and of a contest of agreements.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const MarketQuestion = require('../../frontend/js/bets/market-question.js');
const Sha256 = require('../../frontend/js/bets/sha256.js');
// The subject text a case's 'jurisdiction|ids' literal becomes: the jurisdiction and the set hash.
const hashed = text => `${text.split('|')[0]}|sha256:${Sha256.hex(text)}`;
const SCHEMA = JSON.parse(readFileSync(new URL('../oracle/recipe.schema.json', import.meta.url), 'utf8'));

const ACCOUNT = 'Bv7nU2fJ9kQ4xR8sT3wY6zA1cD5eF7gH9jK2mN4pQ6r';
const SF = { jurisdiction: 'US-CA-SF', authority: 'San Francisco', label: 'Candlestick Point', parcelIds: ['4884040', '4884039A'] };
const ZAGREB = { jurisdiction: 'HR-ZAGREB', authority: 'the City of Zagreb' };
const TOWERS = 'a plan amendment removing the towers from the Candlestick Point design for development';

// One tuple per rule, with everything it must print. Labels never appear inside the evidence
// fields, so a label found in a rule text could only have come from the label.
const CASES = [
    {
        name: 'permitted: a numbered permit is issued',
        tuple: { milestone: 'permitted', subject: SF, deadline: '2026-12-31T23:59:59-08:00',
            evidence: { source: 'sf-dbi-permits-v1', permitNumber: '202603026735', event: 'issued' } },
        question: 'Will San Francisco issue building permit 202603026735 for Candlestick Point by 31 December 2026?',
        settles: 'Yes if the San Francisco Department of Building Inspection permits dataset shows permit 202603026735 with an issued date on or before 31 December 2026; no if that date passes without such a record. Anyone can settle it from the public record.',
        eventType: 'permit_issued', id: 'sf-dbi-permits-permitted-v1',
        subjectText: 'US-CA-SF|4884039A,4884040',
        yesText: 'permit 202603026735 issued on or before 2026-12-31T23:59:59-08:00',
        noText: 'no matching record on or before 2026-12-31T23:59:59-08:00',
        ruleFields: { permitNumber: '202603026735', event: 'issued' }
    },
    {
        name: 'permitted: any new-construction permit is filed',
        tuple: { milestone: 'permitted', subject: SF, deadline: '2027-06-30T23:59:59-07:00',
            evidence: { source: 'sf-dbi-permits-v1', anyNewConstruction: true, event: 'filed', notBefore: '2026-10-12T00:00:00-07:00' } },
        question: 'Will a new-construction building permit be filed for Candlestick Point by 30 June 2027?',
        settles: 'Yes if the San Francisco Department of Building Inspection permits dataset shows a new-construction building permit on Candlestick Point (2 parcels) with a filed date after 12 October 2026 and on or before 30 June 2027; no if that date passes without such a record. Anyone can settle it from the public record.',
        eventType: 'permit_filed', id: 'sf-dbi-permits-permitted-v1',
        subjectText: 'US-CA-SF|4884039A,4884040',
        yesText: 'new-construction building permit filed after 2026-10-12T00:00:00-07:00 and on or before 2027-06-30T23:59:59-07:00',
        noText: 'no matching record on or before 2027-06-30T23:59:59-07:00',
        ruleFields: { anyNewConstruction: true, event: 'filed', notBefore: '2026-10-12T00:00:00-07:00', notBeforeAt: 1791788400 }
    },
    {
        name: 'permitted: any new-construction permit is issued',
        tuple: { milestone: 'permitted', subject: SF, deadline: '2027-12-31T23:59:59-08:00',
            evidence: { source: 'sf-dbi-permits-v1', anyNewConstruction: true, event: 'issued', notBefore: '2026-10-12T00:00:00-07:00' } },
        question: 'Will San Francisco issue a new-construction building permit for Candlestick Point by 31 December 2027?',
        settles: 'Yes if the San Francisco Department of Building Inspection permits dataset shows a new-construction building permit on Candlestick Point (2 parcels) with an issued date after 12 October 2026 and on or before 31 December 2027; no if that date passes without such a record. Anyone can settle it from the public record.',
        eventType: 'permit_issued', id: 'sf-dbi-permits-permitted-v1',
        subjectText: 'US-CA-SF|4884039A,4884040',
        yesText: 'new-construction building permit issued after 2026-10-12T00:00:00-07:00 and on or before 2027-12-31T23:59:59-08:00',
        noText: 'no matching record on or before 2027-12-31T23:59:59-08:00',
        ruleFields: { anyNewConstruction: true, event: 'issued', notBefore: '2026-10-12T00:00:00-07:00', notBeforeAt: 1791788400 }
    },
    {
        name: 'agreed: the agreement executes on-chain',
        tuple: { milestone: 'agreed', deadline: '2027-03-31T23:59:59+02:00', evidence: { source: 'agreement-v1' },
            subject: { ...ZAGREB, label: 'Borovje courtyard', agreementAccount: ACCOUNT,
                parcelIds: ['HR-335614-2313', 'HR-335614-2311', 'HR-335614-1754/1'] } },
        question: 'Will Borovje courtyard execute on-chain by 31 March 2027?',
        settles: "Yes if the agreement's account on Solana reaches Executed on or before 31 March 2027; no if the agreement is cancelled or expires first, or that date passes before it is executed. Anyone can settle it from the agreement account on Solana.",
        eventType: 'agreement_executed', id: 'agreement-agreed-v1',
        subjectText: 'HR-ZAGREB|HR-335614-1754/1,HR-335614-2311,HR-335614-2313',
        yesText: `agreement ${ACCOUNT} executed on or before 2027-03-31T23:59:59+02:00`,
        noText: `agreement ${ACCOUNT} cancelled, expired or not executed on or before 2027-03-31T23:59:59+02:00`,
        ruleFields: { agreementAccount: ACCOUNT }
    },
    {
        name: 'adopted: the plan is published in the official gazette',
        tuple: { milestone: 'adopted', deadline: '2027-06-30T23:59:59+02:00',
            subject: { ...ZAGREB, label: 'Borovje south', parcelIds: ['HR-335614-2311'] },
            evidence: { source: 'zagreb-gazette-v1', planId: 'UPU Borovje – zona jug' } },
        question: 'Will the City of Zagreb adopt UPU Borovje – zona jug by 30 June 2027?',
        settles: 'Yes if the decision adopting UPU Borovje – zona jug is published in the official gazette of the City of Zagreb on or before 30 June 2027; no if that date passes without such a record. Anyone can settle it from the public record.',
        eventType: 'plan_adopted', id: 'zagreb-gazette-adopted-v1',
        subjectText: 'HR-ZAGREB|HR-335614-2311',
        yesText: 'adoption of UPU Borovje – zona jug published in the official gazette on or before 2027-06-30T23:59:59+02:00',
        noText: 'no matching record on or before 2027-06-30T23:59:59+02:00',
        ruleFields: { planId: 'UPU Borovje – zona jug' }
    },
    {
        name: 'adopted: an ordinance or resolution makes the operation',
        tuple: { milestone: 'adopted', subject: { ...SF, label: 'Courtyard alternative' }, deadline: '2028-12-31T23:59:59-08:00',
            evidence: { source: 'sf-legislation-v1', operation: TOWERS } },
        question: `Will San Francisco adopt ${TOWERS} by 31 December 2028?`,
        settles: `Yes if a verifier named in the market confirms that San Francisco's legislation records hold an ordinance or resolution adopting ${TOWERS}, recorded on or before 31 December 2028; no if that date passes without such a record. Anyone can settle it from the public record.`,
        eventType: 'plan_adopted', id: 'sf-legislation-adopted-v1',
        subjectText: 'US-CA-SF|4884039A,4884040',
        yesText: `ordinance or resolution adopting ${TOWERS} recorded on or before 2028-12-31T23:59:59-08:00`,
        noText: 'no matching record on or before 2028-12-31T23:59:59-08:00',
        ruleFields: { operation: TOWERS }
    },
    {
        name: 'built: any new-construction permit is completed',
        tuple: { milestone: 'built', subject: SF, deadline: '2029-12-31T23:59:59-08:00',
            evidence: { source: 'sf-dbi-permits-v1', anyNewConstruction: true, event: 'completed', notBefore: '2026-10-12T00:00:00-07:00' } },
        question: 'Will a building be completed at Candlestick Point by 31 December 2029?',
        settles: 'Yes if the San Francisco Department of Building Inspection permits dataset shows a new-construction building permit on Candlestick Point (2 parcels) with a completed date after 12 October 2026 and on or before 31 December 2029; no if that date passes without such a record. Anyone can settle it from the public record.',
        eventType: 'permit_completed', id: 'sf-dbi-permits-built-v1',
        subjectText: 'US-CA-SF|4884039A,4884040',
        yesText: 'new-construction building permit completed after 2026-10-12T00:00:00-07:00 and on or before 2029-12-31T23:59:59-08:00',
        noText: 'no matching record on or before 2029-12-31T23:59:59-08:00',
        ruleFields: { anyNewConstruction: true, event: 'completed', notBefore: '2026-10-12T00:00:00-07:00', notBeforeAt: 1791788400 }
    },
    {
        name: 'built: a numbered permit is completed',
        tuple: { milestone: 'built', subject: SF, deadline: '2029-12-31T23:59:59-08:00',
            evidence: { source: 'sf-dbi-permits-v1', permitNumber: '202603026735', event: 'completed' } },
        question: 'Will the work under building permit 202603026735 at Candlestick Point be completed by 31 December 2029?',
        settles: 'Yes if the San Francisco Department of Building Inspection permits dataset shows permit 202603026735 with a completed date on or before 31 December 2029; no if that date passes without such a record. Anyone can settle it from the public record.',
        eventType: 'permit_completed', id: 'sf-dbi-permits-built-v1',
        subjectText: 'US-CA-SF|4884039A,4884040',
        yesText: 'permit 202603026735 completed on or before 2029-12-31T23:59:59-08:00',
        noText: 'no matching record on or before 2029-12-31T23:59:59-08:00',
        ruleFields: { permitNumber: '202603026735', event: 'completed' }
    }
];
const PERMIT = CASES[0].tuple;
const FILED = CASES[1].tuple;
const AGREED = CASES[3].tuple;

// recipe.schema.json has no validator in this repo (no ajv in backend/test or backend/oracle), so
// this checks the keywords that schema uses, read from the schema file itself: required keys,
// additionalProperties, patterns, types, minimums. The "can go red" test below proves it rejects.
function schemaErrors(recipe, schema = SCHEMA) {
    const errors = [];
    const props = schema.properties;
    const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    const nonEmpty = (value, min = 1) => typeof value === 'string' && value.length >= min;
    schema.required.filter(key => !(key in recipe)).forEach(key => errors.push(`missing ${key}`));
    if (schema.additionalProperties === false) {
        Object.keys(recipe).filter(key => !(key in props)).forEach(key => errors.push(`unexpected ${key}`));
    }
    ['id', 'eventType', 'hash'].forEach(key => {
        if (!nonEmpty(recipe[key]) || !new RegExp(props[key].pattern).test(recipe[key])) errors.push(`${key} pattern`);
    });
    if (!Number.isInteger(recipe.version) || recipe.version < props.version.minimum) errors.push('version');
    if (!nonEmpty(recipe.question, props.question.minLength)) errors.push('question');
    if (!isObject(recipe.subject) || Object.keys(recipe.subject).length < props.subject.minProperties) errors.push('subject');
    const attesters = recipe.trustedAttesters;
    if (!Array.isArray(attesters) || attesters.length < props.trustedAttesters.minItems) errors.push('trustedAttesters');
    else attesters.forEach((attester, index) => props.trustedAttesters.items.required
        .filter(key => !nonEmpty(attester?.[key]))
        .forEach(key => errors.push(`trustedAttesters[${index}].${key}`)));
    if (!isObject(recipe.outcomes) || Object.keys(recipe.outcomes).length < props.outcomes.minProperties
        || Object.values(recipe.outcomes).some(value => !nonEmpty(value, props.outcomes.additionalProperties.minLength))) {
        errors.push('outcomes');
    }
    const verification = recipe.verification;
    if (!isObject(verification)) return [...errors, 'verification'];
    props.verification.required.filter(key => !(key in verification)).forEach(key => errors.push(`verification.${key}`));
    if (!nonEmpty(verification.kind, props.verification.properties.kind.minLength)) errors.push('verification.kind');
    if (typeof verification.permissionless !== 'boolean') errors.push('verification.permissionless');
    const policy = verification.evidencePolicy;
    const policySchema = props.verification.properties.evidencePolicy;
    if (policy !== undefined) {
        if (!isObject(policy)) return [...errors, 'verification.evidencePolicy'];
        if (policySchema.additionalProperties === false) {
            Object.keys(policy).filter(key => !(key in policySchema.properties))
                .forEach(key => errors.push(`verification.evidencePolicy.${key}`));
        }
        if (policy.threshold !== undefined
            && (!Number.isInteger(policy.threshold) || policy.threshold < policySchema.properties.threshold.minimum)) {
            errors.push('verification.evidencePolicy.threshold');
        }
    }
    return errors;
}

// What the server adds before hashing: the attesters it trusts and the hash itself.
function served(recipeBody) {
    return { ...recipeBody, trustedAttesters: [{ kind: 'lens-member', address: 'x' }], hash: `sha256:${'0'.repeat(64)}` };
}

describe('MarketQuestion deadline is a whole civil day', () => {
    it('rejects a deadline that is not 23:59:59, because the question says "by <date>"', () => {
        const tuple = {
            milestone: 'permitted',
            subject: { jurisdiction: 'US-CA-SF', authority: 'San Francisco', label: 'Candlestick Point', parcelIds: ['5000002'] },
            deadline: '2026-12-31T12:00:00-08:00',
            evidence: { source: 'sf-dbi-permits-v1', permitNumber: '202603026735', event: 'issued' }
        };
        expect(() => MarketQuestion.build(tuple)).toThrow(/23:59:59/);
        expect(MarketQuestion.build({ ...tuple, deadline: '2026-12-31T23:59:59-08:00' }).closesAt).toBe(1798790399);
    });
});

describe('MarketQuestion.build: one tuple per rule', () => {
    it.each(CASES)('$name', item => {
        const out = MarketQuestion.build(item.tuple);
        expect(out.question).toBe(item.question);
        expect(out.settles).toBe(item.settles);
        expect(out.eventType).toBe(item.eventType);
        expect(out.subjectText).toBe(hashed(item.subjectText));
        expect(MarketQuestion.subjectTextOf(out.recipeBody)).toBe(out.subjectText);
        expect(out.yesText).toBe(item.yesText);
        expect(out.noText).toBe(item.noText);
        expect(out.absence).toBe('no');
        expect(out.recipeBody).toEqual({
            id: item.id,
            version: 1,
            question: item.question,
            eventType: item.eventType,
            subject: { jurisdiction: item.tuple.subject.jurisdiction, setHash: `sha256:${Sha256.hex(item.subjectText)}`, parcelIds: item.subjectText.split('|')[1].split(','), ...item.ruleFields },
            outcomes: { yes: item.yesText, no: item.noText },
            verification: {
                kind: item.tuple.evidence.source,
                permissionless: true,
                closesAt: Date.parse(item.tuple.deadline) / 1000,
                absence: 'no',
                evidencePolicy: { threshold: 1 }
            }
        });
    });
});

describe('MarketQuestion.build: question equals rule (K3)', () => {
    it.each(CASES)('$name: question, settlement sentence and recipe come from the same tuple', ({ tuple }) => {
        const out = MarketQuestion.build(tuple);
        const { recipeBody } = out;
        expect(recipeBody.question).toBe(out.question);
        expect(recipeBody.outcomes).toEqual({ yes: out.yesText, no: out.noText });
        expect(recipeBody.eventType).toBe(out.eventType);
        expect(recipeBody.verification.closesAt).toBe(out.closesAt);
        expect(recipeBody.verification.absence).toBe(out.absence);
        expect(`${recipeBody.subject.jurisdiction}|${recipeBody.subject.setHash}`).toBe(out.subjectText);
        expect(out.closesAt).toBe(Date.parse(tuple.deadline) / 1000);
        expect(out.question.endsWith(`by ${out.deadlineLabel}?`)).toBe(true);
        expect(out.settles).toContain(`on or before ${out.deadlineLabel}`);
        expect(out.yesText.endsWith(`on or before ${tuple.deadline}`)).toBe(true);
        expect(out.noText.endsWith(`on or before ${tuple.deadline}`)).toBe(true);
        expect(out.yesText).not.toBe(out.noText);
    });

    it.each(CASES)('$name: moving only the deadline moves the question, sentence, texts and close together', ({ tuple }) => {
        const before = MarketQuestion.build(tuple);
        const after = MarketQuestion.build({ ...tuple, deadline: '2031-03-15T23:59:59Z' });
        for (const field of ['question', 'settles', 'yesText', 'noText', 'closesAt', 'deadlineLabel']) {
            expect(after[field], field).not.toEqual(before[field]);
        }
        expect(after.deadlineLabel).toBe('15 March 2031');
        expect(after.closesAt).toBe(Date.UTC(2031, 2, 15, 23, 59, 59) / 1000);
        expect(after.question).toContain('15 March 2031');
        expect(after.settles).toContain('15 March 2031');
        expect(after.yesText.endsWith('on or before 2031-03-15T23:59:59Z')).toBe(true);
        expect(after.noText.endsWith('on or before 2031-03-15T23:59:59Z')).toBe(true);
        expect(after.recipeBody.question).toBe(after.question);
        expect(after.recipeBody.outcomes).toEqual({ yes: after.yesText, no: after.noText });
        expect(after.recipeBody.verification.closesAt).toBe(after.closesAt);
        // What the market is about does not move.
        expect(after.subjectText).toBe(before.subjectText);
        expect(after.eventType).toBe(before.eventType);
        expect(after.recipeBody.id).toBe(before.recipeBody.id);
        expect(after.recipeBody.subject).toEqual(before.recipeBody.subject);
    });
});

describe('MarketQuestion.build: the label is display only', () => {
    it.each(CASES)('$name: no rule text contains the label', ({ tuple }) => {
        const out = MarketQuestion.build(tuple);
        for (const field of ['subjectText', 'yesText', 'noText']) {
            expect(out[field], field).not.toContain(tuple.subject.label);
        }
        expect(JSON.stringify(out.recipeBody.subject)).not.toContain(tuple.subject.label);
    });

    it.each(CASES)('$name: renaming the site leaves every rule text and the rule unchanged', ({ tuple }) => {
        const before = MarketQuestion.build(tuple);
        const after = MarketQuestion.build({ ...tuple, subject: { ...tuple.subject, label: 'Somewhere else entirely' } });
        for (const field of ['subjectText', 'yesText', 'noText', 'eventType', 'closesAt', 'absence']) {
            expect(after[field], field).toBe(before[field]);
        }
        const { question: _q1, ...ruleBefore } = before.recipeBody;
        const { question: _q2, ...ruleAfter } = after.recipeBody;
        expect(ruleAfter).toEqual(ruleBefore);
    });
});

describe('MarketQuestion.build: parcels', () => {
    it('is the same market for any order of the same land, duplicates folded', () => {
        const sorted = MarketQuestion.build({ ...PERMIT, subject: { ...SF, parcelIds: ['4884039A', '4884040'] } });
        const shuffled = MarketQuestion.build({ ...PERMIT, subject: { ...SF, parcelIds: ['4884040', '4884039A', '4884040', '4884039A'] } });
        expect(shuffled).toEqual(sorted);
        expect(shuffled.subjectText).toBe(hashed('US-CA-SF|4884039A,4884040'));
        expect(shuffled.subjectText.length).toBeLessThan(90);
        expect(shuffled.recipeBody.subject.parcelIds).toEqual(['4884039A', '4884040']);
    });

    it('counts distinct parcels in the settlement sentence, singular for one', () => {
        const three = MarketQuestion.build({ ...FILED, subject: { ...SF, parcelIds: ['A1', 'B2', 'C3', 'A1'] } });
        expect(three.settles).toContain('a new-construction building permit on Candlestick Point (3 parcels) with a filed date');
        const one = MarketQuestion.build({ ...FILED, subject: { ...SF, parcelIds: ['A1'] } });
        expect(one.settles).toContain('a new-construction building permit on Candlestick Point (1 parcel) with a filed date');
    });

    it('does not touch the tuple it was given and gives the same answer every time', () => {
        const tuple = structuredClone(PERMIT);
        const copy = structuredClone(tuple);
        const first = MarketQuestion.build(tuple);
        expect(MarketQuestion.build(tuple)).toEqual(first);
        expect(tuple).toEqual(copy);
    });
});

describe('MarketQuestion.build: deadline', () => {
    it('closes at the instant written and labels the date written, without converting zones', () => {
        const out = MarketQuestion.build(PERMIT);
        // 2027-01-01T07:59:59Z. (1767254399 is the same moment a year earlier, 2025-12-31T23:59:59-08:00.)
        expect(out.closesAt).toBe(1798790399);
        expect(out.deadlineLabel).toBe('31 December 2026');
        // The end of New Year's Day in Zagreb is 21:59:59 UTC that day; the label is the day written.
        const early = MarketQuestion.build({ ...PERMIT, deadline: '2027-01-01T23:59:59+02:00' });
        expect(early.deadlineLabel).toBe('1 January 2027');
        expect(early.closesAt).toBe(Date.UTC(2027, 0, 1, 21, 59, 59) / 1000);
        expect(MarketQuestion.build({ ...PERMIT, deadline: '2027-06-01T23:59:59Z' }).deadlineLabel).toBe('1 June 2027');
    });
});

describe('MarketQuestion.build: invalid tuples throw', () => {
    const withSubject = patch => ({ ...PERMIT, subject: { ...SF, ...patch } });
    const withEvidence = evidence => ({ ...PERMIT, evidence });
    it.each([
        ['no tuple', null, /tuple/],
        ['an unknown milestone', { ...PERMIT, milestone: 'approved' }, /milestone must be one of agreed, adopted, permitted, built/],
        ['an unknown source', withEvidence({ source: 'sf-dbi-permits-v2', permitNumber: '1', event: 'issued' }), /unknown evidence source/],
        ['a gazette for a built market', { ...PERMIT, milestone: 'built', subject: { ...SF, ...ZAGREB }, evidence: { source: 'zagreb-gazette-v1', planId: 'UPU' } }, /does not settle built markets/],
        ['permits for an agreed market', { ...PERMIT, milestone: 'agreed' }, /does not settle agreed markets/],
        ['the agreement account for a permitted market', withEvidence({ source: 'agreement-v1' }), /does not settle permitted markets/],
        ['legislation for a permitted market', withEvidence({ source: 'sf-legislation-v1', operation: TOWERS }), /does not settle permitted markets/],
        ['a completed date for a permitted market', withEvidence({ source: 'sf-dbi-permits-v1', anyNewConstruction: true, event: 'completed' }), /filed or issued/],
        ['an issued date for a built market', { ...PERMIT, milestone: 'built' }, /completed/],
        ['a filed date for a numbered permit', withEvidence({ source: 'sf-dbi-permits-v1', permitNumber: '202603026735', event: 'filed' }), /must be issued/],
        ['both a permit number and any permit', withEvidence({ source: 'sf-dbi-permits-v1', permitNumber: '1', anyNewConstruction: true, event: 'issued' }), /exactly one/],
        ['neither a permit number nor any permit', withEvidence({ source: 'sf-dbi-permits-v1', event: 'issued' }), /exactly one/],
        ['anyNewConstruction other than true', withEvidence({ source: 'sf-dbi-permits-v1', anyNewConstruction: 'yes', event: 'filed' }), /anyNewConstruction must be true/],
        ['a permit number with a letter', withEvidence({ source: 'sf-dbi-permits-v1', permitNumber: '20260302673A', event: 'issued' }), /string of digits/],
        ['a permit number with a dash', withEvidence({ source: 'sf-dbi-permits-v1', permitNumber: '2026-0302', event: 'issued' }), /string of digits/],
        ['a permit number as a number', withEvidence({ source: 'sf-dbi-permits-v1', permitNumber: 202603026735, event: 'issued' }), /string of digits/],
        ['an empty plan id', { ...CASES[4].tuple, evidence: { source: 'zagreb-gazette-v1', planId: '  ' } }, /planId/],
        ['an empty operation', { ...CASES[5].tuple, evidence: { source: 'sf-legislation-v1' } }, /operation/],
        ['a San Francisco source for Zagreb land', withSubject(ZAGREB), /covers US-CA-SF, not HR-ZAGREB/],
        ['an agreed market without its agreement account', { ...AGREED, subject: { ...AGREED.subject, agreementAccount: undefined } }, /agreementAccount/],
        ['an agreed market whose account is not base58', { ...AGREED, subject: { ...AGREED.subject, agreementAccount: 'agreement-0OIl' } }, /agreementAccount/],
        ['missing parcel ids', withSubject({ parcelIds: undefined }), /parcelIds/],
        ['no parcel ids', withSubject({ parcelIds: [] }), /parcelIds/],
        ['a parcel id with a comma', withSubject({ parcelIds: ['4884039A,4884040'] }), /parcel id/],
        ['a parcel id that is not a string', withSubject({ parcelIds: [4884040] }), /parcel id/],
        ['a lower-case jurisdiction', withSubject({ jurisdiction: 'us-ca-sf' }), /jurisdiction/],
        ['no label', withSubject({ label: '' }), /label/],
        ['no authority', withSubject({ authority: undefined }), /authority/],
        ['a deadline without an offset', { ...PERMIT, deadline: '2026-12-31T23:59:59' }, /deadline must be/],
        ['a deadline that is only a date', { ...PERMIT, deadline: '2026-12-31' }, /deadline must be/],
        ['a deadline that is a number', { ...PERMIT, deadline: 1798790399 }, /deadline must be/],
        ['a deadline on 30 February', { ...PERMIT, deadline: '2027-02-30T23:59:59Z' }, /not a real instant/],
        ['a deadline at hour 24', { ...PERMIT, deadline: '2026-12-31T24:00:00Z' }, /not a real instant/],
        ['a deadline with an impossible offset', { ...PERMIT, deadline: '2026-12-31T23:59:59+25:00' }, /not a real instant/]
    ])('rejects %s', (_name, tuple, message) => {
        expect(() => MarketQuestion.build(tuple)).toThrow(message);
    });
});

describe('MarketQuestion.build: templates', () => {
    const MONTHS_HR = ['siječnja', 'veljače', 'ožujka', 'travnja', 'svibnja', 'lipnja', 'srpnja', 'kolovoza', 'rujna',
        'listopada', 'studenoga', 'prosinca'];

    it('applies an override to the shown text and never to the rule or the recipe', () => {
        const english = MarketQuestion.build(PERMIT);
        const out = MarketQuestion.build(PERMIT, {
            locale: 'hr',
            templates: {
                'question.permitted.permitIssued': 'Hoće li {{authority}} izdati građevinsku dozvolu {{permitNumber}} za {{label}} do {{deadline}}?',
                'settledBy.record': 'Svatko ga može riješiti iz javnog zapisa.',
                date: '{{day}}. {{month}} {{year}}',
                months: MONTHS_HR
            }
        });
        expect(out.question).toBe('Hoće li San Francisco izdati građevinsku dozvolu 202603026735 za Candlestick Point do 31. prosinca 2026?');
        expect(out.deadlineLabel).toBe('31. prosinca 2026');
        expect(out.settles).toContain('on or before 31. prosinca 2026;');
        expect(out.settles.endsWith(' Svatko ga može riješiti iz javnog zapisa.')).toBe(true);
        // The on-chain side is the same whatever language the page speaks.
        expect(out.recipeBody).toEqual(english.recipeBody);
        expect(out.recipeBody.question).toBe(english.question);
        for (const field of ['subjectText', 'yesText', 'noText', 'closesAt', 'eventType', 'absence']) {
            expect(out[field], field).toEqual(english[field]);
        }
    });

    it('picks the plural form of the parcel count by locale', () => {
        const templates = {
            'question.agreed.agreement': 'Hoće li se sporazum vlasnika {{parcels}} ({{label}}) izvršiti na lancu do {{deadline}}?',
            'parcels.one': '{{count}} čestice',
            'parcels.few': '{{count}} čestice',
            'parcels.other': '{{count}} čestica'
        };
        const ids = count => Array.from({ length: count }, (_, index) => `P${index + 1}`);
        const at = count => MarketQuestion.build({ ...AGREED, subject: { ...AGREED.subject, parcelIds: ids(count) } }, { templates, locale: 'hr' });
        expect(at(3).question).toBe('Hoće li se sporazum vlasnika 3 čestice (Borovje courtyard) izvršiti na lancu do 31 March 2027?');
        expect(at(5).question).toContain('5 čestica');
        // English has no 'few': the same three parcels fall back to 'other'.
        const english = MarketQuestion.build({ ...AGREED, subject: { ...AGREED.subject, parcelIds: ids(3) } }, { templates });
        expect(english.question).toContain('3 čestica');
    });

    it.each([
        ['an unknown key', { 'question.agreed': 'Will they sign?' }, /unknown template key question.agreed/],
        ['a month list that is not twelve names', { months: ['January'] }, /twelve month names/],
        ['an empty template', { 'question.permitted.permitIssued': ' ' }, /non-empty string/],
        ['a template that is not a string', { 'settledBy.record': 7 }, /non-empty string/],
        ['a placeholder this market does not have', { 'question.permitted.permitIssued': 'Will {{planId}} pass by {{deadline}}?' }, /uses \{\{planId\}\}/],
        ['templates that are not an object', 'Will it?', /options.templates must be an object/]
    ])('rejects %s', (_name, templates, message) => {
        expect(() => MarketQuestion.build(PERMIT, { templates })).toThrow(message);
    });
});

describe('MarketQuestion.agreementQuestion and contestQuestion: the Bets sheet\'s undated questions', () => {
    it('asks whether one agreement executes, and which of a contest\'s agreements does', () => {
        expect(MarketQuestion.agreementQuestion('Borovje courtyard')).toBe('Will Borovje courtyard execute on-chain?');
        expect(MarketQuestion.agreementQuestion('  Courtyard + Tower ')).toBe('Will Courtyard + Tower execute on-chain?');
        expect(MarketQuestion.contestQuestion('Parcel 2311 and 2 more')).toBe('Which agreement over Parcel 2311 and 2 more will execute?');
    });

    it('applies a page\'s template override, as build does', () => {
        const templates = {
            'question.agreement': 'Hoće li se {{title}} izvršiti na lancu?',
            'question.contest': 'Koji će se sporazum o {{place}} izvršiti?'
        };
        expect(MarketQuestion.agreementQuestion('Dvorište', { templates })).toBe('Hoće li se Dvorište izvršiti na lancu?');
        expect(MarketQuestion.contestQuestion('čestici 2311', { templates })).toBe('Koji će se sporazum o čestici 2311 izvršiti?');
    });

    it.each([
        ['an empty title', () => MarketQuestion.agreementQuestion('  '), /title must be a non-empty string/],
        ['no title', () => MarketQuestion.agreementQuestion(null), /title must be a non-empty string/],
        ['no place', () => MarketQuestion.contestQuestion(''), /place must be a non-empty string/],
        ['a placeholder the question does not have', () => MarketQuestion.agreementQuestion('X', { templates: { 'question.agreement': 'Will {{label}} execute?' } }), /uses \{\{label\}\}/],
        ['a template for designs, which are never bet on', () => MarketQuestion.contestQuestion('X', { templates: { 'question.design': 'Which design?' } }), /unknown template key question.design/]
    ])('rejects %s', (_name, call, message) => {
        expect(call).toThrow(message);
    });
});

describe('MarketQuestion.build: recipe schema', () => {
    it.each(CASES)('$name: the recipe body validates once the server adds attesters and hash', ({ tuple }) => {
        const { recipeBody } = MarketQuestion.build(tuple);
        expect(schemaErrors(served(recipeBody))).toEqual([]);
        // Without the two server fields it is not yet a recipe.
        expect(schemaErrors(recipeBody)).toEqual(['missing trustedAttesters', 'missing hash', 'hash pattern', 'trustedAttesters']);
    });

    it('the structural check can go red', () => {
        const good = served(MarketQuestion.build(PERMIT).recipeBody);
        expect(schemaErrors({ ...good, id: 'Not An Id' })).toEqual(['id pattern']);
        expect(schemaErrors({ ...good, eventType: 'permit-issued' })).toEqual(['eventType pattern']);
        expect(schemaErrors({ ...good, extra: true })).toEqual(['unexpected extra']);
        expect(schemaErrors({ ...good, version: 0 })).toEqual(['version']);
        expect(schemaErrors({ ...good, outcomes: { yes: '' } })).toEqual(['outcomes']);
        expect(schemaErrors({ ...good, verification: { ...good.verification, evidencePolicy: { threshold: 0, quorum: 2 } } }))
            .toEqual(['verification.evidencePolicy.quorum', 'verification.evidencePolicy.threshold']);
    });
});

describe('MarketQuestion exports', () => {
    it('lists the four milestones in ladder order, each with a description', () => {
        expect(MarketQuestion.MILESTONES.map(item => item.id)).toEqual(['agreed', 'adopted', 'permitted', 'built']);
        for (const item of MarketQuestion.MILESTONES) expect(item.description).toMatch(/^[A-Z].+\.$/);
    });

    it('lists the sources with the milestones each may settle', () => {
        expect(Object.fromEntries(MarketQuestion.SOURCES.map(item => [item.id, item.milestones]))).toEqual({
            'agreement-v1': ['agreed'],
            'sf-legislation-v1': ['adopted'],
            'zagreb-gazette-v1': ['adopted'],
            'sf-dbi-permits-v1': ['permitted', 'built']
        });
    });

    it('cannot have its English defaults changed by a page, since the recipe is built from them', () => {
        expect(Object.isFrozen(MarketQuestion.TEMPLATES)).toBe(true);
        expect(Object.isFrozen(MarketQuestion.TEMPLATES.months)).toBe(true);
    });
});

// E2's banned words must not reach a bettor through this module's sentences (they live under Verify).
describe('MarketQuestion bettor vocabulary', () => {
    const BANNED = ['lens', 'attester', 'recipe', 'lifecycle', 'minted', 'applied', 'conditional', 'epoch', 'resolver', 'pool account'];
    const banned = text => BANNED.filter(term => new RegExp(`\\b${term}`, 'i').test(text));

    it('keeps the banned words out of every default template and every built sentence', () => {
        const shown = Object.values(MarketQuestion.TEMPLATES).flat();
        for (const { tuple } of CASES) {
            const out = MarketQuestion.build(tuple);
            shown.push(out.question, out.settles);
        }
        expect(shown.flatMap(banned)).toEqual([]);
        expect(banned('a lens member attests it')).toEqual(['lens']);
    });
});
