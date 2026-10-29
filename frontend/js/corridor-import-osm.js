// OpenStreetMap import adapter: an .osm XML extract or an OSM-JSON document (Overpass output, our
// own record form) becomes the import form corridor-import.js turns into road records. Every way
// that carries a highway or railway tag is a stretch; ways sharing a name are one road, a nameless
// way is a road of its own. Nodes keep OSM's ids, the way id becomes the stretch id (`cb:segment`),
// and the cross-section is read from the standard tags by corridor-osm-form.js. Pure: no DOM, the
// XML parser shared with the OpenDRIVE adapter, browser global or node require.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__corridorImportOsm = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const MAX_WAYS = 500;

    function xmlParser() {
        if (global && global.__corridorImportOpenDrive) return global.__corridorImportOpenDrive.parseXml;
        if (typeof require === 'function') return require('./corridor-import-opendrive.js').parseXml;
        throw new Error('corridor-import-osm: the XML parser is not available');
    }

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const isRoadWay = way => !!(way.tags && (way.tags.highway || way.tags.railway));

    // The elements of an .osm XML document: nodes with their position and tags, ways with their
    // node references and tags. Relations and everything else are left out.
    function elementsFromXml(text) {
        const osm = xmlParser()(text); // the root element
        if (!osm || osm.name !== 'osm') throw new Error('OSM: no <osm> root element');
        const tagsOf = element => Object.fromEntries(element.children
            .filter(child => child.name === 'tag' && child.attrs.k !== undefined)
            .map(child => [child.attrs.k, child.attrs.v === undefined ? '' : child.attrs.v]));
        const elements = [];
        osm.children.forEach(child => {
            if (child.name === 'node') {
                const node = { type: 'node', id: Number(child.attrs.id), lat: Number(child.attrs.lat), lon: Number(child.attrs.lon) };
                if (!finite(node.id) || !finite(node.lat) || !finite(node.lon)) return;
                const tags = tagsOf(child);
                if (Object.keys(tags).length) node.tags = tags;
                elements.push(node);
            } else if (child.name === 'way') {
                const id = Number(child.attrs.id);
                if (!finite(id)) return;
                const nodes = child.children.filter(ref => ref.name === 'nd').map(ref => Number(ref.attrs.ref)).filter(finite);
                elements.push({ type: 'way', id, nodes, tags: tagsOf(child) });
            }
        });
        return elements;
    }

    // An OSM-JSON document's road elements, and the `cb:definition` extension a road this app wrote
    // carries beside them (its tunnels, grade separations, bound…; design-file-exports.js).
    function documentFromJson(text) {
        const parsed = JSON.parse(text);
        const elements = parsed && Array.isArray(parsed.elements) ? parsed.elements : null;
        if (!elements) throw new Error('OSM: a JSON document needs an `elements` list');
        const extension = parsed['cb:definition'];
        return { elements: elements.filter(element => element && (element.type === 'node' || element.type === 'way')),
            extension: extension && typeof extension === 'object' && !Array.isArray(extension) ? extension : null };
    }
    const elementsFromJson = text => documentFromJson(text).elements;

    // parseOsm(text) -> { form, roads, placement, warnings }, the shape every import adapter returns.
    function parseOsm(text) {
        const source = String(text || '');
        const trimmed = source.trimStart();
        const { elements, extension } = trimmed.startsWith('{') ? documentFromJson(source) : { elements: elementsFromXml(source), extension: null };
        const warnings = [];
        const nodes = new Map(elements.filter(element => element.type === 'node' && finite(element.lat) && finite(element.lon)).map(node => [node.id, node]));
        let ways = elements.filter(element => element.type === 'way' && Array.isArray(element.nodes) && isRoadWay(element));
        const skipped = elements.filter(element => element.type === 'way').length - ways.length;
        if (skipped) warnings.push(`${skipped} way(s) without a highway or railway tag were left out`);
        if (ways.length > MAX_WAYS) {
            warnings.push(`${ways.length} road ways in the file; only the first ${MAX_WAYS} were imported`);
            ways = ways.slice(0, MAX_WAYS);
        }
        const usedNodes = new Set();
        const formWays = [];
        ways.forEach(way => {
            const present = way.nodes.filter(id => nodes.has(id));
            if (present.length < 2) {
                warnings.push(`way ${way.id} has fewer than two nodes in the file and was left out`);
                return;
            }
            if (present.length !== way.nodes.length) warnings.push(`way ${way.id}: ${way.nodes.length - present.length} node(s) missing from the file were skipped`);
            present.forEach(id => usedNodes.add(id));
            // A stretch id the file already gives (a road this app wrote) is kept, so what refers
            // to it (a tunnel's segmentId) still does; any other way is named after its id.
            const own = way.tags['cb:segment'];
            const segment = typeof own === 'string' && own && !formWays.some(other => other.tags['cb:segment'] === own) ? own : `w${way.id}`;
            formWays.push({ type: 'way', id: way.id, nodes: present, tags: { ...way.tags, 'cb:segment': segment } });
        });
        const formNodes = [...usedNodes].map(id => {
            const node = nodes.get(id);
            const copy = { type: 'node', id: node.id, lat: node.lat, lon: node.lon };
            if (node.tags && Object.keys(node.tags).length) copy.tags = { ...node.tags };
            return copy;
        });
        // One road per name; a nameless way is its own road.
        const roadsByKey = new Map();
        formWays.forEach(way => {
            const name = way.tags.name ? String(way.tags.name).trim() : '';
            const key = name ? `name:${name}` : `way:${way.id}`;
            if (!roadsByKey.has(key)) roadsByKey.set(key, { id: name ? name : `w${way.id}`, name: name || null, wayIds: [] });
            roadsByKey.get(key).wayIds.push(way.id);
        });
        return {
            form: { version: 0.6, generator: 'consensus-builder', elements: [...formNodes, ...formWays] },
            roads: [...roadsByKey.values()],
            placement: 'georeference',
            warnings,
            ...(extension ? { extension } : {})
        };
    }

    return { parseOsm, elementsFromXml, elementsFromJson, MAX_WAYS };
});
