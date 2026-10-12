// Market question builder: turns one market tuple (milestone, parcels, deadline, evidence) into the
// question people bet on, the sentence saying how it settles, and the recipe body whose hash goes
// on-chain, all from the same data so the three cannot drift apart. Pure: no DOM, no network.
//
// build(tuple, { templates, locale }) returns { question, settles, absence, closesAt, deadlineLabel,
// eventType, subjectText, yesText, noText, recipeBody } and throws on an invalid tuple.
//
// Display templates. English defaults are TEMPLATES; options.templates overrides any of them so the
// i18n layer can supply hr/es/sr. Placeholders are {{name}}, as in frontend/i18n.
//   question.<rule>    the question, ending in '?'
//   settles.<rule>     the yes/no sentence of how it settles
//   settledBy.chain    closing sentence when the chain settles it (agreed)
//   settledBy.record   closing sentence when a public record settles it
//   parcels.<plural>   the parcel count phrase: 'one' and 'other' in English; any CLDR category
//                      ('few', ...) is picked with options.locale (default 'en')
//   date               the deadline label, from {{day}} {{month}} {{year}}
//   months             the twelve month names, an array
// <rule>: agreed.proposal, adopted.operation, adopted.plan, permitted.permitIssued,
//   permitted.anyFiled, permitted.anyIssued, built.permitCompleted, built.anyCompleted.
// Placeholders: authority, label, deadline (the label), parcels, count, permitNumber, planId, operation.
//
// Only display text is templated. subjectText, yesText and noText are fixed English rule texts whose
// sha256 hashes are on-chain commitments, and they never contain the display label. recipeBody is
// always rendered from the English defaults, so a translated page hashes the same recipe as an
// English one; with the defaults, recipeBody.question === question.
//
// The subject is the jurisdiction and the canonical hash of the sorted parcel ids
// ('US-CA-SF|sha256:…'), never the ids themselves: an attestation carries the subject text and a
// site of a hundred parcels would not fit one. The ids stay in recipeBody.subject.parcelIds, so
// anyone can recompute the hash. Needs sha256.js loaded first in the browser.
(function attachMarketQuestion(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MarketQuestion = api;
})(typeof window !== 'undefined' ? window : globalThis, function marketQuestionFactory(root) {
    'use strict';

    const sha256Hex = root && root.Sha256 ? root.Sha256.hex : require('./sha256.js').hex;

    // The ladder of public decisions a site climbs, in order.
    const MILESTONES = Object.freeze([
        { id: 'agreed', description: 'Every owner of the parcels signs the proposal.' },
        { id: 'adopted', description: 'The city adopts the plan or plan amendment for the parcels.' },
        { id: 'permitted', description: 'A building permit for the parcels is filed or issued.' },
        { id: 'built', description: 'A building on the parcels is completed.' }
    ].map(Object.freeze));

    // Evidence sources and the rungs each may settle. A source kept by one city settles only markets
    // in that jurisdiction; null means any.
    const SOURCES = Object.freeze([
        { id: 'proposal-nft-v3', milestones: ['agreed'], jurisdiction: null,
            description: 'The proposal account on Solana: Executed, Cancelled or Expired.' },
        { id: 'sf-legislation-v1', milestones: ['adopted'], jurisdiction: 'US-CA-SF',
            description: "San Francisco's legislation records: ordinances and resolutions." },
        { id: 'zagreb-gazette-v1', milestones: ['adopted'], jurisdiction: 'HR-ZAGREB',
            description: 'The official gazette of the City of Zagreb.' },
        { id: 'sf-dbi-permits-v1', milestones: ['permitted', 'built'], jurisdiction: 'US-CA-SF',
            description: 'The San Francisco Department of Building Inspection permits dataset.' }
    ].map(source => Object.freeze({ ...source, milestones: Object.freeze(source.milestones) })));

    const TEMPLATES = Object.freeze({
        'question.agreed.proposal': 'Will all owners of the {{parcels}} of {{label}} sign by {{deadline}}?',
        'question.adopted.operation': 'Will {{authority}} adopt {{operation}} by {{deadline}}?',
        'question.adopted.plan': 'Will {{authority}} adopt {{planId}} by {{deadline}}?',
        'question.permitted.permitIssued': 'Will {{authority}} issue building permit {{permitNumber}} for {{label}} by {{deadline}}?',
        'question.permitted.anyFiled': 'Will a new-construction building permit be filed for {{label}} by {{deadline}}?',
        'question.permitted.anyIssued': 'Will {{authority}} issue a new-construction building permit for {{label}} by {{deadline}}?',
        'question.built.permitCompleted': 'Will the work under building permit {{permitNumber}} at {{label}} be completed by {{deadline}}?',
        'question.built.anyCompleted': 'Will a building be completed at {{label}} by {{deadline}}?',
        'settles.agreed.proposal': "Yes if the proposal's account on Solana reaches Executed on or before {{deadline}}; no if the proposal is cancelled or expires first, or that date passes before it is executed.",
        'settles.adopted.operation': "Yes if a verifier named in the market confirms that San Francisco's legislation records hold an ordinance or resolution adopting {{operation}}, recorded on or before {{deadline}}; no if that date passes without such a record.",
        'settles.adopted.plan': 'Yes if the decision adopting {{planId}} is published in the official gazette of the City of Zagreb on or before {{deadline}}; no if that date passes without such a record.',
        'settles.permitted.permitIssued': 'Yes if the San Francisco Department of Building Inspection permits dataset shows permit {{permitNumber}} with an issued date on or before {{deadline}}; no if that date passes without such a record.',
        'settles.permitted.anyFiled': 'Yes if the San Francisco Department of Building Inspection permits dataset shows a new-construction building permit on {{label}} ({{parcels}}) with a filed date after {{since}} and on or before {{deadline}}; no if that date passes without such a record.',
        'settles.permitted.anyIssued': 'Yes if the San Francisco Department of Building Inspection permits dataset shows a new-construction building permit on {{label}} ({{parcels}}) with an issued date after {{since}} and on or before {{deadline}}; no if that date passes without such a record.',
        'settles.built.permitCompleted': 'Yes if the San Francisco Department of Building Inspection permits dataset shows permit {{permitNumber}} with a completed date on or before {{deadline}}; no if that date passes without such a record.',
        'settles.built.anyCompleted': 'Yes if the San Francisco Department of Building Inspection permits dataset shows a new-construction building permit on {{label}} ({{parcels}}) with a completed date after {{since}} and on or before {{deadline}}; no if that date passes without such a record.',
        'settledBy.chain': 'Anyone can settle it from the proposal account on Solana.',
        'settledBy.record': 'Anyone can settle it from the public record.',
        'parcels.one': '{{count}} parcel',
        'parcels.other': '{{count}} parcels',
        date: '{{day}} {{month}} {{year}}',
        months: Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
            'September', 'October', 'November', 'December'])
    });

    // One entry per rule: the event the record must show, the canonical yes text (before its deadline
    // clause), the no text where the record itself can say no, and what absence at the deadline means.
    // These texts are hashed on-chain: changing one changes every market built from it.
    const RULES = {
        'agreed.proposal': { eventType: 'proposal_executed', absence: 'no',
            yes: fields => `proposal ${fields.proposalAccount} executed`,
            no: fields => `proposal ${fields.proposalAccount} cancelled, expired or not executed` },
        'adopted.operation': { eventType: 'plan_adopted', absence: 'no',
            yes: fields => `ordinance or resolution adopting ${fields.operation} recorded` },
        'adopted.plan': { eventType: 'plan_adopted', absence: 'no',
            yes: fields => `adoption of ${fields.planId} published in the official gazette` },
        'permitted.permitIssued': { eventType: 'permit_issued', absence: 'no',
            yes: fields => `permit ${fields.permitNumber} issued` },
        'permitted.anyFiled': { eventType: 'permit_filed', absence: 'no',
            yes: fields => `new-construction building permit filed after ${fields.notBefore} and` },
        'permitted.anyIssued': { eventType: 'permit_issued', absence: 'no',
            yes: fields => `new-construction building permit issued after ${fields.notBefore} and` },
        'built.permitCompleted': { eventType: 'permit_completed', absence: 'no',
            yes: fields => `permit ${fields.permitNumber} completed` },
        'built.anyCompleted': { eventType: 'permit_completed', absence: 'no',
            yes: fields => `new-construction building permit completed after ${fields.notBefore} and` }
    };

    const JURISDICTION = /^[A-Z]{2}(?:-[A-Z0-9]+)*$/;
    const PARCEL_ID = /^[^\s,|]+$/; // ',' and '|' join the subject text, so they cannot be inside an id
    const SOLANA_ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const DEADLINE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/;
    const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];

    function text(value, name) {
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (!trimmed) throw new Error(`${name} must be a non-empty string`);
        return trimmed;
    }

    function readSubject(subject) {
        if (!subject || typeof subject !== 'object') throw new Error('subject must be an object');
        if (typeof subject.jurisdiction !== 'string' || !JURISDICTION.test(subject.jurisdiction)) {
            throw new Error('subject.jurisdiction must be an id such as US-CA-SF');
        }
        if (!Array.isArray(subject.parcelIds) || !subject.parcelIds.length) {
            throw new Error('subject.parcelIds must be a non-empty array');
        }
        subject.parcelIds.forEach(id => {
            if (typeof id !== 'string' || !PARCEL_ID.test(id)) {
                throw new Error(`parcel id ${JSON.stringify(id)} must be a string without spaces, commas or pipes`);
            }
        });
        return {
            jurisdiction: subject.jurisdiction,
            authority: text(subject.authority, 'subject.authority'),
            label: text(subject.label, 'subject.label'),
            // Deduplicated and sorted by code unit, so any order of the same land is the same market.
            parcelIds: [...new Set(subject.parcelIds)].sort(),
            proposalAccount: subject.proposalAccount
        };
    }

    // An instant exactly as written, its unix seconds, and the civil date of the string itself:
    // '2026-12-31T23:59:59-08:00' is 31 December wherever it is read. A deadline must be 23:59:59.
    function readInstant(value, name, { endOfDay = false } = {}) {
        const match = typeof value === 'string' ? DEADLINE.exec(value) : null;
        if (!match) {
            throw new Error(`${name} must be an ISO 8601 instant with seconds and an offset, e.g. 2026-12-31T23:59:59-08:00`);
        }
        const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
        const offsetMinutes = match[7] === 'Z' ? 0
            : (match[8] === '-' ? -1 : 1) * (Number(match[9]) * 60 + Number(match[10]));
        const civil = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
        const closesAt = civil.getTime() / 1000 - offsetMinutes * 60;
        // Date.UTC rolls 30 February into March (and years below 100 into the 1900s); a round trip
        // that does not come back to the same fields was not a real date.
        const real = civil.getUTCFullYear() === year && civil.getUTCMonth() === month - 1
            && civil.getUTCDate() === day && civil.getUTCHours() === hour
            && civil.getUTCMinutes() === minute && civil.getUTCSeconds() === second
            && Number(match[10] || 0) < 60 && Math.abs(offsetMinutes) <= 14 * 60;
        if (!real || closesAt <= 0) throw new Error(`${name} ${value} is not a real instant`);
        // The question says "by <date>", so the market closes with that civil day, not inside it.
        if (endOfDay && (hour !== 23 || minute !== 59 || second !== 59)) {
            throw new Error(`${name} ${value} must be the end of its civil day, 23:59:59`);
        }
        return { iso: value, closesAt, year, month, day };
    }

    function readDeadline(value) {
        return readInstant(value, 'deadline', { endOfDay: true });
    }

    // The canonical identity of the land: sha256 over the jurisdiction and the sorted parcel ids.
    function parcelSetHash(jurisdiction, parcelIds) {
        const ids = [...new Set(parcelIds)].sort();
        return `sha256:${sha256Hex(`${jurisdiction}|${ids.join(',')}`)}`;
    }

    // The subject text a recipe body commits to, rebuilt from the body alone.
    function subjectTextOf(recipeBody) {
        const subject = recipeBody && recipeBody.subject;
        if (!subject || typeof subject.jurisdiction !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(String(subject.setHash))) {
            throw new Error('recipeBody.subject needs jurisdiction and setHash');
        }
        return `${subject.jurisdiction}|${subject.setHash}`;
    }

    // A permit rule names one permit (permitNumber) or any new-construction permit on the parcels,
    // and the date the record must show: filed or issued for permitted, completed for built.
    function readPermit(milestone, evidence) {
        const numbered = evidence.permitNumber !== undefined;
        if (numbered === (evidence.anyNewConstruction !== undefined)) {
            throw new Error('permit evidence needs exactly one of permitNumber or anyNewConstruction: true');
        }
        if (numbered && !(typeof evidence.permitNumber === 'string' && /^\d+$/.test(evidence.permitNumber))) {
            throw new Error('evidence.permitNumber must be a string of digits');
        }
        if (!numbered && evidence.anyNewConstruction !== true) throw new Error('evidence.anyNewConstruction must be true');
        // A numbered permit is already filed, so only its issue (or completion) is a question.
        const events = milestone === 'built' ? ['completed'] : numbered ? ['issued'] : ['filed', 'issued'];
        const event = evidence.event;
        if (!events.includes(event)) throw new Error(`evidence.event must be ${events.join(' or ')} for this ${milestone} market`);
        const rule = `${milestone}.${numbered ? 'permit' : 'any'}${event[0].toUpperCase()}${event.slice(1)}`;
        if (numbered) return { rule, fields: { permitNumber: evidence.permitNumber, event } };
        // "Any permit" means a new one: a record dated before the market was conceived does not count.
        const since = readInstant(evidence.notBefore, 'evidence.notBefore');
        return { rule, since, fields: { anyNewConstruction: true, event, notBefore: since.iso, notBeforeAt: since.closesAt } };
    }

    // The rule a milestone and its evidence select, and the evidence fields that rule depends on.
    function readEvidence(milestone, evidence, subject) {
        if (!evidence || typeof evidence !== 'object') throw new Error('evidence must be an object');
        const source = SOURCES.find(item => item.id === evidence.source);
        if (!source) {
            throw new Error(`unknown evidence source ${evidence.source}; known: ${SOURCES.map(item => item.id).join(', ')}`);
        }
        if (!source.milestones.includes(milestone)) throw new Error(`${source.id} does not settle ${milestone} markets`);
        if (source.jurisdiction && source.jurisdiction !== subject.jurisdiction) {
            throw new Error(`${source.id} covers ${source.jurisdiction}, not ${subject.jurisdiction}`);
        }
        if (source.id === 'proposal-nft-v3') {
            // The rule reads this account's status, so an agreed market without it cannot settle.
            if (typeof subject.proposalAccount !== 'string' || !SOLANA_ACCOUNT.test(subject.proposalAccount)) {
                throw new Error('an agreed market needs subject.proposalAccount, the proposal account on Solana');
            }
            return { source, rule: 'agreed.proposal', fields: { proposalAccount: subject.proposalAccount } };
        }
        if (source.id === 'sf-legislation-v1') {
            return { source, rule: 'adopted.operation', fields: { operation: text(evidence.operation, 'evidence.operation') } };
        }
        if (source.id === 'zagreb-gazette-v1') {
            return { source, rule: 'adopted.plan', fields: { planId: text(evidence.planId, 'evidence.planId') } };
        }
        return { source, ...readPermit(milestone, evidence) };
    }

    function readTemplates(overrides) {
        if (overrides === undefined || overrides === null) return TEMPLATES;
        if (typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('options.templates must be an object');
        Object.keys(overrides).forEach(key => {
            const known = Object.prototype.hasOwnProperty.call(TEMPLATES, key)
                || PLURAL_CATEGORIES.some(category => key === `parcels.${category}`);
            if (!known) throw new Error(`unknown template key ${key}`);
            const value = overrides[key];
            if (key === 'months') {
                if (!Array.isArray(value) || value.length !== 12 || !value.every(name => typeof name === 'string' && name.trim())) {
                    throw new Error('template months must be twelve month names');
                }
            } else if (typeof value !== 'string' || !value.trim()) {
                throw new Error(`template ${key} must be a non-empty string`);
            }
        });
        return { ...TEMPLATES, ...overrides };
    }

    // Replaces {{name}}. A placeholder this market has no value for is a broken template: it throws
    // rather than printing '{{name}}' to a bettor.
    function fill(template, vars, key) {
        return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => {
            if (!Object.prototype.hasOwnProperty.call(vars, name) || vars[name] === undefined) {
                throw new Error(`template ${key} uses {{${name}}}, which this market does not have`);
            }
            return String(vars[name]);
        });
    }

    function render(market, templates, locale) {
        const { deadline, rule, fields } = market;
        const count = market.parcelIds.length;
        const plural = `parcels.${new Intl.PluralRules(locale).select(count)}`;
        const parcelsKey = templates[plural] === undefined ? 'parcels.other' : plural;
        const deadlineLabel = fill(templates.date,
            { day: deadline.day, month: templates.months[deadline.month - 1], year: deadline.year }, 'date');
        const vars = {
            authority: market.authority,
            label: market.label,
            deadline: deadlineLabel,
            since: market.since ? fill(templates.date,
                { day: market.since.day, month: templates.months[market.since.month - 1], year: market.since.year }, 'date') : undefined,
            count,
            parcels: fill(templates[parcelsKey], { count }, parcelsKey),
            permitNumber: fields.permitNumber,
            planId: fields.planId,
            operation: fields.operation
        };
        const settledBy = rule === 'agreed.proposal' ? 'settledBy.chain' : 'settledBy.record';
        return {
            deadlineLabel,
            question: fill(templates[`question.${rule}`], vars, `question.${rule}`),
            settles: `${fill(templates[`settles.${rule}`], vars, `settles.${rule}`)} ${fill(templates[settledBy], vars, settledBy)}`
        };
    }

    function build(tuple, options = {}) {
        if (!tuple || typeof tuple !== 'object') throw new Error('market tuple must be an object');
        if (!MILESTONES.some(item => item.id === tuple.milestone)) {
            throw new Error(`milestone must be one of ${MILESTONES.map(item => item.id).join(', ')}`);
        }
        const { templates, locale = 'en' } = options || {};
        const subject = readSubject(tuple.subject);
        const deadline = readDeadline(tuple.deadline);
        const market = { ...subject, deadline, ...readEvidence(tuple.milestone, tuple.evidence, subject) };
        if (market.since && market.since.closesAt >= deadline.closesAt) throw new Error('evidence.notBefore must come before the deadline');
        const rule = RULES[market.rule];
        const shown = render(market, readTemplates(templates), locale);
        const english = render(market, TEMPLATES, 'en');
        const setHash = parcelSetHash(subject.jurisdiction, subject.parcelIds);
        const subjectText = `${subject.jurisdiction}|${setHash}`;
        const yesText = `${rule.yes(market.fields)} on or before ${deadline.iso}`;
        const noText = `${rule.no ? rule.no(market.fields) : 'no matching record'} on or before ${deadline.iso}`;
        return {
            question: shown.question,
            settles: shown.settles,
            absence: rule.absence,
            closesAt: deadline.closesAt,
            deadlineLabel: shown.deadlineLabel,
            eventType: rule.eventType,
            subjectText,
            yesText,
            noText,
            // The server adds trustedAttesters and hash, then hashes this body for the market.
            recipeBody: {
                id: `${market.source.id.replace(/-v\d+$/, '')}-${tuple.milestone}-v1`,
                version: 1,
                question: english.question,
                eventType: rule.eventType,
                subject: { jurisdiction: subject.jurisdiction, setHash, parcelIds: subject.parcelIds.slice(), ...market.fields },
                outcomes: { yes: yesText, no: noText },
                verification: {
                    kind: market.source.id,
                    permissionless: true,
                    closesAt: deadline.closesAt,
                    absence: rule.absence,
                    evidencePolicy: { threshold: 1 }
                }
            }
        };
    }

    return { MILESTONES, SOURCES, TEMPLATES, build, parcelSetHash, subjectTextOf };
});
