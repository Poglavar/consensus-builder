// Inspect the exact named plan behind an agreement and revise its terms without changing membership.
import { appTurf as turf } from './mcp-geometry.js';
import { abstractHolder, agreementObject, cidOfObject, holdersFromRights, isCid } from './agreement-objects.js';
import { previewArtifact } from './mcp-preview.js';
import { trustedMetadata } from './mcp-results.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const AgreementRecord = require('../../frontend/js/agreement-record.js');

const fail = (code, message, next = { action: 'Inspect the current plan, choose explicit object references and retry.' }) => {
    throw Object.assign(new Error(message), { code, next });
};
const shape = geometry => turf.feature(geometry);
const designRef = cid => `design:${cid}`;

export function createMcpPlanTools({ read, drafts, agreements, appOrigin, resolveDraftReference }) {
    async function resolvePlan(value) {
        let artifact = value, claimedCid = value?.cid;
        const reference = typeof value === 'string' ? value : value?.draftRef;
        if (reference) {
            let cid = isCid(reference) ? reference : null;
            if (!cid) {
                let url;
                try { url = new URL(reference); } catch { fail('plan-reference-invalid', 'Use an agreement CID, its published link, or a private draftRef.'); }
                if (url.origin === new URL(appOrigin).origin && /^\/agreements\/baf(?:krei|ybei)[a-z2-7]{52}\/?$/.test(url.pathname)) cid = url.pathname.split('/')[2];
            }
            if (cid) artifact = await read.getAgreement({ agreementCid: cid });
            else {
                if (!resolveDraftReference) fail('draft-reference-unavailable', 'This client needs canonical agreement content and its carried designs.');
                artifact = await resolveDraftReference(reference);
            }
        }
        const content = artifact?.untrusted?.agreement || artifact?.agreement || artifact?.content || artifact;
        if (content?.schema !== 'agreement/v1') fail('agreement-plan-required', 'Choose an agreement plan. For one design use ugt_modify_design; assemble a collection with ugt_draft_agreement.');
        let plan = artifact.plan;
        if (!plan && content.planCid) plan = await read.request(`/plans/${content.planCid}`);
        if (plan?.schema === 'plan/v1') plan = { cid: cidOfObject(plan), content: plan };
        if (plan?.content == null && plan?.plan) plan = { cid: plan.cid, content: plan.plan };
        if (!plan || plan.cid !== (content.planCid || plan.cid)) fail('plan-reference-invalid', 'The agreement needs its verified plan record.');
        const memberCids = plan.content?.designCids;
        if (!Array.isArray(memberCids)) fail('plan-reference-invalid', 'The referenced plan has no design membership.');
        const checked = agreementObject({ ...content, plan,
            designs: memberCids.map(cid => ({ cid })), parcels: content.inputs?.parcels, openGroundM2: content.inputs?.openGroundM2 });
        const cid = cidOfObject(content);
        if (checked.cid !== cid || (claimedCid && claimedCid !== cid) || (artifact.cid && artifact.cid !== cid)) fail('cid-mismatch', 'The agreement content does not match its claimed canonical revision.');
        const sourceIds = [...new Set(content.inputs.parcels.map(p => p.parcelSourceId).filter(Boolean))];
        if (sourceIds.length > 1) fail('agreement-source-mismatch', 'Plan editing needs one parcel source.');
        const parcelSourceId = artifact.parcelSourceId || sourceIds[0];
        const carried = new Map((artifact.designs || []).map(row => {
            const design = row.untrusted?.content || row.content || row;
            const actualCid = cidOfObject(design);
            if (row.cid && row.cid !== actualCid) fail('cid-mismatch', 'A carried design differs from its CID.');
            return [actualCid, design];
        }));
        const designs = [];
        for (const cid of memberCids) {
            const linked = { cid };
            const resolved = await drafts.resolveDesignSource(carried.get(linked.cid) || linked.cid);
            if (cidOfObject(resolved.content) !== linked.cid) fail('cid-mismatch', 'A linked design differs from the plan commitment.');
            if (parcelSourceId && resolved.parcelSourceId && parcelSourceId !== resolved.parcelSourceId) fail('agreement-source-mismatch', 'A design uses a different parcel source from this plan.');
            designs.push({ cid: linked.cid, content: resolved.content });
        }
        const localAgreement = { ...content, id: `mcp-${cid}`, updatedAt: null, plan,
            outputs: content.outputs.map(output => ({ ...output, pieceId: output.hash, holders: [], geometry: null })),
            designs: designs.map(row => ({ proposalId: row.cid, cid: row.cid, title: row.content.title, goal: row.content.goal })) };
        return { agreement: localAgreement, plan, cid, parcelSourceId, designs };
    }

    function inventory(plan) {
        const items = [];
        function add(item, geometry) {
            const f = shape(geometry);
            items.push({ ...item, bbox: turf.bbox(f), center: turf.centroid(f).geometry.coordinates, areaM2: turf.area(f), geometry });
        }
        for (const { cid, content } of plan.designs) {
            const ref = designRef(cid);
            add({ ref, kind: 'design', designCid: cid, path: '', goal: content.goal, title: content.title,
                buildingCount: content.geometry?.buildings?.length || 0,
                treeCount: content.structureProposal?.kind === 'park' ? content.structureProposal.decorationDesign?.trees?.length ?? null : null }, read.siteOfDesign(content));
            (content.geometry?.buildings || []).forEach((building, index) => add({
                ref: `building:${cid}:${index}`, kind: 'building', designCid: cid, designRef: ref, buildingIndex: index, path: `/geometry/buildings/${index}`,
                title: building.properties?.name || content.title, goal: content.goal,
                floors: building.properties?.floors ?? null, heightM: building.properties?.height ?? null,
                use: building.properties?.use ?? null, coupledMassing: Boolean(content.geometry.ruleMassing)
            }, building.geometry));
        }
        for (const piece of plan.ground?.outputs || []) if (piece.geometry) add({ ref: `piece:${piece.hash}`, kind: 'piece', role: piece.role,
            producedBy: piece.producedBy, fromParcelIds: piece.fromParcelIds }, piece.geometry);
        return items;
    }

    async function inspectPlan({ plan: value, filter = {}, includeGeometry = false, offset = 0, limit = 100 }) {
        const plan = await resolvePlan(value);
        if (!['design','building'].includes(filter.kind) || filter.relativeTo?.ref.startsWith('piece:')) {
            // Published outputs commit hashes, not another copy of geometry. Recover exact pieces
            // from the shared formation host and require that they still match the commitment.
            const ground = await agreements.inspectGround({ designs: plan.designs, parcelSourceId: plan.parcelSourceId });
            if (ground.outputs.length !== plan.agreement.outputs.length || ground.outputs.some(p => !plan.agreement.outputs.some(old => old.hash === p.hash))) fail('plan-ground-changed', 'Current source ground no longer matches this plan. Review a newly derived revision before selecting its land pieces.');
            plan.ground = ground;
        }
        const all = inventory(plan);
        let anchor;
        if (filter.relativeTo) {
            anchor = all.find(item => item.ref === filter.relativeTo.ref);
            if (!anchor) fail('selection-not-found', 'The spatial reference does not belong to this plan revision.');
        }
        const matched = all.filter(item => {
            if (filter.kind && item.kind !== filter.kind) return false;
            if (filter.goal && item.goal !== filter.goal) return false;
            if (filter.role && item.role !== filter.role) return false;
            if (filter.text && !String(item.title || '').toLowerCase().includes(filter.text.toLowerCase())) return false;
            if (filter.withinBbox) {
                const b = filter.withinBbox;
                if (item.bbox[0] < b[0] || item.bbox[1] < b[1] || item.bbox[2] > b[2] || item.bbox[3] > b[3]) return false;
            }
            if (anchor) {
                const a = anchor.bbox, b = item.bbox;
                return ({ north: b[1] > a[3], south: b[3] < a[1], east: b[0] > a[2], west: b[2] < a[0] })[filter.relativeTo.direction] === true;
            }
            return true;
        });
        const recipients = new Map(plan.agreement.allocations.map(row => [row.output, row.to]));
        const ledger = AgreementRecord.ledger(plan.agreement);
        return { cid: plan.cid, parcelSourceId: plan.parcelSourceId, title: plan.agreement.title,
            items: matched.slice(offset, offset + limit).map(({ geometry, ...item }) => {
                const value = item.kind === 'piece' ? { ...item, recipient: recipients.get(item.ref.slice(6)) || null } : item;
                return includeGeometry ? { ...value, geometry } : value;
            }),
            parties: ledger.parties, publicM2: ledger.publicM2, proposerM2: ledger.proposerM2, settlement: plan.agreement.rule.settlement,
            valuation: plan.agreement.valuation ?? null, valued: ledger.valued, contributedValueCents: ledger.contributedValueCents,
            distributableValueCents: ledger.distributableValueCents, publicValueCents: ledger.publicValueCents, proposerValueCents: ledger.proposerValueCents,
            scheme: schemeReport(plan.agreement),
            cashSchedule: ledger.money,
            total: matched.length, offset, truncated: offset + limit < matched.length,
            selectionBasis: 'References belong to this immutable plan CID. Compass selection requires the whole object bbox beyond the reference bbox; crossing objects are excluded.',
            next: trustedMetadata({ tool: 'ugt_edit_agreement', action: 'Use expectedCid and explicit terms; revise membership in the named plan first.' }) };
    }

    // The distribution rules of the scheme the agreement's rule names, checked against its land
    // (AgreementRecord.schemeCheck); null for custom and unanimous rules.
    function schemeReport(agreement) {
        const result = AgreementRecord.schemeCheck(agreement);
        if (!result) return null;
        return { id: result.template.id, version: result.template.version, name: result.template.text.name, ok: result.check.ok, rules: result.check.rules };
    }

    async function editAgreement({ plan: value, expectedCid, operations = [], terms = {} }) {
        if (operations.length) fail('agreement-terms-only', 'Agreement revisions edit terms only. Revise the named plan with ugt_edit_plan, then draft a new agreement.');
        const original = await resolvePlan(value);
        if (expectedCid !== original.cid) fail('plan-revision-mismatch', 'Inspect the exact agreement revision before editing its terms.');
        const previous = original.agreement;
        if (terms.plan) {
            const rule = terms.rule ? structuredClone(terms.rule) : structuredClone(previous.rule);
            const rights = terms.rights ?? rule.approvalConfig?.rights ?? previous.rule.approvalConfig?.rights;
            if (terms.rights && rule.approvalConfig) rule.approvalConfig.rights = terms.rights;
            const revised = await agreements.draftAgreement({ plan: terms.plan, rulePreset: terms.rulePreset || 'owner-vote', rule,
                rights, currency: previous.money.currency,
                lens: previous.rule.lens?.[0], allocations: terms.allocations,
                settlement: terms.settlement ?? previous.rule.settlement, valuation: terms.valuation ?? null,
                title: terms.title ?? previous.title, author: terms.author ?? previous.author,
                sponsor: terms.sponsor ?? previous.sponsor, deadline: terms.deadline ?? previous.deadline,
                consultation: rule.electorate === 'community' ? terms.consultation ?? previous.consultation : null });
            return { ...revised, previousCid: original.cid, warnings: ['This private revision uses the explicitly selected existing named plan. The original agreement and its decisions retain their identity.'] };
        }
        const rule = terms.rule ? structuredClone(terms.rule) : structuredClone(previous.rule);
        if (terms.settlement) rule.settlement = terms.settlement;
        if (terms.rulePreset) {
            rule.electorate = 'owners'; rule.binding = terms.rulePreset === 'owner-deal';
            if (terms.rights) rule.approvalConfig = { schema: 'proposal-approval/v1', rights: terms.rights, policy: { type: 'unanimous' } };
        }
        const rights = terms.rights ?? rule.approvalConfig?.rights;
        if (terms.rights && rule.approvalConfig) rule.approvalConfig.rights = terms.rights;
        const parcels = previous.inputs.parcels.map(parcel => ({ ...parcel, holders: rights?.parcels?.some(row => row.parcelId === parcel.parcelId)
            ? holdersFromRights(rights, parcel.parcelId) : rights ? [abstractHolder(parcel.parcelId)] : parcel.holders }));
        const outputs = previous.outputs.map(output => ({ ...output, geometry: null }));
        const checked = agreementObject({ ...previous, plan: original.plan, designs: original.designs.map(row => ({ cid: row.cid, title: row.content.title, goal: row.content.goal })),
            parcels, openGroundM2: previous.inputs.openGroundM2, outputs,
            allocations: terms.allocations ?? previous.allocations, money: previous.money, rule,
            valuation: Object.hasOwn(terms, 'valuation') ? terms.valuation : previous.valuation ?? null,
            ...Object.fromEntries(['title', 'author', 'sponsor', 'deadline', 'consultation'].filter(key => Object.hasOwn(terms, key)).map(key => [key, terms[key]])),
            consultation: rule.electorate === 'community' ? terms.consultation ?? previous.consultation : null, createdAt: new Date().toISOString() });
        return { agreement: checked.content, cid: checked.cid, previousCid: original.cid, plan: original.plan,
            designs: original.designs, warnings: ['This private revision keeps the same named plan. The original agreement and its decisions retain their identity.'],
            ...await previewArtifact({ origin: appOrigin, agreement: checked.content, plan: original.plan, designs: original.designs.map(row => row.content), parcelSourceId: original.parcelSourceId }) };
    }
    return { inspectPlan, editAgreement };
}
