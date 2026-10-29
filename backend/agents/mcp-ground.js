// Derive agreement ground on a fresh, isolated fabric using the app's arrangement and hash modules.
// Only complete cadastral ground is admitted; open or ambiguous ground must be reviewed in the app.
import { agreementObject, cidOfObject, communityRule, defaultAllocations, ownersRule, personPositions } from './agreement-objects.js';
import { previewArtifact } from './mcp-preview.js';
import { deriveWithApp } from './mcp-ground-runtime.js';
import { parcelSourceIdOf } from './mcp-read-tools.js';
import { describeRoadCuts, roadCutWarning } from './mcp-ground-effects.js';
import { cityMoney } from '../scripts/lib/frontend-city-money.mjs';
const fail = (code, message) => Object.assign(new Error(message), { code, next: { action: 'Review these designs and their ground in the app before proposing an agreement.' } });
export const deriveAgreementGround = deriveWithApp;

export function createMcpAgreementTools({ read, drafts, appOrigin }) {
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
        async draftAgreement({ plan: value, rulePreset = 'owner-vote', rule: ruleOverride, rights, lens, allocations, settlement, valuation = null, currency = null, deadline = null, sponsor = null, title = null, author = null, createdAt = null, consultation = null, includeGround = false }) {
            if (!resolvePlan) throw fail('plan-resolver-unavailable', 'Named plan resolution is unavailable.');
            const selected = await resolvePlan(value);
            const resolved = await resolveDesigns(selected.designs, selected.designs[0]?.parcelSourceId);
            createdAt ||= new Date().toISOString();
            const { designs } = resolved;
            const groundEffects = describeRoadCuts(designs);
            const { city } = resolved;
            currency ??= cityMoney(city).currentCurrency();
            const effectiveRights = rights ?? ruleOverride?.approvalConfig?.rights;
            const presetRule = ruleOverride ? null : rulePreset === 'community-vote' ? communityRule()
                : rulePreset === 'owner-vote' ? { ...communityRule(), electorate: 'owners', approvalConfig: effectiveRights ? { schema: 'proposal-approval/v1', rights: effectiveRights, policy: { type: 'unanimous' } } : null, lens: [] }
                    : ownersRule({ lens, rights: effectiveRights });
            const rule = ruleOverride ? structuredClone(ruleOverride) : presetRule;
            // Ownership rights live only in the rule: the parties stay one per input parcel.
            if (rights && rule.electorate === 'owners') rule.approvalConfig = { ...(rule.approvalConfig || { schema: 'proposal-approval/v1', policy: { type: 'unanimous' } }), rights };
            if (rule.electorate !== 'community' && !rule.settlement) rule.settlement = { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 };
            if (settlement) rule.settlement = settlement;
            if (rule.electorate === 'community') rule.settlement = null;
            const { land, source, ids } = await groundFor({ ...resolved, designs });
            const plan = { cid: selected.cid, content: selected.plan };
            // Each input parcel is its owners' abstract party; the rights snapshot stays in the rule.
            const parcels = land.inputs.parcels.map(parcel => ({ ...parcel, parcelSourceId: source.parcelSourceId }));
            const finalAllocations = allocations ?? (rule.electorate === 'owners' ? defaultAllocations({ ...land.inputs, parcels }, land.outputs) : []);
            const published = agreementObject({ title, author, sponsor, city, createdAt, plan,
                designs: designs.map(d => ({ cid: d.cid, goal: d.content.goal, title: d.content.title })),
                parcels, openGroundM2: land.inputs.openGroundM2, outputs: land.outputs, allocations: finalAllocations,
                money: { currency, lines: [] }, valuation: rule.electorate === 'community' ? null : valuation, rule, deadline, consultation });
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
