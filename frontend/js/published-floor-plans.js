// Adapt the shared public plan contract for the archive viewer without importing collector models.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.__publishedFloorPlans = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const API_ROOT = 'https://zagreb.lol/api';
    const PAGE_SIZE = 100, MAX_PAGES = 100;
    const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const number = value => typeof value === 'number' && Number.isFinite(value);
    const httpUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } };
    function locationView(value) {
        return number(value?.lng) && number(value?.lat) && Math.abs(value.lng) <= 180 && Math.abs(value.lat) <= 90
            ? { longitude: value.lng, latitude: value.lat, basis: 'published-source' } : null;
    }
    function planView(plan, apiRoot = API_ROOT) {
        if (!plan || typeof plan.id !== 'string' || !['unit', 'floor'].includes(plan.scope) || !hash(plan.source?.sha256)) throw new Error('Invalid published floor plan');
        const source = plan.source;
        return {
            id: plan.id, externalId: plan.externalId || null, label: plan.label || plan.unitId || plan.id, scope: plan.scope,
            level: Number.isInteger(plan.floor) ? plan.floor : null, levels: plan.levels || [],
            architecture: plan.architecture || null, rooms: (plan.roomSchedule || []).map(room => ({ name: room.name || room.label || room.id || '', areaM2: number(room.areaM2) ? room.areaM2 : null })),
            physicalNetAreaM2: number(plan.physicalNetAreaM2) ? plan.physicalNetAreaM2 : null,
            areaM2: number(plan.marketedAreaM2) ? plan.marketedAreaM2 : number(plan.areaM2) ? plan.areaM2 : null,
            source: { url: httpUrl(source.url), listingUrl: httpUrl(source.listingUrl), urls: (source.urls || []).map(httpUrl).filter(Boolean),
                page: Number.isInteger(source.page) && source.page > 0 ? source.page : null, label: source.label || null, attribution: source.attribution || null },
            sourceAssetUrl: `${apiRoot.replace(/\/$/, '')}/floor-plans/sources/${source.sha256}`,
            mediaType: source.mediaType || null, reviewStatus: plan.quality?.status || 'source', reviewNotes: plan.quality?.issues || [],
            placement: plan.placement || null,
        };
    }
    function catalogueView(publishedPlans, { apiRoot = API_ROOT } = {}) {
        const groups = new Map(), seen = new Set();
        let floors = 0, units = 0;
        for (const plan of publishedPlans) {
            if (seen.has(plan.id)) throw new Error('Duplicate published floor-plan identity');
            seen.add(plan.id);
            const view = planView(plan, apiRoot), metadata = plan.building;
            // A source with unknown building identity is its own group; never merge all unknowns.
            const id = plan.buildingId ? `published:${plan.buildingId}` : `plan:${plan.id}`;
            let group = groups.get(id);
            if (!group) {
                group = { id, publicationBuildingId: plan.buildingId || null,
                    name: metadata?.label || metadata?.name || plan.label || plan.id,
                    kind: 'published', location: locationView(metadata?.location ?? plan.location), footprint: metadata?.footprint || null,
                    wholeBuilding: null, planCount: 0, plans: [], locationAvailable: false, wholeBuildingAvailable: false };
                groups.set(id, group);
            }
            group.plans.push(view);group.planCount++;
            if (plan.scope === 'floor') floors++; else units++;
            group.locationAvailable = Boolean(group.location);
        }
        return { buildings: [...groups.values()], counts: { buildings: groups.size, floors, units } };
    }
    async function readCatalogue(fetchJson, { apiRoot = API_ROOT, maxPages = MAX_PAGES } = {}) {
        if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) throw new Error('Invalid publication page limit');
        const plans = [];
        for (let page = 0; page < maxPages; page++) {
            const offset = page * PAGE_SIZE;
            const result = await fetchJson(`${apiRoot.replace(/\/$/, '')}/floor-plans?limit=${PAGE_SIZE}&offset=${offset}`);
            if (!result || !Array.isArray(result.plans) || result.plans.length > PAGE_SIZE || result.limit !== PAGE_SIZE || result.offset !== offset || typeof result.hasMore !== 'boolean'
                || (result.hasMore && result.plans.length !== PAGE_SIZE)) throw new Error('Invalid floor-plan publication page');
            plans.push(...result.plans);
            if (!result.hasMore) return catalogueView(plans, { apiRoot });
        }
        throw new Error('Floor-plan publication exceeds the viewer page limit');
    }
    return { API_ROOT, PAGE_SIZE, MAX_PAGES, locationView, planView, catalogueView, readCatalogue };
});
