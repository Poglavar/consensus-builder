// Read an exact plan revision and derive its ground without touching the displayed composition.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanAnalysis = api.browser(root);
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    async function prepare(plan, { resolve, bind, parcels, materialize }) {
        const snapshot = await resolve(plan);
        const designs = [];
        const sources = new Map();
        for (const member of snapshot.designs) {
            const binding = await bind(member.content, snapshot.designSources?.[member.cid]);
            if (!binding || binding.coverage === 'unknown' || binding.unknownM2 > 0) throw new Error('Parcel coverage is unavailable.');
            const ids = binding.parcels.map(p => String(p.parcelId));
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
        return { plan: snapshot, records: result.records, cadastralFeatures,
            materializedFeatures: result.fabric.entriesForCadastre(ids, { includeCorridors: false }) };
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
            materialize: args => win.AgreementHeadless.materialize(args)
        }) };
    }
    return { prepare, browser };
});
