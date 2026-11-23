// Read an exact plan revision and derive its ground without touching the displayed composition, so
// a plan's figures need no apply and two plans can be compared while neither is on the map.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanAnalysis = api.browser(root);
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    const draftLink = () => (typeof window !== 'undefined' && window.DraftLink) || require('./draft-link.js');
    // The parcel sources this API holds itself, by the route that serves their parcels: the Croatian
    // cadastre and the imported cities. Every other source is a provider's own service.
    const SERVER_SOURCES = Object.freeze({ 'hr-cadastre': '/parcels', 'oss-wfs': '/parcels',
        'parcel-ba': '/parcel-ba', 'parcel-bg': '/parcel-bg', 'parcel-lj': '/parcel-lj', 'parcel-nyc': '/parcel-nyc' });
    const onServer = sourceId => !sourceId || sourceId === 'none' || Object.hasOwn(SERVER_SOURCES, sourceId);
    // Bindings asked of the API at once, each a request of its own (draft-link.js mapLimit).
    const SERVER_BIND_CONCURRENCY = 6;

    // The members' bindings, in member order. A provider's source is read ONCE for all the members
    // it binds, in the visitor's browser (bindInBrowser(sourceId, members) → bindings), as the map
    // reads parcels: one reading instead of one per design (a 113-design plan made 113, 40 s of a
    // 41 s read), and a source that answers only its own country's visitors binds too. A source this
    // API holds, or none, is bound here per member (bindOnServer(member, sourceId)), a few at a time.
    // members: [{ content, source }] where source is the plan's recorded source for that member.
    async function bindMembers(members, { sourceOf, bindOnServer, bindInBrowser, signal, onProgress }) {
        const bindings = new Array(members.length);
        const server = [], groups = new Map();
        let done = 0;
        const report = () => onProgress?.({ done, total: members.length });
        members.forEach((member, index) => {
            const sourceId = sourceOf(member);
            if (onServer(sourceId)) { server.push({ index, sourceId }); return; }
            const key = JSON.stringify([sourceId, member.content.city, member.source?.snapshotId]);
            if (!groups.has(key)) groups.set(key, { sourceId, indexes: [] });
            groups.get(key).indexes.push(index);
        });
        report();
        await Promise.all([
            draftLink().mapLimit(server, SERVER_BIND_CONCURRENCY, async ({ index, sourceId }) => {
                signal?.throwIfAborted();
                bindings[index] = await bindOnServer(members[index], sourceId);
                signal?.throwIfAborted();
                done++; report();
            }),
            draftLink().mapLimit([...groups.values()], 2, async ({ sourceId, indexes }) => {
                signal?.throwIfAborted();
                const results = await bindInBrowser(sourceId, indexes.map(index => members[index]));
                signal?.throwIfAborted();
                if (!Array.isArray(results) || results.length !== indexes.length) throw new Error('Parcel coverage is unavailable.');
                indexes.forEach((index, position) => { bindings[index] = results[position]; });
                done += indexes.length; report();
            })
        ]);
        return bindings;
    }
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

    async function prepare(plan, { resolve, bindAll, parcels, materialize, declared = () => null, inside = null, siteOf, unite, signal, onProgress }) {
        const snapshot = await resolve(plan);
        const designs = [];
        const sources = new Map();
        signal?.throwIfAborted();
        const bindings = await bindAll(snapshot.designs.map(member => ({ ...member, source: snapshot.designSources?.[member.cid] })), { signal, onProgress });
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
            const received = new Set(features.map(f => String(f.properties?.parcelId ?? f.id)));
            if ([...ids].some(id => !received.has(id))) throw new Error('Some source parcels could not be loaded.');
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
        const landFeature = await planLand(designs, cadastralFeatures, { siteOf, unite });
        return { plan: snapshot, records: result.records, cadastralFeatures, materializedFeatures, corridorFeatures, landFeature };
    }
    function browser(win) {
        async function request(path, body, signal) {
            const timeout = AbortSignal.timeout(120000);
            const response = await win.fetch(win.DesignSync.apiBase() + path, {
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout, cache: 'no-store',
                ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
            });
            const answer = await response.json();
            if (!response.ok) throw new Error(answer.error || `HTTP ${response.status}`);
            return answer;
        }
        const sourceOf = ({ content, source }) => source?.sourceId || win.DesignSync.parcelSourceIdOf(content.city, win.__siteBinding.siteOf(content));
        const siteFor = content => win.__siteBinding.siteOf(content, { turf: win.turf });
        function bind(members, { signal, onProgress } = {}) {
            return bindMembers(members, {
                sourceOf, signal, onProgress,
                bindOnServer: async ({ content }, sourceId) => (await request('/designs/binding', {
                    city: content.city, site: siteFor(content), toleranceM: content.toleranceM,
                    parcelSourceId: sourceId === 'hr-cadastre' ? 'oss-wfs' : sourceId
                }, signal)).binding,
                bindInBrowser: async (sourceId, group) => (await win.BrowserParcelSources.bindSites(sourceId,
                    group.map(({ content }) => ({ site: siteFor(content), toleranceM: content.toleranceM ?? 0 })),
                    { city: group[0].content.city, signal })).map(answer => answer.binding)
            });
        }
        async function bindPrivateRows(members, options) {
            const bindings = await bind(members, options);
            return new Map(members.map((member, index) => [member.cid, { cid: member.cid, content: member.content,
                city: member.content.city, parcelSourceId: sourceOf(member), binding: bindings[index] }]));
        }
        async function parcels(source, ids, city, signal) {
            const path = SERVER_SOURCES[source];
            const provider = win.CityConfigManager?.getCityConfig?.(city)?.parcels;
            // Database import routes take one ID, /parcels and adapter queryIds accept a batch.
            const size = path === '/parcels' ? 50 : path ? 1 : Math.min(50, Math.max(1, provider?.idBatchSize || 50));
            const batches = [];
            for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
            const results = await draftLink().mapLimit(batches, path ? SERVER_BIND_CONCURRENCY : 2, async batch => {
                signal?.throwIfAborted();
                const answer = path
                    ? await request(`${path}?${new URLSearchParams({ [source === 'parcel-ba' ? 'smp' : 'parcel_id']: batch.join(',') })}`, undefined, signal)
                    : await win.BrowserParcelSources.queryIds(source, batch, { city, signal });
                if (answer.truncated || (!path && answer.complete !== true)) throw new Error('Parcel coverage is incomplete.');
                return answer.features;
            });
            return results.flat();
        }
        const completed = new Map();
        async function preparePlan(plan, { signal, onProgress } = {}) {
            signal?.throwIfAborted();
            const snapshot = await win.PlanWorkspace.resolve(plan);
            signal?.throwIfAborted();
            const members = snapshot.designs.map(member => ({ ...member, source: snapshot.designSources?.[member.cid] }));
            const index = win.DesignSync.localDesignIndex();
            const key = JSON.stringify([win.DesignSync.apiBase(), snapshot.cid, index.revision,
                members.map(member => [member.cid, sourceOf(member), member.source?.snapshotId])]);
            const hit = completed.get(key);
            if (hit && Date.now() - hit.at < 15000) return hit.value;
            const value = await prepare(snapshot, {
                resolve: row => row, signal, onProgress, bindAll: bind,
                parcels: (source, ids) => parcels(source, ids, snapshot.content.view?.city, signal),
                siteOf: siteFor,
                unite: async features => {
                    let union = features[0], slice = Date.now();
                    for (let i = 1; i < features.length; i++) {
                        signal?.throwIfAborted();
                        if (Date.now() - slice >= 8) { await new Promise(resolve => setTimeout(resolve, 0)); slice = Date.now(); }
                        union = win.__parcelArrangement.clipWith(win.turf, 'union', union, features[i], { site: 'plan-land' });
                    }
                    return union;
                },
                materialize: args => win.AgreementHeadless.materialize({ ...args, signal }),
                inside: (vertex, feature) => win.turf.booleanPointInPolygon(vertex, feature),
                declared: cid => localDeclaration(index.byCid.get(cid), cid)
            });
            signal?.throwIfAborted();
            completed.set(key, { at: Date.now(), value });
            if (completed.size > 8) completed.delete(completed.keys().next().value);
            return value;
        }
        return { prepare: preparePlan, bindPrivateRows };
    }
    function localDeclaration(record, cid) {
        if (!Array.isArray(record?.cadastreParcelIds)) return null;
        if (!record.cadastreParcelIds.length && !record.binding && record.planFileUnboundCid === cid) return null;
        return record.cadastreParcelIds;
    }
    return { prepare, planLand, explainRefusal, bindMembers, localDeclaration, browser };
});
