// This module keeps raw MCP payloads out of model context while preserving user-visible design facts.
const LIMIT = 4096;
const payloadOf = result => result?.structuredContent ?? result?.result ?? result ?? {};
const clip = (value, max = 240) => typeof value === 'string' ? value.slice(0, max) : value;
const array = (value, mapper = x => x, count = 20) => Array.isArray(value) ? value.slice(0, count).map(mapper) : [];
const prose = (row, key, max = 180) => clip(row?.untrusted?.[key] ?? row?.[key], max);
const byteLength = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const refFree = value => {
    if (Array.isArray(value)) return value.map(refFree);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (/previewUrl|draftRef|binding|content|^untrusted$/i.test(key)) continue;
        if (key === 'untrustedValue') { out.value = refFree(item); continue; }
        if (key === 'geometry' && typeof item === 'object') continue;
        if (['title','goal','message','text'].includes(key)) out[key] = clip(item, 220);
        else out[key] = refFree(item);
    }
    if (value.untrusted) for (const key of ['title','goal','message','text']) if (value.untrusted[key] != null && out[key] == null) out[key] = clip(value.untrusted[key], 220);
    return out;
};
function bounded(value) {
    if (byteLength(value) <= LIMIT) return JSON.stringify(value);
    const out = structuredClone(value);
    out.truncated = true;
    const arrays = item => {
        const found = [];
        const visit = (node, key = '') => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { found.push({ value: node, key }); for (const child of node) visit(child); }
            else for (const [childKey, child] of Object.entries(node)) visit(child, childKey);
        };
        visit(item); return found;
    };
    const strings = item => {
        const found = [];
        const visit = node => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { for (const child of node) visit(child); return; }
            for (const [key, child] of Object.entries(node)) {
                if (typeof child === 'string' && key !== 'code' && key !== 'status') found.push({ node, key, child });
                else visit(child);
            }
        };
        visit(item); return found;
    };
    const removeOptional = item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const priority = ['consequences','metrics','issues','editableRoots','takes','candidates','items','values','designs','planning','urbanRules','goal','title','message','next','ref','afterCid','beforeCid','overlapM2','areaM2','city','parcelSourceId','point','bbox'];
        for (const key of priority) if (Object.hasOwn(item, key)) { delete item[key]; return true; }
        for (const child of Object.values(item)) if (removeOptional(child)) return true;
        return false;
    };
    while (byteLength(out) > LIMIT) {
        const list = arrays(out).filter(({ value, key }) => value.length > (['changes','conflicts'].includes(key) ? 1 : 0)).sort((a, b) => b.value.length - a.value.length);
        if (list.length) { list[0].value.pop(); continue; }
        const long = strings(out).sort((a, b) => Array.from(b.child).length - Array.from(a.child).length)[0];
        if (long && Array.from(long.child).length > 12) {
            const chars = Array.from(long.child); long.node[long.key] = chars.slice(0, Math.max(12, Math.floor(chars.length / 2))).join(''); continue;
        }
        if (removeOptional(out)) continue;
        break;
    }
    let text = JSON.stringify(out);
    if (Buffer.byteLength(text, 'utf8') <= LIMIT) return text;
    // Keep the stable decision facts even for a pathological payload with very large required fields.
    const tiny = { truncated: true };
    if (value.ok === false) tiny.ok = false;
    if (value.code != null) tiny.code = clip(value.code, 80);
    if (value.cid != null) tiny.cid = clip(value.cid, 300);
    if (value.placement?.status != null) tiny.placement = { status: clip(value.placement.status, 80) };
    if (Number.isFinite(value.changeCount)) tiny.changeCount = value.changeCount;
    if (Number.isFinite(value.placement?.conflictCount)) tiny.placement.conflictCount = value.placement.conflictCount;
    text = JSON.stringify(tiny);
    return Buffer.byteLength(text, 'utf8') <= LIMIT ? text : '{"truncated":true}';
}
function inspectValue(value) {
    if (value === undefined) return null;
    if (byteLength(value) <= 700) return value;
    return { truncated: true, message: 'Value is too large to include. Inspect a narrower pointer.' };
}
function withoutPlanCids(value, insidePlan = true) {
    if (Array.isArray(value)) return value.map(item => withoutPlanCids(item, false));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !(key === 'cid' && insidePlan))
        .map(([key, item]) => [key, withoutPlanCids(item, key === 'plan')]));
}
function compactObject(name, raw) {
    if (raw?.isError || raw?.ok === false) {
        const error = raw.error || payloadOf(raw);
        return { ok: false, code: clip(error.code || 'tool-error', 80), message: clip(error.untrusted?.message || error.message || 'The tool could not complete the request.', 300), next: clip(error.next?.action || error.next, 240) };
    }
    const r = payloadOf(raw);
    if (name === 'ugt_draft_plan') return {
        ok: r.ok !== false, title: prose(r, 'title') || prose(r.plan?.untrusted, 'title'),
        designCount: r.plan?.designCids?.length ?? r.designCids?.length,
        designCids: array(r.plan?.designCids || r.designCids, cid => clip(cid, 300), 30)
    };
    if (name.startsWith('ugt_draft_') || ['ugt_modify_design','ugt_edit_design'].includes(name)) {
        const design = r.untrusted?.design || r.design;
        const placement = r.placement && { status: r.placement.status, code: r.placement.code, conflictCount: r.placement.conflicts?.length || 0, conflicts: array(r.placement.conflicts, x => ({ cid: x.cid, title: prose(x, 'title', 100), goal: prose(x, 'goal', 120), overlapM2: x.overlapM2 }), 20) };
        return {
        ok: r.ok !== false && r.placement?.status !== 'refused', ...(name === 'ugt_draft_plan' ? {} : { cid: r.cid }), title: prose(r, 'title') || prose(design, 'title'), goal: prose(r, 'goal', 120) || prose(design, 'goal', 120), buildingCount: design?.geometry?.buildings?.length ?? r.buildingCount,
        takes: array(r.takes, x => typeof x === 'string' ? x : { parcelId: x.parcelId, areaM2: x.areaM2 }, 20), takeCount: r.takes?.length,
        placement,
        consequences: r.consequences && { removed: array(r.consequences.removed, x => ({ cid: x.cid, title: prose(x, 'title', 100) }), 20), junctions: array(r.consequences.junctions, x => ({ title: prose(x, 'title', 100) }), 20), cuts: r.consequences.cuts }
    };
    }
    if (name === 'ugt_edit_plan') return { ok: r.ok !== false, code: r.code, title: prose(r, 'title') || prose(r.untrusted, 'title'), designCount: r.untrusted?.plan?.designCids?.length ?? r.plan?.designCids?.length, changeCount: r.changes?.length, changes: array(r.changes, refFree, 30), consequences: refFree(r.consequences) };
    if (name === 'ugt_inspect_plan') return { ok: r.ok !== false, title: prose(r, 'title'), total: r.total, truncated: r.truncated, items: array(r.items, refFree, 50) };
    if (name === 'ugt_inspect_design') return { ok: r.ok !== false, values: array(r.values, row => ({ path: row.path, value: inspectValue(row.untrustedValue) }), 50), editableRoots: array(r.editableRoots, x => x, 50) };
    if (name === 'ugt_validate_plan') return { ok: r.ok !== false, valid: r.valid, issues: array(r.issues, refFree, 50), metrics: refFree(r.metrics) };
    if (name === 'ugt_get_plan') {
        const compact = withoutPlanCids(refFree(r));
        if (r.designs) compact.designs = array(r.designs, x => ({ cid: x.cid, title: prose(x, 'title'), goal: prose(x, 'goal') }), 30);
        return compact;
    }
    if (name === 'ugt_find_place') return { ok: r.ok !== false, partial: r.partial === true, truncated: r.truncated === true, noMatch: r.noMatch, warnings: array(r.warnings, x => clip(x, 200), 5), candidates: array(r.candidates, x => ({ kind: x.kind, title: prose(x, 'title', 140), city: prose(x, 'city', 100), parcelIds: array(x.parcelIds, p => clip(p, 100), 30), parcelSourceId: prose(x, 'parcelSourceId', 200), point: x.point, bbox: x.bbox }), 30) };
    if (name === 'ugt_parcel_context') return { ok: r.ok !== false, parcelSourceId: r.parcelSourceId, areaM2: r.areaM2, designs: array(r.designs, x => ({ cid: x.cid, title: prose(x, 'title', 120), goal: prose(x, 'goal', 120) }), 30), buildings: r.buildings && { count: r.buildings.count }, planning: array(r.planning?.sources, refFree, 20), urbanRules: clip(JSON.stringify(r.urbanRules || ''), 1000) };
    if (name === 'ugt_explain' || name === 'ugt_help') return { text: clip((r.untrusted?.text || r.instructions || r.text || r.entries?.join?.('') || r.markdown || ''), LIMIT - 100) };
    return refFree(r);
}
export function compactForModel(name, result) { return bounded(compactObject(name, result)); }
export function summarizeStep(name, args, result) {
    const r = payloadOf(result), title = prose(r, 'title') || prose(r.untrusted?.design, 'title') || prose(r.plan?.untrusted, 'title') || args?.title;
    const status = result?.isError || r.ok === false || r.placement?.status === 'refused' ? `failed (${r.code || r.placement?.code || result?.error?.code || 'placement-refused'})` : 'completed';
    return clip(`${name.replace(/^ugt_/, '').replaceAll('_', ' ')} ${status}${title ? `: ${title}` : ''}`, 240);
}
export function planFromResult(name, result) {
    if (!['ugt_draft_road','ugt_draft_building','ugt_draft_track','ugt_draft_station','ugt_draft_space','ugt_draft_parcel_layout','ugt_draft_urban_rule','ugt_modify_design','ugt_edit_design','ugt_edit_plan','ugt_draft_plan','ugt_get_plan'].includes(name)) return null;
    const r = payloadOf(result);
    if (result?.isError || r.ok === false || r.placement?.status === 'refused') return null;
    const placed = ['ugt_draft_road','ugt_draft_building','ugt_draft_track','ugt_draft_station','ugt_draft_space','ugt_draft_parcel_layout','ugt_draft_urban_rule','ugt_modify_design','ugt_edit_design'].includes(name);
    const plan = placed ? r.plan : (r.plan || r);
    const draftRef = plan?.draftRef || (!placed ? r.draftRef : null);
    if (!draftRef) return null;
    const clean = compactObject(name, result);
    return { draftRef, cid: plan.cid || r.cid, ...(clean.changes ? { changes: clean.changes } : {}), ...(clean.consequences ? { consequences: clean.consequences } : {}), ...(clean.placement ? { placement: clean.placement } : {}) };
}
