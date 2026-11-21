// Read an exact plan revision and derive its ground without touching the displayed composition, so
// a plan's figures need no apply and two plans can be compared while neither is on the map.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanAnalysis = api.browser(root);
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    // Members' bindings are asked for a few at a time (draft-link.js mapLimit): one after another, a
    // 113-design plan spent 40 s of a 41 s read waiting on 113 binding round trips.
    const draftLink = () => (typeof window !== 'undefined' && window.DraftLink) || require('./draft-link.js');
    const BIND_CONCURRENCY = 6;
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

    // The plan's land: the ground its designs take, each design's site (siteOf: site-binding.js, the
    // ground its binding is computed on), and for a parcel act with no site of its own its declared
    // parcels. Its figures are measured over this land, not over every parcel the designs stand on:
    // a park in one corner of a large parcel covers the park, not the parcel. unite(features) → one
    // Feature or null.
    function planLand(designs, cadastralFeatures, { siteOf, unite }) {
        const parcelById = new Map(cadastralFeatures.map(f => [String(f.properties?.parcelId ?? f.id), f]));
        const shapes = [];
        designs.forEach(design => {
            const site = siteOf(design.content);
            if (site) shapes.push({ type: 'Feature', properties: {}, geometry: site });
            else design.parcelIds.forEach(id => { if (parcelById.has(id)) shapes.push(parcelById.get(id)); });
        });
        return shapes.length ? unite(shapes) : null;
    }

    async function prepare(plan, { resolve, bind, parcels, materialize, declared = () => null, inside = null, siteOf, unite }) {
        const snapshot = await resolve(plan);
        const designs = [];
        const sources = new Map();
        const bindings = await draftLink().mapLimit(snapshot.designs, BIND_CONCURRENCY,
            member => bind(member.content, snapshot.designSources?.[member.cid]));
        for (const [index, member] of snapshot.designs.entries()) {
            const binding = bindings[index];
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
        const landFeature = planLand(designs, cadastralFeatures, { siteOf, unite });
        return { plan: snapshot, records: result.records, cadastralFeatures, materializedFeatures, corridorFeatures, landFeature };
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
        // One answer per binding request for the page: Plan stats, Compare and Compare plans read the
        // same members again, and two plans often share their streets and parks. A failed one is asked again.
        const bindings = new Map();
        return { prepare: plan => prepare(plan, {
            resolve: row => win.PlanWorkspace.resolve(row),
            bind: (content, source) => {
                const site = win.__siteBinding.siteOf(content);
                const sourceId = source?.sourceId || win.DesignSync.parcelSourceIdOf(content.city, site);
                const body = { city: content.city, site, toleranceM: content.toleranceM,
                    parcelSourceId: sourceId === 'hr-cadastre' ? 'oss-wfs' : sourceId };
                const key = JSON.stringify(body);
                if (!bindings.has(key)) {
                    bindings.set(key, request('/designs/binding', body).then(answer => answer.binding, error => {
                        bindings.delete(key);
                        throw error;
                    }));
                }
                return bindings.get(key);
            },
            parcels,
            siteOf: content => win.__siteBinding.siteOf(content),
            // The shared clip (parcel-arrangement.js clipWith), on the grid every stage uses.
            unite: features => features.slice(1).reduce((sum, feature) =>
                win.__parcelArrangement.clipWith(win.turf, 'union', sum, feature, { site: 'plan-land' }), features[0]),
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
    return { prepare, planLand, explainRefusal, browser };
});
