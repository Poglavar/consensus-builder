// Named plans are immutable design selections and map views, independent of agreement ground and terms.
import { createRequire } from 'node:module';
import proj4 from 'proj4';
import { appTurf as turf, intentDesign } from './mcp-geometry.js';
import { cidOfObject, designObject, isCid } from './agreement-objects.js';
import { editedDesign } from './mcp-edit.js';
import { validateTrackDesign } from './mcp-constructors.js';
import { previewArtifact } from './mcp-preview.js';
import { trustedMetadata } from './mcp-results.js';
import { parcelSourceIdOf } from './mcp-read-tools.js';
import { placeInPlan } from './mcp-plan-placement.js';
const require = createRequire(import.meta.url);
const PlanRecord = require('../../frontend/js/plan-record.js');
const PlanFile = require('../../frontend/js/plan-file.js');
const CityJsonExport = require('../../frontend/js/city-json-export.js');
const fail = (code, message, next = { action: 'Inspect the intended named plan revision and use its explicit references.' }) => {
    throw Object.assign(new Error(message), { code, next });
};
const missing = error => ['http-404', 'design-not-found'].includes(error.code);

// Construction windows follow a member through revisions: renames maps an old design CID to its
// revision's CID (an edit, a replacement or a road joined to another).
function carrySchedule(schedule, renames, memberCids) {
    const follow = cid => { const seen = new Set(); while (renames.has(cid) && !seen.has(cid)) { seen.add(cid); cid = renames.get(cid); } return cid; };
    const members = new Set(memberCids), carried = {};
    for (const [cid, window] of Object.entries(schedule || {})) {
        const next = follow(cid);
        if (members.has(next)) carried[next] = window;
    }
    return carried;
}

