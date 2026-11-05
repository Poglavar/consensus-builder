// The `floor-plan-publication` building-details adapter: reads the published floor plans of native
// buildings from a floor-plan publication API (GET <baseUrl>/floor-plans, filtered by qualified native
// building ids) and converts each building's plans into one X-ray floor model. City-neutral: the city's
// configuration names the publication's city/source namespace; the server names the base URL.
import { publishedPlansToFloorModel } from './published-floor-model.js';

const BATCH = 200;           // the publication's nativeBuildingIds limit
const PAGE = 100;            // the publication's page limit
const MAX_PAGES = 50;        // 5000 plans for one batch of buildings is not a map cell
const CONCURRENCY = 3;
const TIMEOUT_MS = 8000;
const TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 4000;
// Shared by every reader of the process: a building's answer (a model, or none) for TTL_MS.
const sharedCache = new Map();

const stamp = () => new Date().toISOString();
const text = (value, max = 255) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max;

export function validatePublicationConfig(config) {
    for (const key of Object.keys(config || {})) {
        if (!['id', 'baseUrl', 'city', 'source', 'buildingSource', 'buildingIds'].includes(key)) {
            throw new Error(`floor-plan-publication: unknown setting ${key}.`);
        }
    }
    for (const key of ['city', 'source', 'buildingSource']) {
        if (!text(config?.[key], 100)) throw new Error(`floor-plan-publication: ${key} must be a non-empty string.`);
    }
    if (config.buildingIds !== undefined && (!Array.isArray(config.buildingIds) || !config.buildingIds.length || config.buildingIds.length > 20
        || config.buildingIds.some(rule => !text(rule?.match) || typeof rule.ref !== 'string' || !rule.ref || Object.keys(rule).length !== 2))) {
        throw new Error('floor-plan-publication: buildingIds must be a list of { match, ref } rules.');
    }
    for (const rule of config.buildingIds || []) new RegExp(rule.match); // an invalid pattern fails here, at registration
    let url;
    try { url = new URL(config.baseUrl); } catch { url = null; }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('floor-plan-publication: baseUrl must be a plain http(s) URL.');
    }
}

async function inBatches(items, limit, worker) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) await worker(items[next++]);
    }));
}

// A native id as the publication writes it. Without rules the ids are the same; with rules
// ({ match: regex, ref: replacement }, first match wins) an id no rule matches has no reference.
function refIdTranslator(rules) {
    if (!rules) return id => id;
    const compiled = rules.map(rule => ({ pattern: new RegExp(rule.match), ref: rule.ref }));
    return id => { const rule = compiled.find(entry => entry.pattern.test(id)); return rule ? id.replace(rule.pattern, rule.ref) : null; };
}

/**
 * @param config { baseUrl, city, source, buildingSource, buildingIds? }: `buildingSource` is the app's
 *   native building source key (floorModelSource) whose records' ids are the publication's `source`
 *   ids, translated by `buildingIds` rules where the two spell an id differently
 * @param context { fetch, cache, now, log } — injected in tests
 * @returns { fetchFloorModels(identities, report?) → Map(buildingId → row) }
 */
export function createFloorPlanPublicationReader(config, { fetch = globalThis.fetch, cache = sharedCache, now = Date.now,
    log = (...args) => console.error(...args), timeoutMs = TIMEOUT_MS } = {}) {
    validatePublicationConfig(config);
    const base = config.baseUrl.replace(/\/+$/, '');
    const cacheKey = id => JSON.stringify([base, config.city, config.source, id]);
    const publicationUrl = planId => `${base}/floor-plans/${encodeURIComponent(planId)}`;
    const toRef = refIdTranslator(config.buildingIds);

    async function plansFor(ids) {
        const plans = [];
        for (let page = 0, offset = 0; ; page++) {
            if (page >= MAX_PAGES) throw new Error(`more than ${MAX_PAGES * PAGE} plans for ${ids.length} buildings`);
            const params = new URLSearchParams({ city: config.city, source: config.source, limit: String(PAGE), offset: String(offset) });
            params.set(ids.length === 1 ? 'nativeBuildingId' : 'nativeBuildingIds', ids.join(','));
            const response = await fetch(`${base}/floor-plans?${params}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            if (!Array.isArray(body?.plans) || typeof body.hasMore !== 'boolean') throw new Error('answer is not a floor-plan page');
            plans.push(...body.plans);
            if (!body.hasMore || !body.plans.length) return plans;
            offset += body.plans.length;
        }
    }

    function rowsFor(ids, plans) {
        const wanted = new Set(ids), byBuilding = new Map(ids.map(id => [id, []]));
        for (const plan of plans) {
            for (const ref of Array.isArray(plan?.buildingRefs) ? plan.buildingRefs : []) {
                if (ref?.city === config.city && ref.source === config.source && (ref.ownerId ?? '') === '' && wanted.has(ref.buildingId)) {
                    byBuilding.get(ref.buildingId).push(plan);
                }
            }
        }
        const rows = new Map();
        for (const [id, list] of byBuilding) {
            let row = null;
            if (list.length) {
                try {
                    const model = publishedPlansToFloorModel(list, { publicationUrl });
                    if (model) row = { floorPlans: model.floorPlans, footprint: model.footprint, updatedAt: model.updatedAt,
                        publication: { baseUrl: base, city: config.city, source: config.source, buildingId: id, planIds: model.planIds } };
                } catch (error) {
                    log(`[${stamp()}] [floor-plan-publication] ${config.city}/${config.source} building ${id}: ${list.length} plans not shown: ${error.message}`);
                }
            }
            rows.set(id, row);
        }
        return rows;
    }

    async function fetchFloorModels(identities, report = {}) {
        // ref id (as published) → the native ids it answers
        const natives = new Map();
        for (const identity of identities) {
            if (identity?.source !== config.buildingSource || (identity.ownerId ?? '') !== '') continue;
            const native = String(identity.buildingId), ref = text(native) ? toRef(native) : null;
            if (!text(ref)) continue;
            if (!natives.has(ref)) natives.set(ref, new Set());
            natives.get(ref).add(native);
        }
        const result = new Map(), pending = [];
        const answer = (ref, row) => { if (row) for (const native of natives.get(ref)) result.set(native, row); };
        for (const ref of natives.keys()) {
            const hit = cache.get(cacheKey(ref));
            if (hit && hit.expires > now()) answer(ref, hit.row);
            else pending.push(ref);
        }
        // A comma would split an id inside nativeBuildingIds; such ids are asked for one by one.
        const listable = pending.filter(id => !id.includes(','));
        const batches = [...Array.from({ length: Math.ceil(listable.length / BATCH) }, (_, i) => listable.slice(i * BATCH, (i + 1) * BATCH)),
            ...pending.filter(id => id.includes(',')).map(id => [id])];
        await inBatches(batches, CONCURRENCY, async batch => {
            let rows;
            try { rows = rowsFor(batch, await plansFor(batch)); } catch (error) {
                // Never cached: the next read asks again. The caller answers without published plans.
                report.publishedUnavailable = true;
                log(`[${stamp()}] [floor-plan-publication] ${base} ${config.city}/${config.source}: ${batch.length} buildings without published plans: ${error.message}`);
                return;
            }
            for (const [id, row] of rows) {
                if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
                cache.set(cacheKey(id), { expires: now() + TTL_MS, row });
                answer(id, row);
            }
        });
        return result;
    }
    return { fetchFloorModels };
}
