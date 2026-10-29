// The road record as an OSM document (roads.md §11). A corridor's geometry and cross-sections are
// stored as what they are in OpenStreetMap: ways sharing nodes, with the standard tags for lanes,
// footways, cycle lanes, parking, medians and tracks. Everything this app derives — transition
// zones, kerb returns, the land take — stays derived. What OSM cannot say about one of our lanes
// (a verge planted with trees, a tree every N parking bays, a lane order OSM's per-side scheme
// cannot express) rides in namespaced `cb:*` tags that any OSM tool ignores, so the form is
// lossless for us and plain OSM for everyone else.
//
// `osmFormOf(definition)` writes the form and `definitionFromOsmForm(form)` reads it back into the
// fields the renderer and the land consume. `toRecord(definition)` is the stored shape (the form,
// no stretch fields) and `toView(definition)` the running shape (the stretch fields, no form): every
// store and publish goes through the first, every load through the second, so nothing ever stores
// the fields or reads the form directly. Pure; browser globals or node requires for
// corridor-profile.js, never both.
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
    const standardTags = (profile, drivingSide) => profileApi('corridorProfileToOsmTags')(profile, drivingSide);
    const standardProfile = (tags, drivingSide) => profileApi('corridorProfileFromOsmTags')(tags, undefined, drivingSide);
    // The side of the road a way's traffic keeps to, on OSM's own key: `driving_side=left` where it
    // keeps left (a UK street), absent where it keeps right. It decides which side of the centre
    // line `lanes:forward` and the per-side cycle lanes mean.
    const drivingSideOf = tags => (tags && tags.driving_side === 'left' ? 'left' : 'right');
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

    // Two cross-sections are the same when their lanes agree to the millimetre: the form writes
    // widths at three decimals, so a width with more only agrees after rounding.
    const atMillimetre = profile => {
        const normalized = normalizeProfile(profile);
        return normalized ? { ...normalized, strips: normalized.strips.map(lane => ({ ...lane, width: round3(lane.width) })) } : normalized;
    };
    const sameProfile = (a, b) => JSON.stringify(atMillimetre(a)) === JSON.stringify(atMillimetre(b));

    // The tags of one way for a cross-section: OSM's own scheme first (corridor-profile.js
    // corridorProfileToOsmTags), then the standard refinements that make it exact where the plain
    // scheme rounds — per-lane widths (`width:lanes`), bus lanes (`bus:lanes`), footway surfaces —
    // then the namespaced attributes OSM has no key for. If reading those back would still not give
    // the lanes exactly (an order the per-side scheme cannot hold), `cb:lanes` carries them whole.
    function laneTagsOf(profile, drivingSide = 'right') {
        const normalized = normalizeProfile(profile);
        if (!normalized) return null;
        const lanes = normalized.strips;
        const tags = standardTags(normalized, drivingSide) || { width: String(round3(profileWidth(normalized))) };
        if (drivingSide === 'left') tags.driving_side = 'left';

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
        const base = standardProfile({ ...source, highway: source.highway || (source.railway ? undefined : 'road') }, drivingSideOf(source));
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

    // The stored points as stretches, before the centreline funnel rebuilds them: a measured
    // height (`elevationM`, on an imported transit alignment) lives only there.
    function rawStretches(definition) {
        const raw = definition && ((Array.isArray(definition.points) && definition.points.length && definition.points)
            || (Array.isArray(definition.segments) && definition.segments));
        if (!raw || !raw.length) return [];
        return Array.isArray(raw[0]) ? raw : [raw];
    }

    function osmFormOf(definition) {
        const entries = segmentEntries(definition);
        if (!entries.length) return null;
        const raw = rawStretches(definition);
        const nodes = new Map();
        const nodeFor = (point, source) => {
            const key = coordKey(point);
            if (!nodes.has(key)) {
                const node = { type: 'node', id: -(nodes.size + 1), lat: Number(point.lat), lon: Number(point.lng) };
                const tags = {};
                if (finite(point.level)) tags['cb:level'] = String(point.level);
                // A measured height rides on OSM's own key for it (metres above sea level).
                if (source && finite(source.elevationM)) tags.ele = String(source.elevationM);
                if (Object.keys(tags).length) node.tags = tags;
                nodes.set(key, node);
            }
            return nodes.get(key).id;
        };
        const ways = entries.map((entry, index) => {
            const tags = { ...classTags(definition, entry.profile), ...(laneTagsOf(entry.profile, definition.drivingSide === 'left' ? 'left' : 'right') || {}) };
            if (entry.segmentId !== null && entry.segmentId !== undefined) tags['cb:segment'] = String(entry.segmentId);
            const sources = Array.isArray(raw[index]) ? raw[index] : [];
            return { type: 'way', id: -(index + 1), nodes: entry.points.map((point, p) => nodeFor(point, sources[p])), tags };
        });
        return { version: OSM_VERSION, generator: GENERATOR, elements: [...nodes.values(), ...ways] };
    }

    // The fields the renderer, the land and the editor read, from a form. Every way is a stretch;
    // the first way's cross-section is the record's default and the others are per-stretch
    // overrides, keyed by the stretch id the way carries (or one made from the way's id).
    // The fields the renderer, the land and the editor read, from a form. Every way is a stretch;
    // the first way's cross-section is the record's default and the others are per-stretch
    // overrides, keyed by the stretch id the way carries. A way without `cb:segment` has no id
    // (null, as a drawn stretch without one), unless its cross-section differs from the default and
    // the override needs a key: then the way's own id names the stretch.
    function definitionFromOsmForm(form) {
        const elements = (form && Array.isArray(form.elements)) ? form.elements : [];
        const nodes = new Map(elements.filter(element => element && element.type === 'node').map(node => [node.id, node]));
        const ways = elements.filter(element => element && element.type === 'way' && Array.isArray(element.nodes));
        const stretches = [];
        ways.forEach(way => {
            const points = way.nodes.map(id => nodes.get(id)).filter(Boolean).map(node => {
                const point = { lat: node.lat, lng: node.lon };
                const level = node.tags && Number(node.tags['cb:level']);
                if (finite(level)) point.level = level;
                const elevation = node.tags && node.tags.ele !== undefined ? Number(node.tags.ele) : NaN;
                if (finite(elevation)) point.elevationM = elevation;
                return point;
            });
            const profile = profileFromLaneTags(way.tags || {});
            if (points.length < 2 || !profile) return;
            const tagged = way.tags && way.tags['cb:segment'];
            stretches.push({ points, profile, id: (tagged !== undefined && tagged !== null) ? String(tagged) : null, wayId: way.id, drivingSide: drivingSideOf(way.tags) });
        });
        if (!stretches.length) return null;
        const profile = stretches[0].profile;
        const segmentProfiles = {};
        stretches.forEach(stretch => {
            if (sameProfile(stretch.profile, profile)) return;
            if (stretch.id === null) stretch.id = `way${stretch.wayId}`;
            segmentProfiles[stretch.id] = stretch.profile;
        });
        const segments = stretches.map(stretch => stretch.points);
        const definition = { points: segments, segments, profile, width: round3(profileWidth(profile)), drivingSide: stretches[0].drivingSide };
        if (stretches.some(stretch => stretch.id !== null)) definition.segmentIds = stretches.map(stretch => stretch.id);
        if (Object.keys(segmentProfiles).length) definition.segmentProfiles = segmentProfiles;
        return definition;
    }

    // ---- record <-> view -------------------------------------------------------------------------
    //
    // A corridor definition has two shapes. The RECORD is what is stored and published: the OSM
    // document under `osm`, beside the fields that are not a stretch or a cross-section (the land,
    // its construction frame, tunnels, junctions, metadata). The VIEW is what runs: the stretch and
    // cross-section fields every renderer, editor and land calculation reads, decoded from the form
    // at load. Nothing stores the view and nothing hands the record to a reader, so the two can
    // never disagree. A definition that is not a drawn road or track (a designation: land with no
    // centre line, or a polygon alone) has no form and keeps its fields in both shapes.

    const VIEW_FIELDS = ['points', 'segments', 'segmentIds', 'profile', 'segmentProfiles', 'width', 'sidewalkWidth', 'drivingSide'];

    const withoutViewFields = definition => {
        const record = { ...definition };
        VIEW_FIELDS.forEach(field => { delete record[field]; });
        return record;
    };

    const levelOf = point => (finite(point.level) ? point.level : null);
    const elevationOf = point => (finite(point.elevationM) ? point.elevationM : null);

    // Why a form does not say what its view says, or null when the two agree: stretch by stretch,
    // point by point to the centimetre, level by level, cross-section by cross-section.
    function disagreement(view, form) {
        const stored = segmentEntries(view);
        const decoded = definitionFromOsmForm(form) || {};
        const derived = segmentEntries(decoded);
        const storedRaw = rawStretches(view);
        const decodedRaw = rawStretches(decoded);
        if (stored.length !== derived.length) return `the form has ${derived.length} stretches, the view ${stored.length}`;
        if ((view.drivingSide === 'left' ? 'left' : 'right') !== decoded.drivingSide) return 'the driving side differs';
        for (let index = 0; index < stored.length; index += 1) {
            const a = stored[index];
            const b = derived[index];
            if (a.points.length !== b.points.length) return `stretch ${index + 1} has ${b.points.length} points in the form, ${a.points.length} in the view`;
            for (let p = 0; p < a.points.length; p += 1) {
                if (coordKey(a.points[p]) !== coordKey(b.points[p])) return `stretch ${index + 1}, point ${p + 1} differs`;
                if (levelOf(a.points[p]) !== levelOf(b.points[p])) return `stretch ${index + 1}, point ${p + 1} level differs`;
                if (elevationOf((storedRaw[index] || [])[p] || {}) !== elevationOf((decodedRaw[index] || [])[p] || {})) return `stretch ${index + 1}, point ${p + 1} elevation differs`;
            }
            // A stretch that says nothing about its cross-section takes the form's default one.
            if (a.profile && !sameProfile(a.profile, b.profile)) return `stretch ${index + 1} cross-section differs`;
        }
        return null;
    }

    // The stored shape of a definition. A view (stretch fields present) is encoded into its form,
    // which must read back as the same stretches; a record is returned as it is, minus any stray
    // view field; a definition with no stretches is returned unchanged.
    function toRecord(definition) {
        if (!definition || typeof definition !== 'object') return definition;
        const hasView = segmentEntries(definition).length > 0;
        if (!hasView) return definition.osm ? withoutViewFields(definition) : { ...definition };
        const form = osmFormOf(definition);
        if (!form) return { ...definition };
        const why = disagreement(definition, form);
        if (why) throw new Error(`corridor-osm-form: the record cannot carry this road as an OSM document: ${why}`);
        const record = withoutViewFields(definition);
        record.osm = form;
        return record;
    }

    // The running shape of a definition: the stretch fields decoded from its form, the form itself
    // left behind (it is encoded again at the next store). A definition without a form is already a
    // view (a designation, or stretch fields on their way to the store).
    function toView(definition) {
        if (!definition || typeof definition !== 'object' || !definition.osm) return definition;
        const decoded = definitionFromOsmForm(definition.osm);
        const view = withoutViewFields(definition);
        delete view.osm;
        return decoded ? Object.assign(view, decoded) : view;
    }

    const isRecord = definition => !!(definition && typeof definition === 'object' && definition.osm && !segmentEntries(definition).length);

    return { laneTagsOf, profileFromLaneTags, osmFormOf, definitionFromOsmForm, toRecord, toView, isRecord, disagreement, profileAtMillimetre: atMillimetre, encodeLane, decodeLane, VIEW_FIELDS, OSM_VERSION, GENERATOR };
});
