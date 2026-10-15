// The road record as an OSM document (roads.md §11). A corridor's geometry and cross-sections are
// stored as what they are in OpenStreetMap: ways sharing nodes, with the standard tags for lanes,
// footways, cycle lanes, parking, medians and tracks. Everything this app derives — transition
// zones, kerb returns, the land take — stays derived. What OSM cannot say about one of our lanes
// (a verge planted with trees, a tree every N parking bays, a lane order OSM's per-side scheme
// cannot express) rides in namespaced `cb:*` tags that any OSM tool ignores, so the form is
// lossless for us and plain OSM for everyone else.
//
// `osmFormOf(definition)` writes the form, `definitionFromOsmForm(form)` reads it back into the
// fields the renderer and the land already consume, and `osmFormAgreement(definition)` says
// whether a record's cached fields are what its form says: the form is the record, the fields a
// cache of it, and a publish refuses a record whose two disagree. Pure; browser globals or node
// requires for corridor-profile.js, never both.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__corridorOsmForm = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const profileApi = name => {
        if (global && typeof global[name] === 'function') return global[name];
        if (global && global[name] && typeof global[name] === 'object') return global[name];
        if (typeof require === 'function') return require('./corridor-profile.js')[name];
        throw new Error(`corridor-osm-form: ${name} is not available`);
    };
    const normalizeProfile = profile => profileApi('normalizeCorridorProfile')(profile);
    const profileWidth = profile => profileApi('corridorProfileWidth')(profile);
    const standardTags = profile => profileApi('corridorProfileToOsmTags')(profile);
    const standardProfile = tags => profileApi('corridorProfileFromOsmTags')(tags);
    const segmentEntries = definition => profileApi('corridorSegmentEntries')(definition);
    const parkingOrientation = type => profileApi('corridorParkingOrientation')(type);

    const OSM_VERSION = 0.6;
    const GENERATOR = 'consensus-builder';
    const COORD_DECIMALS = 7; // ~1 cm: two stretch ends this close are one node
    const CARRIAGEWAY_TYPES = new Set(['driving', 'bus']);
    const FLANK_ORDER = ['sidewalk', 'verge', 'cycleway', 'parking'];
    const PAVING_SURFACE = { paved: 'paving_stones', asphalt: 'asphalt' };
    const SURFACE_PAVING = { paving_stones: 'paved', sett: 'paved', asphalt: 'asphalt' };

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const round3 = value => Math.round(value * 1000) / 1000;
    const coordKey = point => `${Number(point.lat).toFixed(COORD_DECIMALS)},${Number(point.lng).toFixed(COORD_DECIMALS)}`;
    const laneGroup = type => (parkingOrientation(type) ? 'parking' : type);

    // ---- lanes <-> tags ------------------------------------------------------------------------

    // One lane as text: `type:width[:direction][:key=value…]`, for the `cb:lanes` tag that carries a
    // cross-section exactly when the standard tags cannot.
    function encodeLane(lane) {
        const parts = [lane.type, String(round3(lane.width))];
        if (lane.direction) parts.push(lane.direction);
        ['landscape', 'treeEvery', 'gauge', 'paving'].forEach(key => {
            if (lane[key] !== undefined) parts.push(`${key}=${lane[key]}`);
        });
        return parts.join(':');
    }

    function decodeLane(text) {
        const [type, width, ...rest] = String(text).split(':');
        const lane = { type, width: Number(width) };
        rest.forEach(part => {
            const eq = part.indexOf('=');
            if (eq === -1) lane.direction = part;
            else lane[part.slice(0, eq)] = part.slice(eq + 1);
        });
        return lane;
    }

    const sameProfile = (a, b) => JSON.stringify(normalizeProfile(a)) === JSON.stringify(normalizeProfile(b));

    // The tags of one way for a cross-section: OSM's own scheme first (corridor-profile.js
    // corridorProfileToOsmTags), then the standard refinements that make it exact where the plain
    // scheme rounds — per-lane widths (`width:lanes`), bus lanes (`bus:lanes`), footway surfaces —
    // then the namespaced attributes OSM has no key for. If reading those back would still not give
    // the lanes exactly (an order the per-side scheme cannot hold), `cb:lanes` carries them whole.
    function laneTagsOf(profile) {
        const normalized = normalizeProfile(profile);
        if (!normalized) return null;
        const lanes = normalized.strips;
        const tags = standardTags(normalized) || { width: String(round3(profileWidth(normalized))) };

        const carriageway = lanes.filter(lane => CARRIAGEWAY_TYPES.has(lane.type));
        if (carriageway.length) {
            const directionOf = lane => lane.direction || 'forward';
            const forward = carriageway.filter(lane => directionOf(lane) === 'forward').length;
            const backward = carriageway.filter(lane => directionOf(lane) === 'backward').length;
            tags.lanes = String(carriageway.length);
            delete tags.oneway; delete tags['lanes:forward']; delete tags['lanes:backward']; delete tags['lanes:both_ways'];
            if (forward === carriageway.length) tags.oneway = 'yes';
            else if (backward === carriageway.length) tags.oneway = '-1';
            else {
                tags['lanes:forward'] = String(forward);
                tags['lanes:backward'] = String(backward);
                const bothWays = carriageway.length - forward - backward;
                if (bothWays) tags['lanes:both_ways'] = String(bothWays);
            }
            tags['width:lanes'] = carriageway.map(lane => String(round3(lane.width))).join('|');
            if (carriageway.some(lane => lane.type === 'bus')) {
                tags['bus:lanes'] = carriageway.map(lane => (lane.type === 'bus' ? 'designated' : '')).join('|');
            }
        }

        // Per-side attributes: a footway's surface (standard), a verge's planting and a parking
        // lane's tree rhythm (ours). The side is left of the carriageway or right of it.
        const centre = lanes.findIndex(lane => CARRIAGEWAY_TYPES.has(lane.type) || lane.type === 'rail' || lane.type === 'median');
        const sideOf = index => (centre === -1 || index < centre ? 'left' : 'right');
        const perSide = (predicate, write) => {
            ['left', 'right'].forEach(side => {
                const found = lanes.filter((lane, index) => predicate(lane) && sideOf(index) === side);
                if (found.length) write(side, found[0]);
            });
        };
        perSide(lane => lane.type === 'sidewalk' && lane.paving, (side, lane) => { tags[`sidewalk:${side}:surface`] = PAVING_SURFACE[lane.paving]; });
        perSide(lane => lane.type === 'verge' && lane.landscape, (side, lane) => { tags[`cb:verge:${side}:landscape`] = lane.landscape; });
        perSide(lane => !!parkingOrientation(lane.type) && lane.treeEvery, (side, lane) => { tags[`cb:parking:${side}:tree_every`] = String(lane.treeEvery); });
        const median = lanes.find(lane => lane.type === 'median');
        if (median && median.landscape) tags['cb:median:landscape'] = median.landscape;

        if (!sameProfile(profileFromLaneTags(tags), normalized)) {
            tags['cb:lanes'] = lanes.map(encodeLane).join('|');
        }
        return tags;
    }

    // The cross-section a way's tags describe, exactly as laneTagsOf wrote it.
    function profileFromLaneTags(tags) {
        const source = tags || {};
        if (source['cb:lanes']) {
            return normalizeProfile({ strips: String(source['cb:lanes']).split('|').map(decodeLane) });
        }
        const base = standardProfile({ ...source, highway: source.highway || (source.railway ? undefined : 'road') });
        if (!base) return null;
        const lanes = base.strips.map(lane => ({ ...lane }));
        const carriageway = lanes.filter(lane => CARRIAGEWAY_TYPES.has(lane.type));
        const widths = source['width:lanes'] ? String(source['width:lanes']).split('|').map(Number) : null;
        const buses = source['bus:lanes'] ? String(source['bus:lanes']).split('|') : null;
        carriageway.forEach((lane, index) => {
            if (widths && finite(widths[index]) && widths[index] > 0) lane.width = widths[index];
            if (buses && buses[index] === 'designated') lane.type = 'bus';
        });
        const centre = lanes.findIndex(lane => CARRIAGEWAY_TYPES.has(lane.type) || lane.type === 'rail' || lane.type === 'median');
        const sideOf = index => (centre === -1 || index < centre ? 'left' : 'right');
        lanes.forEach((lane, index) => {
            const side = sideOf(index);
            if (lane.type === 'sidewalk') {
                const paving = SURFACE_PAVING[source[`sidewalk:${side}:surface`] || source['sidewalk:both:surface']];
                if (paving) lane.paving = paving;
            }
            if (lane.type === 'verge') {
                const landscape = source[`cb:verge:${side}:landscape`];
                if (landscape) lane.landscape = landscape;
            }
            if (parkingOrientation(lane.type)) {
                const every = parseInt(source[`cb:parking:${side}:tree_every`], 10);
                if (every > 0) lane.treeEvery = every;
            }
            if (lane.type === 'median' && source['cb:median:landscape']) lane.landscape = source['cb:median:landscape'];
        });
        return normalizeProfile({ strips: lanes });
    }

    // ---- definition <-> form ---------------------------------------------------------------------

    // The way's class. A drawn road has no class of its own: `highway=road` is OSM's word for a road
    // whose class is not known, and a record adopted from OSM keeps the class it came with.
    function classTags(definition, profile) {
        if (profile && profile.strips.some(lane => lane.type === 'rail')) return {};
        const metadata = (definition && definition.metadata) || {};
        return { highway: typeof metadata.highway === 'string' && metadata.highway ? metadata.highway : 'road' };
    }

    function osmFormOf(definition) {
        const entries = segmentEntries(definition);
        if (!entries.length) return null;
        const nodes = new Map();
        const nodeFor = point => {
            const key = coordKey(point);
            if (!nodes.has(key)) {
                const node = { type: 'node', id: -(nodes.size + 1), lat: Number(point.lat), lon: Number(point.lng) };
                if (finite(point.level)) node.tags = { 'cb:level': String(point.level) };
                nodes.set(key, node);
            }
            return nodes.get(key).id;
        };
        const ways = entries.map((entry, index) => {
            const tags = { ...classTags(definition, entry.profile), ...(laneTagsOf(entry.profile) || {}) };
            if (entry.segmentId !== null && entry.segmentId !== undefined) tags['cb:segment'] = String(entry.segmentId);
            return { type: 'way', id: -(index + 1), nodes: entry.points.map(nodeFor), tags };
        });
        return { version: OSM_VERSION, generator: GENERATOR, elements: [...nodes.values(), ...ways] };
    }

    // The fields the renderer, the land and the editor read, from a form. Every way is a stretch;
    // the first way's cross-section is the record's default and the others are per-stretch
    // overrides, keyed by the stretch id the way carries (or one made from the way's id).
    function definitionFromOsmForm(form) {
        const elements = (form && Array.isArray(form.elements)) ? form.elements : [];
        const nodes = new Map(elements.filter(element => element && element.type === 'node').map(node => [node.id, node]));
        const ways = elements.filter(element => element && element.type === 'way' && Array.isArray(element.nodes));
        const segments = [];
        const segmentIds = [];
        const profiles = [];
        ways.forEach(way => {
            const points = way.nodes.map(id => nodes.get(id)).filter(Boolean).map(node => {
                const level = node.tags && Number(node.tags['cb:level']);
                return finite(level) ? { lat: node.lat, lng: node.lon, level } : { lat: node.lat, lng: node.lon };
            });
            const profile = profileFromLaneTags(way.tags || {});
            if (points.length < 2 || !profile) return;
            segments.push(points);
            segmentIds.push((way.tags && way.tags['cb:segment'] !== undefined) ? String(way.tags['cb:segment']) : `way${way.id}`);
            profiles.push(profile);
        });
        if (!segments.length) return null;
        const profile = profiles[0];
        const segmentProfiles = {};
        profiles.forEach((candidate, index) => {
            if (!sameProfile(candidate, profile)) segmentProfiles[segmentIds[index]] = candidate;
        });
        const definition = { points: segments, segments, segmentIds, profile, width: round3(profileWidth(profile)) };
        if (Object.keys(segmentProfiles).length) definition.segmentProfiles = segmentProfiles;
        return definition;
    }

    // What the form says against what the fields say: the same stretches, point for point (to a
    // centimetre), level for level, lane for lane. A record without a form claims nothing.
    function osmFormAgreement(definition) {
        if (!definition || !definition.osm) return { ok: true, checked: false };
        const stored = segmentEntries(definition);
        const derived = segmentEntries(definitionFromOsmForm(definition.osm) || {});
        if (stored.length !== derived.length) return { ok: false, checked: true, reason: `the form has ${derived.length} stretches, the record ${stored.length}` };
        for (let index = 0; index < stored.length; index += 1) {
            const a = stored[index];
            const b = derived[index];
            if (a.points.length !== b.points.length) return { ok: false, checked: true, reason: `stretch ${index + 1} has ${b.points.length} points in the form, ${a.points.length} in the record` };
            for (let p = 0; p < a.points.length; p += 1) {
                if (coordKey(a.points[p]) !== coordKey(b.points[p])) return { ok: false, checked: true, reason: `stretch ${index + 1}, point ${p + 1} differs` };
                if ((finite(a.points[p].level) ? a.points[p].level : null) !== (finite(b.points[p].level) ? b.points[p].level : null)) return { ok: false, checked: true, reason: `stretch ${index + 1}, point ${p + 1} level differs` };
            }
            if (!sameProfile(a.profile, b.profile)) return { ok: false, checked: true, reason: `stretch ${index + 1} cross-section differs` };
        }
        return { ok: true, checked: true };
    }

    // Write the form onto a definition (after any edit of its stretches or cross-sections).
    function withOsmForm(definition) {
        if (!definition) return definition;
        const form = osmFormOf(definition);
        if (form) definition.osm = form;
        else delete definition.osm;
        return definition;
    }

    return { laneTagsOf, profileFromLaneTags, osmFormOf, definitionFromOsmForm, osmFormAgreement, withOsmForm, encodeLane, decodeLane, OSM_VERSION, GENERATOR };
});
