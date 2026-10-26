// Portable authored plans. The envelope embeds plan/v1 and its exact design/v1 members;
// publication, agreement decisions and browser/session state have no place in this format.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanFile = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const SCHEMA = 'ugt-plan-file/v1';
    const MAX_BYTES = 32 * 1024 * 1024;
    const MAX_VERTICES = 200000;
    const MAX_NODES = 1000000;
    const MAX_DEPTH = 40;
    const api = name => root[name] || (typeof require === 'function' ? require({
        Cid: './cid.js', DesignRecord: './design-record.js', PlanRecord: './plan-record.js'
    }[name]) : null);
    const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
    const clone = value => JSON.parse(JSON.stringify(value));
    const fail = message => { throw new Error(message); };
    const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key));
    const bytes = value => new TextEncoder().encode(value).byteLength;
    const forbidden = /^(?:__proto__|prototype|constructor|password|passwd|secret|clientSecret|privateKey|apiKey|accessToken|refreshToken|editToken|authorization|cookie|session|sessionId|credentials|draftRef|previewToken|privatePreview|mnemonic|seedPhrase)$/i;

    // Bound every nested parameter, not only the visible footprint. Never evaluate imported text.
    function inspect(value) {
        let nodes = 0;
        function visit(v, depth) {
            if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('The plan file is too complex.');
            if (typeof v === 'number' && !Number.isFinite(v)) fail('Plan numbers must be finite.');
            if (v === null || typeof v === 'boolean' || typeof v === 'number') return;
            if (typeof v === 'string') {
                if (v.length > MAX_BYTES) fail('Plan files are limited to 32 MiB.');
                if (/^(?:javascript|blob):/i.test(v)) fail('Temporary or executable URLs cannot be imported.');
                if (/^(?:https?:\/\/|\/|\.\/)/i.test(v)) {
                    const url = new URL(v, 'https://portable.invalid');
                    if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|signature|credential|key|auth|^draft$/i.test(key))) {
                        fail('A plan file cannot contain credential-bearing URLs.');
                    }
                }
                return;
            }
            if (!object(v) && !Array.isArray(v)) fail('The plan must contain only JSON values.');
            for (const [key, child] of Object.entries(v)) {
                if (forbidden.test(key) || forbidden.test(key.replace(/[-_]/g, ''))) fail('A plan file contains a reserved or private field.');
                visit(child, depth + 1);
            }
        }
        visit(value, 0);
    }

    // Select geographic drawings explicitly. Floor-plan and construction-frame coordinates are
    // local metres; a recursive search for anything called "Polygon" would mislabel them as GIS.
    function geographicParts(design) {
        const parts = [];
        const add = (role, value) => {
            if (!value) return;
            if (value.type === 'FeatureCollection') {
                if (!Array.isArray(value.features)) fail('Invalid geographic feature collection.');
                value.features.forEach((feature, i) => add(`${role}/${i}`, feature));
                return;
            }
            const geometry = value.type === 'Feature' ? value.geometry : value;
            if (geometry && typeof geometry.type === 'string') parts.push({ role, geometry,
                properties: value.type === 'Feature' ? value.properties || {} : {} });
        };
        add('site', design.site);
        add('geometry', design.geometry);
        for (const key of ['landTake', 'blockMassing', 'groundSurface', 'parkGraphics', 'squareGraphics', 'lakeGraphics', 'stationGraphics']) add(key, design.geometry?.[key]);
        (design.geometry?.buildings || []).forEach((f, i) => add(`building/${i}`, f));
        const road = design.roadProposal?.definition;
        add('corridor', road?.polygon);
        (road?.features || []).forEach((f, i) => add(`corridor-feature/${i}`, f));
        add('structure', design.structureProposal?.geometry);
        (design.parcelLayout?.plots || []).forEach((p, i) => add(`plot/${i}`, p.geometry));
        const elements = road?.osm?.elements || [];
        const nodes = new Map(elements.filter(e => e.type === 'node').map(e => [e.id, [e.lon, e.lat]]));
        elements.filter(e => e.type === 'way').forEach((way, i) => {
            if (!Array.isArray(way.nodes) || way.nodes.length < 2 || way.nodes.some(id => !nodes.has(id))) fail('A corridor way is missing its nodes.');
            add(`centerline/${i}`, { type: 'LineString', coordinates: way.nodes.map(id => nodes.get(id)) });
        });
        return parts;
    }

    function geometryCheck(geometry, budget) {
        if (!object(geometry)) fail('Invalid geographic geometry.');
        const position = p => {
            if (!Array.isArray(p) || p.length < 2 || p.length > 3 || !p.every(Number.isFinite)
                || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) fail('Invalid longitude/latitude coordinate.');
            if (++budget.vertices > MAX_VERTICES) fail('The plan has too many geographic vertices.');
        };
        const line = (points, min) => {
            if (!Array.isArray(points) || points.length < min) fail('Invalid geographic line or ring.');
            points.forEach(position);
        };
        const polygon = rings => {
            if (!Array.isArray(rings) || !rings.length) fail('A polygon needs an exterior ring.');
            rings.forEach(ring => {
                line(ring, 4);
                if (JSON.stringify(ring[0]) !== JSON.stringify(ring[ring.length - 1])) fail('Polygon rings must be closed.');
            });
        };
        const list = (values, fn) => {
            if (!Array.isArray(values) || !values.length) fail('Empty geographic geometry.');
            values.forEach(fn);
        };
        switch (geometry.type) {
        case 'Point': position(geometry.coordinates); break;
        case 'MultiPoint': list(geometry.coordinates, position); break;
        case 'LineString': line(geometry.coordinates, 2); break;
        case 'MultiLineString': list(geometry.coordinates, p => line(p, 2)); break;
        case 'Polygon': polygon(geometry.coordinates); break;
        case 'MultiPolygon': list(geometry.coordinates, polygon); break;
        case 'GeometryCollection': list(geometry.geometries, g => geometryCheck(g, budget)); break;
        default: fail('Unsupported geographic geometry type.');
        }
    }

    // GLB data is retained within canonical content, so it survives a subsequent export. External
    // buffers/images in a GLB would leave a backup dependent on another server and are refused.
    function checkModel(url) {
        if (typeof url !== 'string' || !url.startsWith('data:model/gltf-binary;base64,')) fail('Models must be embedded self-contained GLB files.');
        let binary;
        try { binary = atob(url.slice(url.indexOf(',') + 1)); } catch (_) { fail('Invalid embedded GLB.'); }
        const data = Uint8Array.from(binary, c => c.charCodeAt(0));
        if (data.byteLength < 20) fail('Invalid embedded GLB.');
        const dv = new DataView(data.buffer);
        if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2
            || dv.getUint32(8, true) !== data.byteLength || dv.getUint32(16, true) !== 0x4e4f534a) fail('Invalid GLB header.');
        const length = dv.getUint32(12, true);
        if (length > data.byteLength - 20) fail('Invalid GLB JSON chunk.');
        let gltf;
        try { gltf = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(20, 20 + length))); }
        catch (_) { fail('Invalid GLB JSON chunk.'); }
        for (const entry of [...(gltf.buffers || []), ...(gltf.images || [])]) {
            if (entry.uri && !/^data:/i.test(entry.uri)) fail('The model has external buffers or images; embed them in the GLB first.');
        }
    }

    async function embedModels(value, fetchModel) {
        const cache = new Map();
        async function visit(v) {
            if (!v || typeof v !== 'object') return;
            for (const [key, child] of Object.entries(v)) {
                if (key === 'modelUrl' && child != null) {
                    if (typeof child !== 'string') fail('A model reference must be text.');
                    if (!cache.has(child)) cache.set(child, Promise.resolve(child.startsWith('data:') ? child : fetchModel(child)));
                    v[key] = await cache.get(child);
                    checkModel(v[key]);
                } else await visit(child);
            }
        }
        await visit(value);
    }

    function validate(file) {
        inspect(file);
        if (!exact(file, ['schema', 'plan', 'designs', 'designSources']) || file.schema !== SCHEMA) fail(`Expected ${SCHEMA}. Unsupported file or version.`);
        const error = api('PlanRecord').validate(file.plan);
        if (error) fail(error);
        if (!Array.isArray(file.designs) || file.designs.length !== file.plan.designCids.length) fail('Plan membership does not match the embedded designs.');
        const budget = { vertices: 0 };
        file.designs.forEach((row, i) => {
            if (!exact(row, ['cid', 'content']) || row.cid !== file.plan.designCids[i]) fail('Designs must exactly match the ordered plan membership.');
            const checked = api('DesignRecord').validate(row.content);
            if (!checked.valid) fail(checked.errors[0].message);
            if (api('Cid').cidOfObject(row.content) !== row.cid) fail('A design does not match its content CID.');
            geographicParts(row.content).forEach(p => geometryCheck(p.geometry, budget));
            function models(v) {
                if (!v || typeof v !== 'object') return;
                for (const [key, child] of Object.entries(v)) {
                    if (key === 'modelUrl' && child != null) checkModel(child);
                    else models(child);
                }
            }
            models(row.content);
        });
        if (!object(file.designSources) || Object.keys(file.designSources).some(cid => !file.plan.designCids.includes(cid))
            || Object.values(file.designSources).some(s => !exact(s, ['sourceId', 'snapshotId'])
                || typeof s.sourceId !== 'string' || !s.sourceId || s.sourceId.length > 200
                || (s.snapshotId !== null && (typeof s.snapshotId !== 'string' || s.snapshotId.length > 200)))) fail('Invalid source references.');
        return file;
    }

    function parse(text) {
        if (typeof text !== 'string' || bytes(text) > MAX_BYTES) fail('Plan files are limited to 32 MiB.');
        let file;
        try { file = JSON.parse(text); } catch (_) { fail('The file is not valid JSON.'); }
        return validate(file);
    }
    function stringify(file) {
        validate(file);
        const text = JSON.stringify(file, null, 2) + '\n';
        if (bytes(text) > MAX_BYTES) fail('Plan files are limited to 32 MiB.');
        return text;
    }

    async function create(records, { title, view, designSources = {}, fetchModel = () => fail('A model dependency could not be embedded.') } = {}) {
        if (!Array.isArray(records) || !records.length || records.length > api('PlanRecord').MAX_DESIGNS) fail('Choose between 1 and 1000 designs.');
        const rows = new Map(), sources = {};
        for (const record of records) {
            const content = api('DesignRecord').published(record);
            inspect(content);
            const originalCid = api('Cid').cidOfObject(content);
            await embedModels(content, fetchModel);
            const cid = api('Cid').cidOfObject(content);
            rows.set(cid, { cid, content });
            const source = designSources[originalCid] || record.planFileSource || record.binding?.parcelSource;
            if (source?.sourceId) sources[cid] = { sourceId: source.sourceId, snapshotId: source.snapshotId ?? null };
        }
        const cids = [...rows.keys()].sort();
        const file = { schema: SCHEMA, plan: api('PlanRecord').create(title || 'My plan', cids, view),
            designs: cids.map(cid => rows.get(cid)), designSources: sources };
        stringify(file);
        return file;
    }

    function geographicCollection(file) {
        const features = [];
        for (const { cid, content } of file.designs) {
            geographicParts(content).forEach(({ role, geometry, properties }) => {
                // Mesh data belongs in the editable file, never in a GIS attribute cell.
                const attributes = Object.fromEntries(Object.entries(properties).filter(([key, value]) => key !== 'modelUrl' && (value === null || ['string', 'number', 'boolean'].includes(typeof value))));
                features.push({ type: 'Feature', id: `${cid}/${role}`, geometry: clone(geometry),
                    properties: { ...attributes, ugt_design_cid: cid, ugt_role: role,
                        ugt_title: content.title, ugt_goal: content.goal, ugt_city: content.city } });
            });
        }
        return { type: 'FeatureCollection', name: file.plan.title,
            ugt: { schema: 'ugt-geojson/v1', planCid: api('Cid').cidOfObject(file.plan),
                coordinates: 'WGS84 longitude, latitude in degrees; any third ordinate retains its authored basis.',
                scope: 'Authored sites and geographic drawings; overlapping layers are retained. No rendered meshes or source basemap.' }, features };
    }

    function geojson(file) { validate(file); return geographicCollection(file); }
    function geojsonRecords(records, { title, view }) {
        const designs = records.map(record => {
            const content = api('DesignRecord').published(record);
            inspect(content);
            const checked = api('DesignRecord').validate(content);
            if (!checked.valid) fail(checked.errors[0].message);
            return { cid: api('Cid').cidOfObject(content), content };
        });
        const budget = { vertices: 0 };
        designs.forEach(row => geographicParts(row.content).forEach(p => geometryCheck(p.geometry, budget)));
        return geographicCollection({ plan: api('PlanRecord').create(title || 'My plan', designs.map(r => r.cid), view), designs });
    }

    // Local import is deliberately independent of publication and of the live map. Call within
    // one ProposalManager mutation; collisions never overwrite an existing local design.
    function importInto(file, store, { id = () => `file-${crypto.randomUUID()}` } = {}) {
        validate(file);
        const members = [];
        const existingByCid = new Map();
        for (const record of store.getAllProposals()) {
            try { existingByCid.set(api('DesignRecord').cidOf(record), record); } catch (_) { /* unrelated local record */ }
        }
        for (const row of file.designs) {
            const old = existingByCid.get(row.cid);
            if (old) { members.push(old.proposalId); continue; }
            const c = clone(row.content);
            let key = id();
            if (store.getProposal(key)) fail('Local identity collision; try importing again.');
            const record = { proposalId: key, goal: c.goal, title: c.title, name: c.title,
                description: c.description, author: c.author, city: c.city, site: c.site,
                toleranceM: c.toleranceM, geometry: c.geometry, origin: c.origin,
                createdAt: c.authoredAt, lifecycleStatus: 'draft', applied: false, cadastreParcelIds: [],
                ...(file.designSources[row.cid] ? { planFileSource: clone(file.designSources[row.cid]) } : {}) };
            api('DesignRecord').PAYLOAD_KEYS.forEach(key => { if (c[key]) record[key] = c[key]; });
            const stored = store.importProposal(record, { overwrite: false, deferSave: true });
            if (!stored || api('DesignRecord').cidOf(stored) !== row.cid) fail('The local store could not preserve this design; import cancelled.');
            members.push(stored.proposalId);
        }
        return { cid: api('Cid').cidOfObject(file.plan), content: clone(file.plan), memberIds: members, designSources: clone(file.designSources) };
    }
    return Object.freeze({ SCHEMA, MAX_BYTES, MAX_VERTICES, MAX_NODES, MAX_DEPTH,
        create, parse, validate, stringify, geojson, geojsonRecords, importInto, geographicParts, checkModel });
});
