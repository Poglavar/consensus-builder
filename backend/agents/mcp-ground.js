// Derive agreement ground on a fresh, isolated fabric using the app's arrangement and hash modules.
// Only complete cadastral ground is admitted; open or ambiguous ground must be reviewed in the app.
import { agreementObject, cidOfObject, communityRule, defaultAllocations, ownersRule, personPositions } from './agreement-objects.js';
import { previewArtifact } from './mcp-preview.js';
import { deriveWithApp } from './mcp-ground-runtime.js';
import { parcelSourceIdOf } from './mcp-read-tools.js';
import { describeRoadCuts, roadCutWarning } from './mcp-ground-effects.js';
import { cityMoney } from '../scripts/lib/frontend-city-money.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const BallotRules = require('../../frontend/js/community/ballot-rules.js');
const Eligibility = require('../../frontend/js/planning/eligibility.js');
const BuildingFacts = require('../../frontend/js/buildings/building-facts.js');
const fail = (code, message) => Object.assign(new Error(message), { code, next: { action: 'Review these designs and their ground in the app before proposing an agreement.' } });
export const deriveAgreementGround = deriveWithApp;

// A street vote whose ballot rule covers only eligible buildings (Living Tradition's mansards) is
// drafted only when every house the plan raises passes the rule set, judged from the shared API's
// building facts exactly as the app's agreement editor judges it; the check goes into the record.
export async function votingWithEligibility(consultation, designContents, { readFacts }) {
    const voting = consultation?.voting;
    const rule = voting?.rule ? BallotRules.get(voting.rule.id, voting.rule.version) : null;
    const required = rule?.requires?.eligibility;
    if (!required) return consultation;
    const set = Eligibility.get(required.id, required.version);
    const houses = Eligibility.coveredHouses(set, designContents);
    if (!houses.length) throw Object.assign(new Error('The plan raises no existing building with a mansard, so this street vote has nothing to cover.'), { code: 'eligibility-no-houses' });
    const judged = await Eligibility.check(set, houses, readFacts);
    const blocked = judged.filter(house => !house.id || house.result.verdict !== 'eligible');
    if (blocked.length) {
        const why = house => {
            const cites = status => house.result.tests.filter(test => test.status === status).map(test => test.cite).join(', ');
            return `${house.id || `building ${house.sourceBuildingId} (no facts source)`}: ${house.id ? house.result.verdict : 'unknown'}`
                + (cites('fail') ? `, fails ${cites('fail')}` : '') + (cites('unknown') ? `, unknown ${cites('unknown')}` : '');
        };
        throw Object.assign(new Error(`Not every covered house is eligible yet (${blocked.map(why).join('; ')}). Add the missing facts in OpenStreetMap and draft again; a heritage listing (17.9) comes from the country's heritage register, not OpenStreetMap.`),
            { code: 'eligibility-failed', next: { action: 'Read each house with the building facts (edit links per building) and fill the missing ones in OpenStreetMap; for an unknown heritage listing, unknown_reasons.heritage says why (adding addr:street and addr:housenumber can let a terrace entry match by house number).' } });
    }
    return { ...consultation, voting: { ...voting, eligibility: Eligibility.evidence(set, judged, new Date().toISOString()) } };
}

