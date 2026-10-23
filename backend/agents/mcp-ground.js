// Derive agreement ground on a fresh, isolated fabric using the app's arrangement and hash modules.
// Only complete cadastral ground is admitted; open or ambiguous ground must be reviewed in the app.
import { agreementObject, cidOfObject, communityRule, holdersFromRights, noMoney, ownersRule } from './agreement-objects.js';
import { previewArtifact } from './mcp-preview.js';
import { deriveWithApp } from './mcp-ground-runtime.js';
import { parcelSourceIdOf } from './mcp-read-tools.js';
import { authorPlanRoads } from './mcp-road-network.js';
const fail = (code, message) => Object.assign(new Error(message), { code, next: { action: 'Review these designs and their ground in the app before proposing an agreement.' } });
export const deriveAgreementGround = deriveWithApp;

export function createMcpAgreementTools({ read, drafts, appOrigin }) {
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
    async function groundFor(resolved, rights) {
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
        const ownerOf = id => rights?.parcels?.some(p => p.parcelId === id) ? holdersFromRights(rights, id) : [];
        const land = await deriveAgreementGround({ designs: bound, parcels: source.features, ownerOf });
        return { land, source, ids };
    }
    return {
        // Inspection replays the exact committed designs. It must not invoke an authoring step.
        async inspectGround({ designs, parcelSourceId }) {
            const result = await groundFor(await resolveDesigns(designs, parcelSourceId));
            return result.land;
        },
        async draftAgreement({ designs: values, rulePreset = 'community-vote', rights, lens, allocations = [], money, currency, deadline = null, sponsor = null, title = null, author = null, createdAt = null, parcelSourceId, includeGround = false }) {
            const resolved = await resolveDesigns(values, parcelSourceId);
            createdAt ||= new Date().toISOString();
            const { designs, changes: roadChanges } = authorPlanRoads(resolved.designs, createdAt);
            const { city } = resolved;
            if (rulePreset !== 'community-vote' && !rights) throw fail('rights-required', 'Owner agreements need a complete rights snapshot.');
            const rule = rulePreset === 'owner-deal' ? ownersRule({ lens, rights })
                : rulePreset === 'owner-vote' ? { ...communityRule(), electorate: 'owners', approvalConfig: { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } } }
                    : communityRule();
            const { land, source, ids } = await groundFor({ ...resolved, designs }, rights);
            const published = agreementObject({ title, author, sponsor, city, createdAt,
                designs: designs.map(d => ({ cid: d.cid, goal: d.content.goal, title: d.content.title })),
                parcels: land.inputs.parcels.map(parcel => ({ ...parcel, parcelSourceId: source.parcelSourceId })), openGroundM2: land.inputs.openGroundM2, outputs: land.outputs, allocations,
                money: money || noMoney(currency), rule, deadline });
            return { agreement: published.content, cid: published.cid, parcelSourceId: source.parcelSourceId, takes: [...ids], roadChanges, ...(includeGround ? { ground: land } : {}), warnings: ['Draft ground is isolated from other local designs. Review the preview before publishing.',
                ...(roadChanges.length ? ['Road junctions and their land boundaries were authored together. Use the returned revised designs and CIDs when publishing this agreement.'] : [])],
                ...await previewArtifact({ origin: appOrigin, agreement: published.content, designs: designs.map(d => d.content), parcelSourceId: source.parcelSourceId }), designs: designs.map(d => ({ cid: d.cid, content: d.content })) };
        }
    };
}
