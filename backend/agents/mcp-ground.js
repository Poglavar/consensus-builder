// Derive agreement ground on a fresh, isolated fabric using the app's arrangement and hash modules.
// Only complete cadastral ground is admitted; open or ambiguous ground must be reviewed in the app.
import { agreementObject, cidOfObject, communityRule, holdersFromRights, noMoney, ownersRule } from './agreement-objects.js';
import { createRequire } from 'node:module';
import { cityMoney } from '../utils/city-money.js';
import { deriveWithApp } from './mcp-ground-runtime.js';
const fail = (code, message) => Object.assign(new Error(message), { code, next: { action: 'Review these designs and their ground in the app before proposing an agreement.' } });
const require = createRequire(import.meta.url);
const draftLink = require('../../frontend/js/draft-link.js');
export const deriveAgreementGround = deriveWithApp;

export function createMcpAgreementTools({ read, drafts, appOrigin }) {
    return {
        async draftAgreement({ designs: values, rulePreset = 'community-vote', rights, lens, allocations = [], money, deadline = null, sponsor = null, title = null, author = null, createdAt = null, parcelSourceId }) {
            const designs = [];
            const ids = new Set();
            let city;
            for (const value of values) {
                const content = await drafts.resolveDesign(value), cid = cidOfObject(content);
                if (designs.some(d => d.cid === cid)) throw fail('duplicate-design', 'An agreement links each design once.');
                city ??= content.city;
                if (!city || content.city !== city) throw fail('agreement-city-mismatch', 'Every design must be in the same configured city.');
                const answer = await read.request('/designs/binding', {}, { site: read.siteOfDesign(content), city, toleranceM: content.toleranceM, parcelSourceId });
                if (answer.binding?.coverage !== 'complete' || answer.binding.unsurveyedM2 > 0 || answer.binding.unknownM2 > 0) throw fail('ground-incomplete', 'Headless agreement drafting requires complete cadastral coverage.');
                const parcelIds = answer.binding.parcels.map(p => p.parcelId);
                parcelIds.forEach(id => ids.add(id)); designs.push({ cid, content, parcelIds });
            }
            if (!ids.size || ids.size > 100) throw fail('agreement-scope', 'An agreement draft needs 1–100 cadastral input parcels.');
            const source = await read.parcels({ city, parcelSourceId, parcelIds: [...ids] });
            const ownerOf = id => rights?.parcels?.some(p => p.parcelId === id) ? holdersFromRights(rights, id) : [];
            if (rulePreset !== 'community-vote' && !rights) throw fail('rights-required', 'Owner agreements need a complete rights snapshot.');
            const rule = rulePreset === 'owner-deal' ? ownersRule({ lens, rights })
                : rulePreset === 'owner-vote' ? { ...communityRule(), electorate: 'owners', approvalConfig: { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } } }
                    : communityRule();
            const land = await deriveAgreementGround({ designs, parcels: source.features, ownerOf });
            const published = agreementObject({ title, author, sponsor, city, createdAt,
                designs: designs.map(d => ({ cid: d.cid, goal: d.content.goal, title: d.content.title })),
                parcels: land.inputs.parcels, openGroundM2: land.inputs.openGroundM2, outputs: land.outputs, allocations,
                money: money || noMoney(cityMoney(city).currentCurrency()), rule, deadline });
            return { agreement: published.content, cid: published.cid, takes: [...ids], warnings: ['Draft ground is isolated from other local designs. Review the preview before publishing.'],
                previewUrl: await draftLink.build({ origin: appOrigin, agreement: published.content, designs: designs.map(d => d.content), parcelSourceId: source.parcelSourceId }), designs: designs.map(d => ({ cid: d.cid, content: d.content })) };
        }
    };
}