export function createMcpNamedPlanTools({ read, drafts, appOrigin, resolveDraftReference, publishDesign }) {
    const planUrl = (cid, when = null, buildout = null) => {
        const url = new URL(`/plans/${cid}`, appOrigin);
        if (when) url.searchParams.set('when', when);
        if (buildout) url.searchParams.set('buildout', buildout);
        return url.href;
    };
    // schedule: { [designCid | 'design:<cid>']: { start, end } | null }, merged over carried windows;
    // null clears a member's window. Keys naming a design this call revised follow it.
    function scheduleWith(base, changes, renames, memberCids) {
        const next = carrySchedule(base, renames, memberCids);
        for (const [key, window] of Object.entries(changes || {})) {
            const named = key.startsWith('design:') ? key.slice('design:'.length) : key;
            const cid = carrySchedule({ [named]: true }, renames, memberCids);
            const target = Object.keys(cid)[0];
            if (!target) fail('schedule-member-not-found', `The construction window names ${key}, which is not a design of this plan revision.`,
                { tool: 'ugt_inspect_plan', action: 'Use a design CID or design ref returned by inspecting this plan.' });
            if (window === null) delete next[target];
            else next[target] = { start: window.start, end: window.end };
        }
        return next;
    }
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
        const warnings = [];
        // A CityJSON file the site wrote carries its plan file, read back as the Lists import does.
        if (artifact?.type === 'CityJSON') {
            const carried = CityJsonExport.readBack(JSON.stringify(artifact), { proj4 });
            if (!carried) fail('plan-file-required', 'This CityJSON file carries no plan.', { tool: 'ugt_import_design', action: 'Import its buildings with format cityjson.' });
            if (carried.edited) warnings.push('The buildings and spaces in this CityJSON file differ from the plan it carries; the carried plan was read, so changes made in other tools are not in it.');
            artifact = carried.file;
        }
        if (artifact?.schema === PlanFile.SCHEMA) {
            const file = PlanFile.parse(JSON.stringify(artifact));
            artifact = { plan: file.plan, designs: file.designs.map(row => ({ ...row,
                parcelSourceId: parcelSourceIdOf({ binding: { parcelSource: file.designSources[row.cid] } }) || null })) };
        }
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
        return { plan: structuredClone(content), cid, designs, published, warnings };
    }
    function defaultView(designs) {
        const bounds = designs.map(row => turf.bbox(turf.feature(read.siteOfDesign(row.content))));
        const west = Math.min(...bounds.map(b => b[0])), south = Math.min(...bounds.map(b => b[1]));
        const east = Math.max(...bounds.map(b => b[2])), north = Math.max(...bounds.map(b => b[3]));
        return { at: `${(south + north) / 2},${(west + east) / 2},17`, mode: '2d', city: designs[0].content.city || null };
    }
    async function privateResult(plan, designs, extra = {}, { when = null, buildout = null } = {}) {
        const cid = checkedPlan(plan);
        const designSources = Object.fromEntries(designs.filter(row => row.parcelSourceId).map(row => [row.cid, row.parcelSourceId]));
        const preview = await previewArtifact({ plan, designs: designs.map(row => row.content), when, buildout });
        preview.draftArtifact.designSources = designSources;
        return { plan, cid, designs, publication: 'private', ...extra, ...preview };
    }
    async function draftPlan({ designs: inputs, title, view, schedule, when = null, buildout = null }) {
        if (!Array.isArray(inputs) || !inputs.length || inputs.length > PlanRecord.MAX_DESIGNS) fail('invalid-plan', 'Choose between 1 and 1000 designs.');
        const designs = [];
        for (const input of inputs) {
            const resolved = await drafts.resolveDesignSource(input), cid = cidOfObject(resolved.content);
            if (designs.some(row => row.cid === cid)) fail('duplicate-design', 'The named plan contains the same design twice.');
            designs.push({ cid, ...resolved });
        }
        let plan;
        const cids = designs.map(row => row.cid), windows = scheduleWith({}, schedule, new Map(), cids);
        try { plan = PlanRecord.create(title, cids, view || defaultView(designs), windows); }
        catch (error) { fail('invalid-plan', error.message); }
        return privateResult(plan, designs, {}, { when, buildout });
    }
    // An agent's working plan (docs/agent-working-plan.md): authored designs are placed in turn with the
    // browser's apply rules. Without a plan they start a new private one. A refusal places nothing and
    // leaves the plan as it was, so the agent can ask the person before anything leaves the plan.
    // designs: [{ cid, content, parcelSourceId, before? }], before naming the member an edit revises.
    async function placeDesigns({ plan: value, designs: incoming, displace = false }) {
        const original = value === undefined || value === null ? null : await resolvePlan(value);
        let members = original ? original.designs : [];
        const placed = [], consequences = { removed: [], junctions: [], cuts: [] }, renames = new Map();
        for (const { before = null, ...row } of incoming) {
            const member = before && members.some(other => other.cid === before) ? before : null;
            const result = placeInPlan({ members, incoming: row, before: member, displace });
            if (result.placement.status === 'refused') {
                return { placement: { ...result.placement, designCid: row.cid, designTitle: row.content.title || null },
                    designs: [], consequences: { removed: [], junctions: [], cuts: [] },
                    plan: original ? { cid: original.cid, status: 'unchanged' } : null };
            }
            members = result.members; placed.push(result.design);
            if (member) renames.set(member, result.design.cid);
            for (const change of result.consequences.junctions) renames.set(change.beforeCid, change.afterCid);
            for (const key of Object.keys(consequences)) consequences[key].push(...result.consequences[key]);
        }
        let plan;
        const cids = members.map(row => row.cid);
        try { plan = PlanRecord.create(original?.plan.title || incoming[0]?.content.title || 'Working plan', cids, original?.plan.view || defaultView(members),
            carrySchedule(original?.plan.schedule, renames, cids)); }
        catch (error) { fail('invalid-plan', error.message); }
        return { placement: { status: 'placed' }, designs: placed, consequences,
            plan: await privateResult(plan, members, original ? { previousCid: original.cid } : {}) };
    }
    async function getPlan({ plan: value, when = null, buildout = null }) {
        const resolved = await resolvePlan(value);
        if (!resolved.published) return privateResult(resolved.plan, resolved.designs, resolved.warnings.length ? { warnings: resolved.warnings } : {}, { when, buildout });
        return { plan: resolved.plan, cid: resolved.cid, designs: resolved.designs, publication: 'published', url: planUrl(resolved.cid), previewUrl: planUrl(resolved.cid, when, buildout) };
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
                buildingCount: content.geometry?.buildings?.length || 0, construction: plan.plan.schedule?.[cid] || null }, read.siteOfDesign(content));
            (content.geometry?.buildings || []).forEach((building, index) => add({
                ref: `building:${cid}:${index}`, kind: 'building', designCid: cid, designRef: ref,
                buildingIndex: index, path: `/geometry/buildings/${index}`, title: building.properties?.name || content.title,
                goal: content.goal, floors: building.properties?.floors ?? null, heightM: building.properties?.height ?? null,
                use: building.properties?.use ?? null, coupledMassing: Boolean(content.geometry.ruleMassing)
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
        return { cid: plan.cid, title: plan.plan.title, view: plan.plan.view, schedule: plan.plan.schedule || null,
            items: matched.slice(offset, offset + limit).map(({ geometry, ...item }) => includeGeometry ? { ...item, geometry } : item),
            total: matched.length, offset, truncated: offset + limit < matched.length,
            selectionBasis: 'References belong to this immutable named plan revision. Compass selection requires the whole object bbox beyond the anchor bbox.',
            next: trustedMetadata({ tool: 'ugt_edit_plan', action: 'Use expectedCid and explicit refs. Ask the person when their description matches more than one object.' }) };
    }
    async function editPlan({ plan: value, expectedCid, operations = [], title, view, schedule, when = null, buildout = null }) {
        const original = await resolvePlan(value);
        checkRevision(value, expectedCid, original.cid);
        if (!operations.length && title === undefined && view === undefined && schedule === undefined) fail('empty-edit', 'Supply membership/design operations, a title, a saved view or construction windows.');
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
        // Each added or revised design is placed with the map's apply rules, as the authoring tools place theirs
        // (docs/agent-working-plan.md): a refusal fails the edit, and members it revises or displaces follow.
        const consequences = { removed: [], junctions: [], cuts: [] };
        const place = (key, row, displace) => {
            const before = working.get(key)?.cid || null;
            const result = placeInPlan({ members: [...working.values()], incoming: row, before, displace: displace === true });
            if (result.placement.status === 'refused') {
                throw Object.assign(new Error(result.placement.message), { code: 'ground-occupied', conflicts: result.placement.conflicts, designCid: row.cid,
                    next: { action: 'Tell the person which designs hold this ground. Move the design clear, or retry the operation with displace: true once they agree.' } });
            }
            const byCid = new Map(result.members.map(member => [member.cid, member]));
            const revised = new Map(result.consequences.junctions.map(change => [change.beforeCid, change.afterCid]));
            const removed = new Set(result.consequences.removed.map(member => member.cid));
            for (const [other, member] of [...working]) {
                if (other === key) continue;
                if (removed.has(member.cid)) { working.delete(other); indices.delete(other); }
                else if (revised.has(member.cid)) working.set(other, byCid.get(revised.get(member.cid)));
            }
            for (const name of Object.keys(consequences)) consequences[name].push(...result.consequences[name]);
            working.set(key, result.design);
            return result.design;
        };
        for (const operation of operations) {
            if (operation.type === 'add') {
                const row = await resolvedRow(operation.design); unique(row);
                const placed = place(row.cid, row, operation.displace);
                changes.push({ type: 'add', afterCid: placed.cid }); continue;
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
                const placed = place(item.designCid, replacement, operation.displace); indices.set(item.designCid, null);
                changes.push({ type: 'replace', ref: item.ref, beforeCid: row.cid, afterCid: placed.cid }); continue;
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
            unique(updated, item.designCid);
            const placed = place(item.designCid, updated, operation.displace);
            changes.push({ type: operation.type, ref: item.ref, beforeCid: row.cid, afterCid: placed.cid });
        }
        let plan;
        const cids = [...working.values()].map(row => row.cid);
        const renames = new Map([...changes.filter(change => change.beforeCid && change.afterCid).map(change => [change.beforeCid, change.afterCid]),
            ...consequences.junctions.map(change => [change.beforeCid, change.afterCid])]);
        const windows = scheduleWith(original.plan.schedule, schedule, renames, cids);
        try { plan = PlanRecord.create(title ?? original.plan.title, cids, view ?? original.plan.view, windows); }
        catch (error) { fail('invalid-plan', error.message); }
        return privateResult(plan, [...working.values()], { previousCid: original.cid, changes, consequences }, { when, buildout });
    }
    async function publishPlan({ plan: value, expectedCid, confirm }) {
        if (confirm !== true) fail('confirmation-required', 'confirm must be true to publish a named plan.');
        const state = { cid: expectedCid || null, stage: 'resolve', publishedCids: [], indexed: false };
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
        if (unpublished.length && !publishDesign) fail('publication-unavailable', 'Design publication is unavailable in this client.');
        for (const row of unpublished) {
            state.stage = 'publish-design';
            const published = await publishDesign({ design: row.content, parcelSourceId: row.parcelSourceId || null, expectedCid: row.cid, confirm: true });
            state.publishedCids.push(row.cid);
            if (published.cid !== row.cid) fail('cid-mismatch', 'Dependency publication returned another design CID.');
            const existing = await read.getDesign({ designCid: row.cid });
            if (existing.cid !== row.cid || cidOfObject(existing.content || existing.untrusted?.content) !== row.cid) fail('cid-mismatch', 'Published dependency could not be read back with matching content.');
        }
        state.stage = 'index-plan';
        const published = await read.request('/plans', {}, { content: resolved.plan });
        if (published.cid !== resolved.cid || checkedPlan(published.content, resolved.cid) !== resolved.cid) fail('cid-mismatch', 'The published named plan differs from the confirmed revision.');
        state.indexed = true; state.publishedCids.push(resolved.cid); state.stage = 'readback';
        const row = await read.request(`/plans/${resolved.cid}`);
        if (row.cid !== resolved.cid || checkedPlan(row.content, resolved.cid) !== resolved.cid) fail('cid-mismatch', 'Published named plan could not be read back with matching content.');
        return { cid: resolved.cid, plan: row.content, row, publication: 'published', publishedDesignCids: unpublished.map(row => row.cid), url: planUrl(resolved.cid), previewUrl: planUrl(resolved.cid) };
        } catch (error) {
            const dependency = error.cid && error.cid !== state.cid ? { dependencyCid: error.cid, dependencyStage: error.stage } : {};
            throw Object.assign(error, { ...dependency, code: error.code || 'publication-failed', cid: state.cid, stage: state.stage,
                publishedCids: [...new Set([...state.publishedCids, ...(error.publishedCids || [])])], indexed: state.indexed,
                url: state.cid ? planUrl(state.cid) : null,
                next: state.stage === 'resolve' && error.next ? error.next : { tool: 'ugt_publish_plan', arguments: { plan: value, expectedCid, confirm }, action: 'Retry this same confirmed immutable named plan revision; published members retain their CIDs.' } });
        }
    }
    return { draftPlan, getPlan, inspectPlan, editPlan, publishPlan, resolvePlan, placeDesigns };
}