export function createMcpAgreementTools({ read, drafts, appOrigin, readFacts = ids => BuildingFacts.readMany(ids, { base: process.env.BUILDING_FACTS_API || BuildingFacts.API_ROOT, fresh: true }) }) {
    let resolvePlan;
    const setPlanResolver = resolver => { resolvePlan = resolver; };
    async function resolveDesigns(values, parcelSourceId) {
        const designs = [];
        let city;
        for (const value of values) {
            const resolved = await drafts.resolveDesignSource(value), content = resolved.content, cid = cidOfObject(content);
            if (parcelSourceId && resolved.parcelSourceId && parcelSourceId !== resolved.parcelSourceId) throw fail('agreement-source-mismatch', 'The linked designs must use the same parcel source.');
            parcelSourceId ||= resolved.parcelSourceId;
            if (designs.some(d => d.cid === cid)) throw fail('duplicate-design', 'An agreement links each design once.');
            city ??= content.city;
            if (!city || content.city !== city) throw fail('agreement-city-mismatch', 'Every design must be in the same configured city.');
            designs.push({ cid, content });
        }
        return { designs, city, parcelSourceId };
    }
    async function groundFor(resolved) {
        const { designs, city } = resolved;
        let { parcelSourceId } = resolved;
        const ids = new Set();
        const bound = [];
        for (const { cid, content } of designs) {
            const answer = await read.request('/designs/binding', {}, { site: read.siteOfDesign(content), city, toleranceM: content.toleranceM, parcelSourceId });
            parcelSourceId = parcelSourceIdOf(answer) || parcelSourceId;
            if (answer.binding?.coverage !== 'complete' || answer.binding.unsurveyedM2 > 0 || answer.binding.unknownM2 > 0) throw fail('ground-incomplete', 'Headless agreement drafting requires complete cadastral coverage.');
            const parcelIds = answer.binding.parcels.map(p => p.parcelId);
            parcelIds.forEach(id => ids.add(id)); bound.push({ cid, content, parcelIds });
        }
        if (!ids.size || ids.size > 200) throw fail('agreement-scope', 'An agreement draft needs 1–200 cadastral input parcels.');
        const source = await read.parcels({ city, parcelSourceId, parcelIds: [...ids] });
        const land = await deriveAgreementGround({ designs: bound, parcels: source.features });
        return { land, source, ids };
    }
    const tools = {
        // Inspection replays the exact committed designs. It must not invoke an authoring step.
        async inspectGround({ designs, parcelSourceId }) {
            const result = await groundFor(await resolveDesigns(designs, parcelSourceId));
            return result.land;
        },
        async draftAgreement({ plan: value, rulePreset = 'owner-vote', rule: ruleOverride, rights, lenses = [], lensThreshold = null, allocations, settlement, valuation = null, affected = null, neighbourCompensation, currency = null, deadline = null, sponsor = null, title = null, author = null, createdAt = null, consultation = null, includeGround = false, targetUsdcAtomic = null, contract = null, apartments = null }) {
            if (!resolvePlan) throw fail('plan-resolver-unavailable', 'Named plan resolution is unavailable.');
            // Funding refers to the published member CIDs. Only newly carried designs need authoring checks.
            const selected = await resolvePlan(value, { referenceMembers: rulePreset === 'crowdfunding' });
            if (rulePreset === 'crowdfunding') {
                if (ruleOverride || rights || allocations || settlement || valuation != null || consultation != null || affected != null || neighbourCompensation != null) {
                    throw fail('crowdfunding-terms-invalid', 'Crowdfunding has one fixed investor rule and no land, allocation, settlement, valuation, affected neighbour or consultation terms.');
                }
                if (typeof deadline !== 'string' || !Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) % 1000 !== 0) {
                    throw fail('crowdfunding-deadline-invalid', 'Supply a funding deadline on a whole second.');
                }
                const designs = selected.designs || [];
                const city = selected.plan.view?.city || designs[0]?.content?.city || null;
                if (!city) throw fail('agreement-city-missing', 'The selected plan needs a city in its saved view or member designs.');
                // The program checks the funding target itself; lens members (0-8) attest investor eligibility
                // and any other condition, `lensThreshold` of them (absent: any one).
                const rule = { electorate: 'investors', binding: true, lens: lenses, ...(lensThreshold == null ? {} : { lensThreshold }), approvalConfig: null, settlement: null };
                const published = agreementObject({ title, author, sponsor, city, createdAt: createdAt || new Date().toISOString(), plan: { cid: selected.cid, content: selected.plan },
                    designs: designs.map(d => ({ cid: d.cid, goal: d.content?.goal, title: d.content?.title })), parcels: [], openGroundM2: 0, outputs: [], allocations: [],
                    money: { currency: currency || cityMoney(city).currentCurrency(), lines: [] }, valuation: null, rule, deadline, funding: { targetUsdcAtomic, contract, ...(apartments ? { apartments } : {}) }, requireSponsor: false });
                const plan = { cid: selected.cid, content: selected.plan };
                return { agreement: published.content, cid: published.cid, parcelSourceId: null, takes: [], groundEffects: [], persons: null,
                    warnings: ['This crowdfunding agreement references the existing named plan and has no land effects.'], plan, designs,
                    ...await previewArtifact({ origin: appOrigin, agreement: published.content, plan, designs: designs.map(row => row.content), parcelSourceId: null }) };
            }
            const resolved = await resolveDesigns(selected.designs, selected.designs[0]?.parcelSourceId);
            createdAt ||= new Date().toISOString();
            const { designs } = resolved;
            const groundEffects = describeRoadCuts(designs);
            const { city } = resolved;
            currency ??= cityMoney(city).currentCurrency();
            const effectiveRights = rights ?? ruleOverride?.approvalConfig?.rights;
            const presetRule = ruleOverride ? null : rulePreset === 'community-vote' ? communityRule()
                : rulePreset === 'owner-vote' ? { ...communityRule(), electorate: 'owners', approvalConfig: effectiveRights ? { schema: 'proposal-approval/v1', rights: effectiveRights, policy: { type: 'unanimous' } } : null, lens: [] }
                    : ownersRule({ lenses, lensThreshold, rights: effectiveRights });
            const rule = ruleOverride ? structuredClone(ruleOverride) : presetRule;
            // Ownership rights live only in the rule: the parties stay one per input parcel.
            if (rights && rule.electorate === 'owners') rule.approvalConfig = { ...(rule.approvalConfig || { schema: 'proposal-approval/v1', policy: { type: 'unanimous' } }), rights };
            if (rule.electorate !== 'community' && !rule.settlement) rule.settlement = { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 };
            if (settlement) rule.settlement = settlement;
            // The multiple of a neighbour's stated loss: given here, or in the rule; null removes it (1×).
            if (neighbourCompensation === null) delete rule.neighbourCompensation;
            else if (neighbourCompensation) rule.neighbourCompensation = neighbourCompensation;
            if (rule.electorate === 'community') rule.settlement = null;
            if (rule.electorate === 'community') consultation = await votingWithEligibility(consultation, designs.map(d => d.content), { readFacts });
            const { land, source, ids } = await groundFor({ ...resolved, designs });
            const plan = { cid: selected.cid, content: selected.plan };
            // Each input parcel is its owners' abstract party; the rights snapshot stays in the rule.
            const parcels = land.inputs.parcels.map(parcel => ({ ...parcel, parcelSourceId: source.parcelSourceId }));
            const finalAllocations = allocations ?? (rule.electorate === 'owners' ? defaultAllocations({ ...land.inputs, parcels }, land.outputs) : []);
            const published = agreementObject({ title, author, sponsor, city, createdAt, plan,
                designs: designs.map(d => ({ cid: d.cid, goal: d.content.goal, title: d.content.title })),
                parcels, openGroundM2: land.inputs.openGroundM2, outputs: land.outputs, allocations: finalAllocations,
                money: { currency, lines: [] }, valuation: rule.electorate === 'community' ? null : valuation, affected, rule, deadline, consultation });
            const ruleRights = published.content.rule.approvalConfig?.rights;
            return { agreement: published.content, cid: published.cid, parcelSourceId: source.parcelSourceId, takes: [...ids], groundEffects,
                persons: ruleRights ? personPositions(published.content, ruleRights) : null, ...(includeGround ? { ground: land } : {}), warnings: ['This agreement references the existing named plan. Review its derived ground and terms before publishing.',
                ...(roadCutWarning(groundEffects) ? [roadCutWarning(groundEffects)] : []),
                ...(!effectiveRights && rule.electorate !== 'community' ? ['No rights snapshot was supplied, so no owner decision can be counted and no person positions can be derived from the parcel parties.'] : [])],
                ...await previewArtifact({ origin: appOrigin, agreement: published.content, plan, designs: designs.map(d => d.content), parcelSourceId: source.parcelSourceId }),
                plan, designs: designs.map(d => ({ cid: d.cid, content: d.content })) };
        }
    };
    tools.setPlanResolver = setPlanResolver;
    return tools;
}
