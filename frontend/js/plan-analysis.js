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
    // A replay refusal told in the plan's terms. The private fabric names the piece it refused
    // (`<root parcel>#<design cid>-<plot>`) and the vertex that lies outside the piece's declared
    // parcels; here that becomes the member's title, the plot number and the parcel under the
    // vertex (inside(vertex, feature) decides) among the parcels the plan was read with, with
    // what to do about it. Any other error passes through unchanged.
    function explainRefusal(error, designs, cadastralFeatures, inside = null) {
        if (error?.code !== 'live-fabric-replacement-outside' || !Array.isArray(error.vertex)) return error;
        const match = /#(.+)-(\d+)$/.exec(String(error.parcelId || ''));
        const member = match ? (designs || []).find(design => String(design.cid) === match[1]) : null;
        const title = member?.content?.title || (match ? match[1] : 'a design');
        const plot = match ? `plot ${match[2]}` : 'a piece';
        const idOf = feature => String(feature?.properties?.parcelId ?? feature?.id ?? '');
        const host = typeof inside === 'function'
            ? (cadastralFeatures || []).find(feature => { try { return inside(error.vertex, feature); } catch (_) { return false; } }) : null;
        const declared = (member?.parcelIds || []).map(String);
        let message;
        if (host && declared.includes(idOf(host))) {
            message = `"${title}": ${plot} lies in its declared parcel ${idOf(host)}, but the plan replay did not form it there.`;
        } else if (host) {
            message = `"${title}": ${plot} reaches parcel ${idOf(host)}, which the design does not declare (its parcels: ${declared.join(', ') || 'none'}). Save the design again over every parcel its plots stand on.`;
        } else {
            message = `"${title}": ${plot} reaches ground outside the parcels the plan was read with (${declared.join(', ') || 'none'}). Save the design again over every parcel its plots stand on.`;
        }
        const explained = new Error(message);
        explained.code = error.code;
        explained.parcelId = error.parcelId;
        explained.vertex = error.vertex;
        explained.designCid = member ? String(member.cid) : null;
        explained.cause = error;
        return explained;
    }

    async function prepare(plan, { resolve, bind, parcels, materialize, declared = () => null, inside = null }) {
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
        let result;
        try { result = await materialize({ designs, parcels: cadastralFeatures }); }
        catch (error) { throw explainRefusal(error, designs, cadastralFeatures, inside); }
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
            inside: (vertex, feature) => win.turf.booleanPointInPolygon(vertex, feature),
            declared: cid => {
                const record = win.proposalStorage.getAllProposals().find(row => {
                    try { return win.DesignRecord.cidOf(row) === cid; } catch (_) { return false; }
                });
                return record && Array.isArray(record.cadastreParcelIds) ? record.cadastreParcelIds : null;
            }
        }) };
    }
    return { prepare, explainRefusal, browser };
});
