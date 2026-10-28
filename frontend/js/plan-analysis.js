// Read an exact plan revision and derive its ground without touching the displayed composition, so
// a plan's figures need no apply and two plans can be compared while neither is on the map.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanAnalysis = api.browser(root);
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    // declared(cid): the parcel ids of this device's copy of a member, or null. That copy's own
    // declaration is what applying it on the map uses; a design not yet published has never been
    // checked against its binding, which can name fewer parcels than its pieces stand on.
    async function prepare(plan, { resolve, bind, parcels, materialize, declared = () => null }) {
        const snapshot = await resolve(plan);
        const designs = [];
        const sources = new Map();
        for (const member of snapshot.designs) {
            const binding = await bind(member.content, snapshot.designSources?.[member.cid]);
            if (!binding || binding.coverage === 'unknown' || binding.unknownM2 > 0) throw new Error('Parcel coverage is unavailable.');
            const own = declared(member.cid);
            const ids = Array.isArray(own) ? [...new Set(own.map(String))].sort() : binding.parcels.map(p => String(p.parcelId));
            if (ids.length) {
                const source = binding.parcelSource?.sourceId;
                if (!source) throw new Error('Parcel source is unavailable.');
                if (!sources.has(source)) sources.set(source, new Set());
                ids.forEach(id => sources.get(source).add(id));
            }
            designs.push({ ...member, binding, parcelIds: ids });
        }
        const cadastralFeatures = [];
        for (const [source, ids] of sources) {
            const features = await parcels(source, [...ids]);
            if ([...ids].some(id => !features.some(f => String(f.properties?.parcelId ?? f.id) === id))) throw new Error('Some source parcels could not be loaded.');
            cadastralFeatures.push(...features.filter(f => ids.has(String(f.properties?.parcelId ?? f.id))));
        }
        const result = await materialize({ designs, parcels: cadastralFeatures });
        const ids = [...sources.values()].flatMap(ids => [...ids]);
        const materializedFeatures = result.fabric.entriesForCadastre(ids, { includeCorridors: false });
        // Road corridor pieces apart: they are land too (public land in Compare plans), but not parcels.
        const pieceIds = new Set(materializedFeatures.map(f => String(f.properties?.parcelId ?? f.id)));
        const corridorFeatures = result.fabric.entriesForCadastre(ids, { includeCorridors: true })
            .filter(f => !pieceIds.has(String(f.properties?.parcelId ?? f.id)));
        return { plan: snapshot, records: result.records, cadastralFeatures, materializedFeatures, corridorFeatures };
    }
    function browser(win) {
        async function request(path, body) {
            const response = await win.fetch(win.DesignSync.apiBase() + path, {
                signal: AbortSignal.timeout(120000), cache: 'no-store',
                ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
            });
            const answer = await response.json();
            if (!response.ok) throw new Error(answer.error || `HTTP ${response.status}`);
            return answer;
        }
        async function parcels(source, ids) {
            const paths = { 'hr-cadastre': '/parcels', 'oss-wfs': '/parcels',
                'parcel-ba': '/parcel-ba', 'parcel-bg': '/parcel-bg', 'parcel-lj': '/parcel-lj', 'parcel-nyc': '/parcel-nyc' };
            const features = [];
            // Bound the request size; imported database sources accept one identity per query.
            const size = paths[source] === '/parcels' ? 50 : 1;
            for (let i = 0; i < ids.length; i += size) {
                const batch = ids.slice(i, i + size);
                const answer = paths[source]
                    ? await request(`${paths[source]}?${new URLSearchParams({ [source === 'parcel-ba' ? 'smp' : 'parcel_id']: batch.join(',') })}`)
                    : await win.BrowserParcelSources.queryIds(source, batch);
                if (answer.truncated || (!paths[source] && answer.complete !== true)) throw new Error('Parcel coverage is incomplete.');
                features.push(...answer.features);
            }
            return features;
        }
        return { prepare: plan => prepare(plan, {
            resolve: row => win.PlanWorkspace.resolve(row),
            bind: async (content, source) => {
                const site = win.__siteBinding.siteOf(content);
                const sourceId = source?.sourceId || win.DesignSync.parcelSourceIdOf(content.city, site);
                const answer = await request('/designs/binding', { city: content.city, site, toleranceM: content.toleranceM,
                    parcelSourceId: sourceId === 'hr-cadastre' ? 'oss-wfs' : sourceId });
                return answer.binding;
            },
            parcels,
            materialize: args => win.AgreementHeadless.materialize(args),
            declared: cid => {
                const record = win.proposalStorage.getAllProposals().find(row => {
                    try { return win.DesignRecord.cidOf(row) === cid; } catch (_) { return false; }
                });
                return record && Array.isArray(record.cadastreParcelIds) ? record.cadastreParcelIds : null;
            }
        }) };
    }
    return { prepare, browser };
});
