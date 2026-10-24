// A plan here is an agreement's ordered design composition. Edits create private revisions;
// canonical records and published commitments are immutable, and all land is derived again.
import { appTurf as turf } from './mcp-geometry.js';
import { agreementObject, cidOfObject, designObject, holdersFromRights, isCid } from './agreement-objects.js';
import { previewArtifact } from './mcp-preview.js';
import { roadCutWarning } from './mcp-ground-effects.js';

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
        const checked = agreementObject({ ...content, parcels: content.inputs?.parcels, openGroundM2: content.inputs?.openGroundM2 });
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
        for (const linked of content.designs) {
            const resolved = await drafts.resolveDesignSource(carried.get(linked.cid) || linked.cid);
            if (cidOfObject(resolved.content) !== linked.cid) fail('cid-mismatch', 'A linked design differs from the plan commitment.');
            if (parcelSourceId && resolved.parcelSourceId && parcelSourceId !== resolved.parcelSourceId) fail('agreement-source-mismatch', 'A design uses a different parcel source from this plan.');
            designs.push({ cid: linked.cid, content: resolved.content });
        }
        return { agreement: content, cid, parcelSourceId, designs };
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
                use: building.properties?.use ?? null, coupledMassing: Boolean(content.geometry.blockMassing)
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
        return { cid: plan.cid, parcelSourceId: plan.parcelSourceId, title: plan.agreement.title,
            items: matched.slice(offset, offset + limit).map(({ geometry, ...item }) => includeGeometry ? { ...item, geometry } : item),
            total: matched.length, offset, truncated: offset + limit < matched.length,
            selectionBasis: 'References belong to this immutable plan CID. Compass selection requires the whole object bbox beyond the reference bbox; crossing objects are excluded.',
            next: { tool: 'ugt_edit_plan', action: 'Use expectedCid and explicit refs. Ask the person when their description matches more than one object.' } };
    }

    async function editPlan({ plan: value, expectedCid, operations = [], terms = {} }) {
        const original = await resolvePlan(value);
        if (expectedCid !== original.cid) fail('plan-revision-mismatch', 'The expected plan CID does not match. Inspect the intended revision before editing.');
        if (!operations.length && !Object.keys(terms).length) fail('empty-edit', 'Supply plan operations or edited terms.');
        const all = inventory(original), byRef = new Map(all.map(item => [item.ref, item]));
        const working = new Map(original.designs.map(row => [row.cid, structuredClone(row.content)]));
        const indices = new Map(original.designs.map(row => [row.cid, (row.content.geometry?.buildings || []).map((_, i) => i)]));
        const changes = [];
        const selected = ref => {
            if (ref.startsWith('piece:')) fail('piece-operation-invalid', 'Land pieces are derived. Edit their source layout/design, or draft on their geometry and add/remove/replace designs.');
            const item = byRef.get(ref); if (!item) fail('selection-not-found', `Reference ${ref} is not in this plan revision.`); return item;
        };
        const current = item => { const content = working.get(item.designCid); if (!content) fail('conflicting-edits', 'A selected design was already removed or replaced in this edit.'); return content; };
        const add = async input => {
            const resolved = await drafts.resolveDesignSource(input);
            if (resolved.parcelSourceId && original.parcelSourceId && resolved.parcelSourceId !== original.parcelSourceId) fail('agreement-source-mismatch', 'Use the same parcel source for the added design.');
            const cid = cidOfObject(resolved.content);
            if ([...working.values()].some(d => cidOfObject(d) === cid)) fail('duplicate-design', 'This design is already in the revised plan.');
            working.set(cid, resolved.content); return cid;
        };
        for (const operation of operations) {
            if (operation.type === 'add') {
                const cid = await add(operation.design); changes.push({ type: 'add', afterCid: cid }); continue;
            }
            const item = selected(operation.ref);
            if (item.kind === 'piece') fail('piece-operation-invalid', 'Land pieces are derived. Edit their source layout/design or draft a replacement on their geometry, then add/remove/replace designs.');
            const content = current(item);
            if (operation.type === 'replace') {
                if (item.kind !== 'design') fail('design-selection-required', 'Replacement selects a whole design.');
                const resolved = await drafts.resolveDesignSource(operation.design), cid = cidOfObject(resolved.content);
                if (resolved.parcelSourceId && original.parcelSourceId && resolved.parcelSourceId !== original.parcelSourceId) fail('agreement-source-mismatch', 'Use the same parcel source.');
                if ([...working.entries()].some(([key, d]) => key !== item.designCid && cidOfObject(d) === cid)) fail('duplicate-design', 'This design is already in the plan.');
                working.set(item.designCid, resolved.content);
                indices.set(item.designCid, null);
                changes.push({ type: 'replace', beforeCid: item.designCid, afterCid: cid }); continue;
            }
            if (operation.type === 'edit') {
                if (item.kind !== 'design') fail('design-selection-required', 'Use the parent design ref and the object path for granular edits.');
                const modified = await drafts.editDesign({ design: content, expectedCid: cidOfObject(content), edits: operation.edits, parcelSourceId: original.parcelSourceId });
                modified.design.origin = { cid: item.designCid };
                working.set(item.designCid, modified.design); indices.set(item.designCid, null);
                changes.push({ type: 'edit', ref: item.ref, beforeCid: item.designCid, afterCid: cidOfObject(modified.design) }); continue;
            }
            if (item.kind === 'building' && !indices.get(item.designCid)) fail('selection-changed', 'Inspect again after granular edits to a parent design before using its old building refs.');
            const index = item.kind === 'building' ? indices.get(item.designCid).indexOf(item.buildingIndex) : null;
            if (index === -1) fail('conflicting-edits', 'This building was already removed.');
            if (operation.type === 'remove' && (item.kind === 'design' || content.geometry.buildings.length === 1)) {
                working.delete(item.designCid); changes.push({ type: 'remove', ref: item.ref, beforeCid: item.designCid }); continue;
            }
            const edits = operation.type === 'remove' ? [{ type: 'remove_building', buildingIndex: index }]
                : operation.changes.map(change => ({ ...change, ...(index == null ? {} : { buildingIndex: index }) }));
            if (operation.type === 'modify' && edits.some(change => change.type === 'remove_building')) fail('use-remove-operation', 'Use a plan remove operation with its building ref so remaining references stay unambiguous.');
            const modified = await drafts.modifyDesign({ design: content, changes: edits, parcelSourceId: original.parcelSourceId });
            modified.design.origin = { cid: item.designCid };
            const checked = designObject({ ...modified.design, createdAt: modified.design.authoredAt });
            working.set(item.designCid, checked.content);
            if (operation.type === 'remove') indices.get(item.designCid).splice(index, 1);
            changes.push({ type: operation.type, ref: item.ref, beforeCid: item.designCid, afterCid: checked.cid });
        }
        if (!working.size) fail('empty-plan', 'An agreement must retain at least one design.');
        if (working.size > 100) fail('plan-too-large', 'Keep at most 100 designs in a private plan revision.');
        const previous = original.agreement;
        const suppliedRights = terms.rights ?? terms.rule?.approvalConfig?.rights;
        const derived = await agreements.draftAgreement({ designs: [...working.values()], parcelSourceId: original.parcelSourceId,
            currency: previous.money.currency, rights: suppliedRights ?? previous.rule.approvalConfig?.rights,
            title: previous.title, author: previous.author, createdAt: new Date().toISOString() });
        // A road edit can revise its neighbours as well. Report the final identity of every edit
        // and every additional junction change, rather than leaving intermediate CIDs in the diff.
        for (const roadChange of derived.roadChanges || []) {
            const edited = changes.filter(change => change.afterCid === roadChange.beforeCid);
            edited.forEach(change => { change.afterCid = roadChange.afterCid; });
            if (!edited.length) changes.push(roadChange);
        }
        const oldInputs = previous.inputs.parcels.map(p => p.parcelId).sort(), newInputs = derived.agreement.inputs.parcels.map(p => p.parcelId).sort();
        const inputChanged = JSON.stringify(oldInputs) !== JSON.stringify(newInputs);
        if (inputChanged && !suppliedRights && (previous.rule.electorate === 'owners' || previous.inputs.parcels.some(p => p.holders.length) || previous.money.lines.length)) fail('rights-review-required', 'The input land changed. Supply a reviewed complete rights snapshot before carrying ownership or money into this revision.');
        const allocations = terms.allocations ?? previous.allocations;
        if (allocations.some(line => !derived.agreement.outputs.some(piece => piece.hash === line.output))) fail('allocations-review-required', 'An allocated land piece changed. Supply reviewed allocations for the revised output hashes; old allocations will not be silently discarded.', { action: 'Draft the revised design set with ugt_draft_agreement, review its outputs, then provide explicit terms.allocations.' });
        const inputs = derived.agreement.inputs.parcels.map(p => ({ ...p, holders: suppliedRights ? holdersFromRights(suppliedRights, p.parcelId)
            : previous.inputs.parcels.find(old => old.parcelId === p.parcelId)?.holders || [] }));
        const rule = structuredClone(terms.rule ?? previous.rule);
        if (suppliedRights && rule.approvalConfig) rule.approvalConfig.rights = suppliedRights;
        const checked = agreementObject({ ...previous, ...Object.fromEntries(['title','author','sponsor','deadline'].filter(key => Object.hasOwn(terms, key)).map(key => [key, terms[key]])), createdAt: derived.agreement.createdAt,
            designs: derived.agreement.designs, parcels: inputs, openGroundM2: derived.agreement.inputs.openGroundM2,
            outputs: derived.agreement.outputs, allocations, money: terms.money ?? previous.money, rule });
        const designs = derived.designs;
        const carriesRights = !suppliedRights && (previous.rule.approvalConfig?.rights || inputs.some(p => p.holders.length));
        const cutWarning = roadCutWarning(derived.groundEffects || []);
        return { agreement: checked.content, cid: checked.cid, previousCid: original.cid, parcelSourceId: derived.parcelSourceId,
            designs, changes, inputChanged, groundEffects: derived.groundEffects || [], rightsStatus: suppliedRights ? 'caller-supplied-unverified' : carriesRights ? 'carried-unverified' : 'none',
            warnings: ['This is a private revision. The original plan, published designs and prior decisions retain their identity. Review this preview before publishing.',
                ...(cutWarning ? [cutWarning] : []),
                ...(carriesRights ? ['Existing rights and holders were carried into the draft without refreshing or verifying them. Review them before publication; no prior signature applies to this revision.'] : [])],
            ...await previewArtifact({ origin: appOrigin, agreement: checked.content, designs: designs.map(d => d.content), parcelSourceId: derived.parcelSourceId }) };
    }
    return { inspectPlan, editPlan };
}
