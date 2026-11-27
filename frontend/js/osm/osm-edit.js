// Saving building facts to OpenStreetMap as the signed-in person's own edit (osm/osm-account.js):
// set tags on existing ways or relations, all in one changeset. Each element is read from the
// editing API just before it is changed, as an editor does, and uploaded with that version, so an
// element someone else changed meanwhile is refused (409) rather than overwritten. Only the given
// keys change; the element's other tags, nodes and members are sent back as read.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.OsmEdit = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const API = 'https://api.openstreetmap.org';
    const CREATED_BY = 'Urban Game Theory';
    const ID_RE = /^osm:(way|relation)\/([1-9][0-9]{0,15})$/;

    const escapeXml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const tagsXml = tags => Object.entries(tags).map(([k, v]) => `<tag k="${escapeXml(k)}" v="${escapeXml(v)}"/>`).join('');

    function changesetXml(tags) {
        return `<osm><changeset>${tagsXml(tags)}</changeset></osm>`;
    }

    // One element (as the API's JSON gives it) in an osmChange <modify>, in changeset `changeset`.
    function elementXml(element, changeset) {
        const head = `id="${element.id}" version="${element.version}" changeset="${changeset}"`;
        if (element.type === 'way') return `<way ${head}>${element.nodes.map(ref => `<nd ref="${ref}"/>`).join('')}${tagsXml(element.tags || {})}</way>`;
        if (element.type === 'relation') {
            const members = element.members.map(m => `<member type="${escapeXml(m.type)}" ref="${m.ref}" role="${escapeXml(m.role || '')}"/>`).join('');
            return `<relation ${head}>${members}${tagsXml(element.tags || {})}</relation>`;
        }
        throw new Error(`Cannot edit an OpenStreetMap ${element.type}`);
    }
    function osmChangeXml(elements, changeset) {
        return `<osmChange version="0.6" generator="${CREATED_BY}"><modify>${elements.map(element => elementXml(element, changeset)).join('')}</modify></osmChange>`;
    }

    // <diffResult>'s new versions: Map "osm:way/1" → 7.
    function parseDiffResult(xml) {
        const versions = new Map();
        for (const match of String(xml).matchAll(/<(way|relation)\s+([^>]*?)\/?>/g)) {
            const attr = name => (new RegExp(`${name}="([^"]*)"`).exec(match[2]) || [])[1];
            if (attr('old_id') && attr('new_version')) versions.set(`osm:${match[1]}/${attr('old_id')}`, Number(attr('new_version')));
        }
        return versions;
    }

    // edits: [{ id: 'osm:way/1', tags: { 'building:parapet': 'yes' } }] → the elements to upload
    // (read: Map id → element), leaving out those already tagged so.
    function changedElements(edits, read) {
        return edits.map(edit => {
            const element = read.get(edit.id);
            if (!element) throw new Error(`OpenStreetMap has no ${edit.id.replace(/^osm:/, '')}`);
            const tags = { ...(element.tags || {}), ...edit.tags };
            return Object.keys(edit.tags).some(key => element.tags?.[key] !== edit.tags[key]) ? { ...element, tags } : null;
        }).filter(Boolean);
    }

    // Save the edits in one changeset with `comment`. Resolves { changeset, versions: Map id → new
    // version } (no changeset when nothing needed changing). The changeset is closed on failure too.
    async function saveTags(edits, { token, comment, fetchFn = fetch, api = API }) {
        const auth = { Authorization: `Bearer ${token}` };
        const ask = async (path, options = {}, what) => {
            const response = await fetchFn(`${api}/api/0.6/${path}`, { ...options, headers: { ...auth, ...(options.headers || {}) } });
            if (response.status === 409) throw new Error(`Someone else changed ${what} on OpenStreetMap meanwhile: check again, then save.`);
            if (!response.ok) throw new Error(`OpenStreetMap ${what} HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
            return response;
        };
        const ids = { way: [], relation: [] };
        for (const edit of edits) {
            const match = ID_RE.exec(edit.id);
            if (!match) throw new Error(`Not an OpenStreetMap building: ${edit.id}`);
            ids[match[1]].push(match[2]);
        }
        const read = new Map();
        for (const kind of ['way', 'relation']) {
            for (let i = 0; i < ids[kind].length; i += 100) {
                const batch = ids[kind].slice(i, i + 100);
                const answer = await (await ask(`${kind}s.json?${kind}s=${batch.join(',')}`, {}, 'reading the buildings')).json();
                for (const element of answer.elements || []) read.set(`osm:${element.type}/${element.id}`, element);
            }
        }
        const changed = changedElements(edits, read);
        if (!changed.length) return { changeset: null, versions: new Map(edits.map(edit => [edit.id, read.get(edit.id).version])) };
        const xml = { 'Content-Type': 'text/xml' };
        const changeset = Number(await (await ask('changeset/create', { method: 'PUT', headers: xml,
            body: changesetXml({ created_by: CREATED_BY, comment }) }, 'opening a changeset')).text());
        try {
            const diff = await (await ask(`changeset/${changeset}/upload`, { method: 'POST', headers: xml, body: osmChangeXml(changed, changeset) },
                changed.length === 1 ? `${changed[0].type} ${changed[0].id}` : 'one of the buildings')).text();
            return { changeset, versions: parseDiffResult(diff) };
        } finally {
            await fetchFn(`${api}/api/0.6/changeset/${changeset}/close`, { method: 'PUT', headers: auth }).catch(error => {
                console.error(`[${new Date().toISOString()}] [OsmEdit] changeset ${changeset} could not be closed (OSM closes it within an hour)`, error);
            });
        }
    }

    return { API, CREATED_BY, changesetXml, elementXml, osmChangeXml, parseDiffResult, changedElements, saveTags };
});
