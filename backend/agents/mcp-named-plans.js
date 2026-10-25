// Named plans are immutable design selections and map views, independent of agreement ground and terms.
import { createRequire } from 'node:module';
import { appTurf as turf, intentDesign } from './mcp-geometry.js';
import { cidOfObject, designObject, isCid, isParcelLayout } from './agreement-objects.js';
import { editedDesign } from './mcp-edit.js';
import { validateTrackDesign } from './mcp-constructors.js';
import { previewArtifact } from './mcp-preview.js';
import { trustedMetadata } from './mcp-results.js';
const require = createRequire(import.meta.url);
const PlanRecord = require('../../frontend/js/plan-record.js');
const fail = (code, message, next = { action: 'Inspect the intended named plan revision and use its explicit references.' }) => {
    throw Object.assign(new Error(message), { code, next });
};
const missing = error => ['http-404', 'design-not-found'].includes(error.code);

export function createMcpNamedPlanTools({ read, drafts, appOrigin, resolveDraftReference, publishDesign }) {
    const planUrl = cid => new URL(`/plans/${cid}`, appOrigin).href;
    function checkRevision(value, expectedCid, currentCid) {
        if (expectedCid !== currentCid) throw Object.assign(new Error('Inspect the selected named plan and confirm its exact revision before editing or publishing.'), {
            code: 'plan-revision-mismatch', field: 'expectedCid', currentCid, expectedCid,
            next: { tool: 'ugt_inspect_plan', arguments: { plan: value }, action: 'Review this revision and use the returned CID as expectedCid.' } });
    }
    function checkedPlan(content, claimedCid) {
        const error = PlanRecord.validate(content);
        if (error) fail('invalid-plan', error);
        const cid = cidOfObject(content);
        if (claimedCid && claimedCid !== cid) fail('cid-mismatch', 'The named plan differs from its claimed CID.');
        return cid;
    }
    async function resolvePlan(value) {
        let artifact = value?.draftArtifact || value, requestedCid, published = false;
        const reference = typeof value === 'string' ? value : value?.draftRef;
        if (reference) {
            if (isCid(reference)) requestedCid = reference;
            else {
                let url;
                try { url = new URL(reference); } catch { fail('plan-reference-invalid', 'Use a named plan CID, /plans link, canonical artifact or private draftRef.'); }
                if (url.origin === new URL(appOrigin).origin && /^\/plans\/baf(?:krei|ybei)[a-z2-7]{52}\/?$/.test(url.pathname)) requestedCid = url.pathname.split('/')[2];
            }
            if (requestedCid) { artifact = await read.request(`/plans/${requestedCid}`); published = true; }
            else {
                if (!resolveDraftReference) fail('draft-reference-unavailable', 'Use the canonical named plan and its carried designs.');
                artifact = await resolveDraftReference(reference);
            }
        }
        const content = artifact?.untrusted?.plan || artifact?.untrusted?.content || artifact?.plan || artifact?.content || artifact;
        const cid = checkedPlan(content, requestedCid || value?.cid);
        if (artifact?.cid && artifact.cid !== cid) fail('cid-mismatch', 'The returned named plan differs from its CID.');
        const carried = new Map();
        for (const row of artifact.designs || []) {
            const resolved = await drafts.resolveDesignSource(row);
            const memberCid = cidOfObject(resolved.content);
            if (!content.designCids.includes(memberCid) || carried.has(memberCid)) fail('plan-members-invalid', 'A carried design is duplicated or is not a member of this named plan.');
            carried.set(memberCid, { cid: memberCid, content: resolved.content,
                parcelSourceId: resolved.parcelSourceId || artifact.designSources?.[memberCid] || artifact.parcelSourceId || null });
        }
        const designs = [];
        for (const memberCid of content.designCids) {
            let row = carried.get(memberCid);
            if (!row) {
                const resolved = await drafts.resolveDesignSource(memberCid);
                if (cidOfObject(resolved.content) !== memberCid) fail('cid-mismatch', 'A member design differs from the plan commitment.');
                row = { cid: memberCid, ...resolved };
            }
            designs.push(row);
        }
        return { plan: structuredClone(content), cid, designs, published };
    }
    function defaultView(designs) {
        const bounds = designs.map(row => turf.bbox(turf.feature(read.siteOfDesign(row.content))));
        const west = Math.min(...bounds.map(b => b[0])), south = Math.min(...bounds.map(b => b[1]));
        const east = Math.max(...bounds.map(b => b[2])), north = Math.max(...bounds.map(b => b[3]));
        return { at: `${(south + north) / 2},${(west + east) / 2},17`, mode: '2d', city: designs[0].content.city || null };
    }
    async function privateResult(plan, designs, extra = {}) {
        const cid = checkedPlan(plan);
        const designSources = Object.fromEntries(designs.filter(row => row.parcelSourceId).map(row => [row.cid, row.parcelSourceId]));
        const preview = await previewArtifact({ plan, designs: designs.map(row => row.content) });
        preview.draftArtifact.designSources = designSources;
        return { plan, cid, designs, publication: 'private', ...extra, ...preview };
    }
    async function draftPlan({ designs: inputs, title, view }) {
        if (!Array.isArray(inputs) || !inputs.length || inputs.length > PlanRecord.MAX_DESIGNS) fail('invalid-plan', 'Choose between 1 and 1000 designs.');
        const designs = [];
        for (const input of inputs) {
            const resolved = await drafts.resolveDesignSource(input), cid = cidOfObject(resolved.content);
            if (designs.some(row => row.cid === cid)) fail('duplicate-design', 'The named plan contains the same design twice.');
            designs.push({ cid, ...resolved });
        }
        let plan;
        try { plan = PlanRecord.create(title, designs.map(row => row.cid), view || defaultView(designs)); }
        catch (error) { fail('invalid-plan', error.message); }
        return privateResult(plan, designs);
    }
    async function getPlan({ plan: value }) {
        const resolved = await resolvePlan(value);
        if (!resolved.published) return privateResult(resolved.plan, resolved.designs);
        return { plan: resolved.plan, cid: resolved.cid, designs: resolved.designs, publication: 'published', url: planUrl(resolved.cid), previewUrl: planUrl(resolved.cid) };
    }
    function inventory(plan) {
        const items = [];
        const add = (item, geometry) => {
            const feature = turf.feature(geometry);
            items.push({ ...item, bbox: turf.bbox(feature), center: turf.centroid(feature).geometry.coordinates, areaM2: turf.area(feature), geometry });
        };
        for (const { cid, content } of plan.designs) {
            const ref = `design:${cid}`;
            add({ ref, kind: 'design', designCid: cid, path: '', title: content.title, goal: content.goal,
                buildingCount: content.geometry?.buildings?.length || 0 }, read.siteOfDesign(content));
            (content.geometry?.buildings || []).forEach((building, index) => add({
                ref: `building:${cid}:${index}`, kind: 'building', designCid: cid, designRef: ref,
                buildingIndex: index, path: `/geometry/buildings/${index}`, title: building.properties?.name || content.title,
                goal: content.goal, floors: building.properties?.floors ?? null, heightM: building.properties?.height ?? null,
                use: building.properties?.use ?? null, coupledMassing: Boolean(content.geometry.blockMassing)
            }, building.geometry));
        }
        return items;
    }
    async function inspectPlan({ plan: value, filter = {}, includeGeometry = false, offset = 0, limit = 100 }) {
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) fail('invalid-pagination', 'Use a nonnegative offset and a limit between 1 and 200.');
        const plan = await resolvePlan(value), all = inventory(plan);
        const anchor = filter.relativeTo && all.find(item => item.ref === filter.relativeTo.ref);
        if (filter.relativeTo && !anchor) fail('selection-not-found', 'The spatial reference does not belong to this named plan revision.');
        const matched = all.filter(item => {
            if (filter.kind && filter.kind !== item.kind) return false;
            if (filter.goal && filter.goal !== item.goal) return false;
            if (filter.text && !String(item.title || '').toLowerCase().includes(filter.text.toLowerCase())) return false;
            const b = item.bbox, within = filter.withinBbox;
            if (within && (b[0] < within[0] || b[1] < within[1] || b[2] > within[2] || b[3] > within[3])) return false;
            if (anchor) {
                const a = anchor.bbox;
                return ({ north: b[1] > a[3], south: b[3] < a[1], east: b[0] > a[2], west: b[2] < a[0] })[filter.relativeTo.direction] === true;
            }
            return true;
        });
        return { cid: plan.cid, title: plan.plan.title, view: plan.plan.view,
            items: matched.slice(offset, offset + limit).map(({ geometry, ...item }) => includeGeometry ? { ...item, geometry } : item),
            total: matched.length, offset, truncated: offset + limit < matched.length,
            selectionBasis: 'References belong to this immutable named plan revision. Compass selection requires the whole object bbox beyond the anchor bbox.',
            next: trustedMetadata({ tool: 'ugt_edit_plan', action: 'Use expectedCid and explicit refs. Ask the person when their description matches more than one object.' }) };
    }
    async function editPlan({ plan: value, expectedCid, operations = [], title, view }) {
        const original = await resolvePlan(value);
        checkRevision(value, expectedCid, original.cid);
        if (!operations.length && title === undefined && view === undefined) fail('empty-edit', 'Supply membership/design operations, a title or a saved view.');
        const byRef = new Map(inventory(original).map(item => [item.ref, item]));
        const working = new Map(original.designs.map(row => [row.cid, structuredClone(row)]));
        const indices = new Map(original.designs.map(row => [row.cid, (row.content.geometry?.buildings || []).map((_, index) => index)]));
        const changes = [];
        const resolvedRow = async input => {
            const resolved = await drafts.resolveDesignSource(input);
            return { cid: cidOfObject(resolved.content), ...resolved };
        };
        const unique = (row, except) => {
            if ([...working.entries()].some(([key, other]) => key !== except && cidOfObject(other.content) === row.cid)) fail('duplicate-design', 'This design is already in the revised named plan.');
        };
        for (const operation of operations) {
            if (operation.type === 'add') {
                const row = await resolvedRow(operation.design); unique(row); working.set(row.cid, row);
                changes.push({ type: 'add', afterCid: row.cid }); continue;
            }
            if (!['remove', 'replace', 'edit', 'modify'].includes(operation.type)) fail('invalid-operation', 'Use add, remove, replace, edit or modify.');
            const item = byRef.get(operation.ref);
            if (!item) fail('selection-not-found', 'Use one exact design or building reference from this named plan revision.');
            const row = working.get(item.designCid);
            if (!row) fail('conflicting-edits', 'This design was already removed.');
            if (item.kind === 'building' && !indices.get(item.designCid)) fail('selection-changed', 'Inspect a new revision before using child references after replacing or editing their design.');
            const index = item.kind === 'building' ? indices.get(item.designCid).indexOf(item.buildingIndex) : null;
            if (index === -1) fail('conflicting-edits', 'This building was already removed.');
            if (operation.type === 'remove' && (item.kind === 'design' || row.content.geometry.buildings.length === 1)) {
                working.delete(item.designCid); changes.push({ type: 'remove', ref: item.ref, beforeCid: row.cid }); continue;
            }
            if (operation.type === 'replace') {
                if (item.kind !== 'design') fail('design-selection-required', 'Replace a whole design using its design reference.');
                const replacement = await resolvedRow(operation.design); unique(replacement, item.designCid);
                working.set(item.designCid, replacement); indices.set(item.designCid, null);
                changes.push({ type: 'replace', ref: item.ref, beforeCid: row.cid, afterCid: replacement.cid }); continue;
            }
            let content, parcelSourceId = row.parcelSourceId;
            if (operation.type === 'edit') {
                if (item.kind !== 'design') fail('design-selection-required', 'Use the parent design reference and JSON Pointer paths for granular edits.');
                content = editedDesign(row.content, row.cid, operation.edits); indices.set(item.designCid, null);
            } else {
                const typed = operation.type === 'remove' ? [{ type: 'remove_building', buildingIndex: index }]
                    : operation.changes?.map(change => ({ ...change, ...(index == null ? {} : { buildingIndex: index }) }));
                if (!typed?.length) fail('invalid-change', 'Supply typed design changes.');
                if (operation.type === 'modify' && typed.some(change => change.type === 'remove_building')) fail('use-remove-operation', 'Remove a building with its explicit building reference.');
                if (typed.some(change => change.type === 'fit_to_permitted')) {
                    const modified = await drafts.modifyDesign({ design: row, changes: typed, parcelSourceId });
                    content = modified.design; parcelSourceId = modified.parcelSourceId || parcelSourceId;
                } else {
                    content = intentDesign.modify(structuredClone(row.content), typed, { turf });
                    content.authoredAt = new Date().toISOString();
                }
                if (operation.type === 'remove') indices.get(item.designCid).splice(index, 1);
                else if ((content.geometry?.buildings?.length || 0) !== (row.content.geometry?.buildings?.length || 0)) indices.set(item.designCid, null);
            }
            content.origin = { cid: item.designCid };
            validateTrackDesign(content, row.content);
            const checked = designObject({ ...content, createdAt: content.authoredAt });
            const updated = { cid: checked.cid, content: checked.content, parcelSourceId };
            unique(updated, item.designCid); working.set(item.designCid, updated);
            changes.push({ type: operation.type, ref: item.ref, beforeCid: row.cid, afterCid: updated.cid });
        }
        let plan;
        try { plan = PlanRecord.create(title ?? original.plan.title, [...working.values()].map(row => row.cid), view ?? original.plan.view); }
        catch (error) { fail('invalid-plan', error.message); }
        return privateResult(plan, [...working.values()], { previousCid: original.cid, changes });
    }
    async function publishPlan({ plan: value, expectedCid, confirm }) {
        if (confirm !== true) fail('confirmation-required', 'confirm must be true to publish a named plan.');
        const state = { cid: expectedCid || null, stage: 'resolve', pinnedCids: [], indexed: false };
        try {
            const resolved = await resolvePlan(value);
            checkRevision(value, expectedCid, resolved.cid);
            state.cid = resolved.cid; state.stage = 'lookup';
            let existingPlan;
            try { existingPlan = await read.request(`/plans/${resolved.cid}`); }
            catch (error) { if (!missing(error)) throw error; }
            if (existingPlan) {
                if (existingPlan.cid !== resolved.cid || checkedPlan(existingPlan.content, resolved.cid) !== resolved.cid) fail('cid-mismatch', 'An existing named plan differs from the confirmed revision.');
                return { cid: resolved.cid, plan: existingPlan.content, row: existingPlan, publication: 'published', publishedDesignCids: [], url: planUrl(resolved.cid), previewUrl: planUrl(resolved.cid) };
            }
            const unpublished = [];
            for (const row of resolved.designs) {
                try {
                    const existing = await read.getDesign({ designCid: row.cid });
                    if (existing.cid !== row.cid || cidOfObject(existing.content || existing.untrusted?.content) !== row.cid) fail('cid-mismatch', 'A published member differs from its committed design CID.');
            } catch (error) { if (!missing(error)) throw error; unpublished.push(row); }
        }
        const layout = unpublished.find(row => isParcelLayout(row.content));
        if (layout) state.layoutCid = layout.cid;
        if (layout) fail('layout-agreement-required', 'An unpublished parcel layout must be published with the agreement that settles its land before saving this named plan.',
            { tool: 'ugt_propose_agreement', action: 'Draft and review an agreement carrying the parcel layout, publish it, then retry this same named plan.', designCid: layout.cid });
        if (unpublished.length && !publishDesign) fail('publication-unavailable', 'Design publication is unavailable in this client.');
        for (const row of unpublished) {
            state.stage = 'publish-design';
            const published = await publishDesign({ design: row.content, parcelSourceId: row.parcelSourceId || null, expectedCid: row.cid, confirm: true });
            state.pinnedCids.push(row.cid);
            if (published.cid !== row.cid) fail('cid-mismatch', 'Dependency publication returned another design CID.');
            const existing = await read.getDesign({ designCid: row.cid });
            if (existing.cid !== row.cid || cidOfObject(existing.content || existing.untrusted?.content) !== row.cid) fail('cid-mismatch', 'Published dependency could not be read back with matching content.');
        }
        state.stage = 'index-plan';
        const published = await read.request('/plans', {}, { content: resolved.plan });
        if (published.cid !== resolved.cid || checkedPlan(published.content, resolved.cid) !== resolved.cid) fail('cid-mismatch', 'The published named plan differs from the confirmed revision.');
        state.indexed = true; state.pinnedCids.push(resolved.cid); state.stage = 'readback';
        const row = await read.request(`/plans/${resolved.cid}`);
        if (row.cid !== resolved.cid || checkedPlan(row.content, resolved.cid) !== resolved.cid) fail('cid-mismatch', 'Published named plan could not be read back with matching content.');
        return { cid: resolved.cid, plan: row.content, row, publication: 'published', publishedDesignCids: unpublished.map(row => row.cid), url: planUrl(resolved.cid), previewUrl: planUrl(resolved.cid) };
        } catch (error) {
            const dependency = error.cid && error.cid !== state.cid ? { dependencyCid: error.cid, dependencyStage: error.stage } : {};
            throw Object.assign(error, { ...dependency, code: error.code || 'publication-failed', cid: state.cid, stage: state.stage,
                pinnedCids: [...new Set([...state.pinnedCids, ...(error.pinnedCids || [])])], indexed: state.indexed,
                url: state.cid ? planUrl(state.cid) : null,
                next: state.stage === 'resolve' && error.next ? error.next : state.layoutCid ? { tool: 'ugt_propose_agreement', designCid: state.layoutCid, action: 'Draft and review an agreement carrying this layout, publish it, then retry the same named plan.' }
                    : { tool: 'ugt_publish_plan', arguments: { plan: value, expectedCid, confirm }, action: 'Retry this same confirmed immutable named plan revision; published members retain their CIDs.' } });
        }
    }
    return { draftPlan, getPlan, inspectPlan, editPlan, publishPlan };
}
