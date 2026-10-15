// ASAM OpenDRIVE (.xodr, versions 1.4–1.8) import: an OpenDRIVE road network becomes this app's OSM
// form (corridor-osm-form.js) — nodes plus one way per lane section, tagged with the standard OSM lane
// tags. Connecting roads inside junctions are skipped: every road end touching a junction is extended
// to one shared junction node, and our own junction object cuts and fillets the arms there. Pure: a
// minimal built-in XML parser (no DOMParser, one code path everywhere), proj4 and metric-frame.js for
// placement, corridor-osm-form.js for the tags — browser globals or node requires.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__corridorImportOpenDrive = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    function proj4Lib() {
        if (global && typeof global.proj4 === 'function') return global.proj4;
        if (typeof require === 'function') {
            try { return require('proj4'); } catch (_) { /* not resolvable from frontend/js */ }
            try { return require(require.resolve('proj4', { paths: [process.cwd()] })); } catch (_) { /* fall through */ }
        }
        throw new Error('corridor-import-opendrive: proj4 is not available');
    }
    function osmFormLib() {
        if (global && global.__corridorOsmForm) return global.__corridorOsmForm;
        if (typeof require === 'function') return require('./corridor-osm-form.js');
        throw new Error('corridor-import-opendrive: corridor-osm-form.js is not available');
    }
    function metricFrameLib() {
        if (global && global.__metricFrame) return global.__metricFrame;
        if (typeof require === 'function') return require('./metric-frame.js');
        throw new Error('corridor-import-opendrive: metric-frame.js is not available');
    }

    // OpenDRIVE lane type → our lane type. `border` becomes a verge only when wide enough to be one;
    // types mapped to null are dropped on purpose (no warning), types absent here are unsupported.
    const OPENDRIVE_LANE_TYPES = Object.freeze({
        driving: 'driving', stop: 'driving', shoulder: 'driving', restricted: 'driving', entry: 'driving',
        exit: 'driving', onRamp: 'driving', offRamp: 'driving', connectingRamp: 'driving',
        bidirectional: 'driving', special1: 'driving', special2: 'driving', special3: 'driving',
        roadWorks: 'driving', taxi: 'driving', HOV: 'driving', mwyEntry: 'driving', mwyExit: 'driving',
        bus: 'bus',
        biking: 'cycleway',
        sidewalk: 'sidewalk', walking: 'sidewalk',
        parking: 'parking',
        median: 'median',
        tram: 'rail', rail: 'rail',
        border: 'verge',
        none: null, curb: null
    });
    // OpenDRIVE road type (`<type type>`) → OSM highway class.
    const OPENDRIVE_ROAD_TYPES = Object.freeze({
        motorway: 'motorway',
        townExpressway: 'trunk',
        townArterial: 'primary',
        townCollector: 'secondary',
        rural: 'tertiary',
        town: 'residential', townLocal: 'residential', townPrivate: 'residential', unknown: 'residential',
        lowSpeed: 'living_street', townPlayStreet: 'living_street',
        pedestrian: 'pedestrian',
        bicycle: 'cycleway'
    });
    const DEFAULT_HIGHWAY = 'residential';
    const DIRECTIONAL = new Set(['driving', 'bus', 'cycleway']);
    const MIN_LANE_WIDTH_M = 0.3;
    const MIN_BORDER_VERGE_M = 0.5;
    const TAPER_WARN_M = 0.2;
    const SPIRAL_STEP_M = 0.25;
    const RAIL_GAUGE_MM = 1435;
    const COORD_DECIMALS = 7; // ~1 cm, as corridor-osm-form.js: two samples this close are one node
    const LINK_SNAP_M = 0.05;

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const round3 = value => Math.round(value * 1000) / 1000;

    // ---- minimal XML ---------------------------------------------------------------------------

    const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    function decodeEntities(text) {
        return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, body) => {
            if (body[0] === '#') {
                const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
                return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
            }
            return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole;
        });
    }

    // Elements as { name, attrs, children, text }; text is the concatenated character data (CDATA
    // included). Throws on anything malformed: a stray close tag, an unclosed element, a bad attribute.
    function parseXml(input) {
        const src = String(input);
        const fail = (message, at) => {
            const line = src.slice(0, at).split('\n').length;
            throw new Error(`OpenDRIVE: malformed XML at line ${line}: ${message}`);
        };
        const document = { name: '#document', attrs: {}, children: [], text: '' };
        const stack = [document];
        const top = () => stack[stack.length - 1];
        const NAME = /[A-Za-z_:][-\w:.]*/y;
        const ATTR = /\s+([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
        let i = 0;
        const addText = text => {
            if (stack.length === 1) {
                if (text.trim()) fail('text outside the root element', i);
                return;
            }
            top().text += decodeEntities(text);
        };
        while (i < src.length) {
            const lt = src.indexOf('<', i);
            if (lt === -1) { addText(src.slice(i)); break; }
            if (lt > i) addText(src.slice(i, lt));
            if (src.startsWith('<!--', lt)) {
                const end = src.indexOf('-->', lt + 4);
                if (end === -1) fail('unclosed comment', lt);
                i = end + 3;
            } else if (src.startsWith('<![CDATA[', lt)) {
                const end = src.indexOf(']]>', lt + 9);
                if (end === -1) fail('unclosed CDATA section', lt);
                if (stack.length === 1) fail('CDATA outside the root element', lt);
                top().text += src.slice(lt + 9, end);
                i = end + 3;
            } else if (src.startsWith('<?', lt)) {
                const end = src.indexOf('?>', lt + 2);
                if (end === -1) fail('unclosed processing instruction', lt);
                i = end + 2;
            } else if (src.startsWith('<!', lt)) {
                // DOCTYPE (with an optional internal subset in brackets): skipped.
                let depth = 0;
                let j = lt + 2;
                for (; j < src.length; j += 1) {
                    if (src[j] === '[') depth += 1;
                    else if (src[j] === ']') depth -= 1;
                    else if (src[j] === '>' && depth <= 0) break;
                }
                if (j >= src.length) fail('unclosed declaration', lt);
                i = j + 1;
            } else if (src[lt + 1] === '/') {
                NAME.lastIndex = lt + 2;
                const match = NAME.exec(src);
                if (!match) fail('bad closing tag', lt);
                const end = src.indexOf('>', NAME.lastIndex);
                if (end === -1 || src.slice(NAME.lastIndex, end).trim()) fail('bad closing tag', lt);
                if (stack.length === 1 || top().name !== match[0]) fail(`</${match[0]}> does not close <${top().name}>`, lt);
                stack.pop();
                i = end + 1;
            } else {
                NAME.lastIndex = lt + 1;
                const match = NAME.exec(src);
                if (!match) fail('bad tag name', lt);
                const element = { name: match[0], attrs: {}, children: [], text: '' };
                let j = NAME.lastIndex;
                for (;;) {
                    ATTR.lastIndex = j;
                    const attr = ATTR.exec(src);
                    if (!attr) break;
                    element.attrs[attr[1]] = decodeEntities(attr[2] !== undefined ? attr[2] : attr[3]);
                    j = ATTR.lastIndex;
                }
                while (j < src.length && /\s/.test(src[j])) j += 1;
                let selfClosing = false;
                if (src.startsWith('/>', j)) { selfClosing = true; j += 2; } else if (src[j] === '>') j += 1;
                else fail(`bad attribute or unterminated tag <${element.name}>`, lt);
                if (stack.length === 1 && document.children.length) fail('more than one root element', lt);
                top().children.push(element);
                if (!selfClosing) stack.push(element);
                i = j;
            }
        }
        if (stack.length > 1) fail(`<${top().name}> is never closed`, src.length);
        if (!document.children.length) throw new Error('OpenDRIVE: the document has no root element');
        return document.children[0];
    }

    const childrenOf = (node, name) => (node ? node.children.filter(child => child.name === name) : []);
    const childOf = (node, name) => (node ? node.children.find(child => child.name === name) || null : null);
    const num = (node, name, fallback = 0) => {
        const value = node && node.attrs[name] !== undefined ? Number(node.attrs[name]) : NaN;
        return Number.isFinite(value) ? value : fallback;
    };
    const cubic = (rec, ds) => rec.a + rec.b * ds + rec.c * ds * ds + rec.d * ds * ds * ds;
    const polyRecord = (node, sKey) => ({ s: num(node, sKey), a: num(node, 'a'), b: num(node, 'b'), c: num(node, 'c'), d: num(node, 'd') });
    // The record in force at `s` of a list sorted by `s` (the first one before any starts).
    const recordAt = (records, s) => {
        let found = records[0] || null;
        records.forEach(rec => { if (rec.s <= s + 1e-9) found = rec; });
        return found;
    };

    // ---- reference line --------------------------------------------------------------------------

    // One planView geometry as at(ds) -> { x, y, hdg } for ds in [0, length].
    function geometryEvaluator(node) {
        const x0 = num(node, 'x');
        const y0 = num(node, 'y');
        const h0 = num(node, 'hdg');
        const length = num(node, 'length');
        const cos0 = Math.cos(h0);
        const sin0 = Math.sin(h0);
        const local = (u, v, dh) => ({ x: x0 + u * cos0 - v * sin0, y: y0 + u * sin0 + v * cos0, hdg: h0 + dh });
        const kind = node.children[0] ? node.children[0].name : 'line';
        const shape = node.children[0];

        if (kind === 'arc') {
            const k = num(shape, 'curvature');
            if (Math.abs(k) < 1e-12) return { length, at: ds => local(ds, 0, 0) };
            return {
                length,
                at: ds => ({ x: x0 + (Math.sin(h0 + k * ds) - sin0) / k, y: y0 - (Math.cos(h0 + k * ds) - cos0) / k, hdg: h0 + k * ds })
            };
        }
        if (kind === 'spiral') {
            // Curvature linear in s, so the heading is exact; the position is integrated (Simpson)
            // into a table every ≤ 0.25 m, and a point between entries integrates the remainder.
            const k0 = num(shape, 'curvStart');
            const k1 = num(shape, 'curvEnd');
            const rate = length > 0 ? (k1 - k0) / length : 0;
            const theta = s => h0 + k0 * s + rate * s * s / 2;
            const advance = (p, s, h) => {
                const tm = theta(s + h / 2);
                const te = theta(s + h);
                const ts = theta(s);
                return {
                    x: p.x + (h / 6) * (Math.cos(ts) + 4 * Math.cos(tm) + Math.cos(te)),
                    y: p.y + (h / 6) * (Math.sin(ts) + 4 * Math.sin(tm) + Math.sin(te))
                };
            };
            const n = Math.max(1, Math.ceil(length / SPIRAL_STEP_M));
            const step = length / n;
            const table = [{ x: x0, y: y0 }];
            for (let k = 0; k < n; k += 1) table.push(advance(table[k], k * step, step));
            return {
                length,
                at: ds => {
                    const index = step > 0 ? Math.min(n, Math.max(0, Math.floor(ds / step))) : 0;
                    const rest = ds - index * step;
                    const p = Math.abs(rest) > 1e-12 ? advance(table[index], index * step, rest) : table[index];
                    return { x: p.x, y: p.y, hdg: theta(ds) };
                }
            };
        }
        if (kind === 'poly3') {
            // v(u) in the local frame; arc length s(u) tabulated so a point at s finds its u.
            const rec = { a: num(shape, 'a'), b: num(shape, 'b'), c: num(shape, 'c'), d: num(shape, 'd') };
            const slope = u => rec.b + 2 * rec.c * u + 3 * rec.d * u * u;
            const speed = u => Math.sqrt(1 + slope(u) * slope(u));
            const du = 0.05;
            const us = [0];
            const ss = [0];
            const maxSteps = Math.ceil(length / du) * 4 + 1000;
            for (let k = 0; ss[ss.length - 1] < length && k < maxSteps; k += 1) {
                const u = us[us.length - 1];
                ss.push(ss[ss.length - 1] + (du / 6) * (speed(u) + 4 * speed(u + du / 2) + speed(u + du)));
                us.push(u + du);
            }
            const uAt = s => {
                let k = 1;
                while (k < ss.length - 1 && ss[k] < s) k += 1;
                const span = ss[k] - ss[k - 1];
                const t = span > 0 ? (s - ss[k - 1]) / span : 0;
                return us[k - 1] + t * (us[k] - us[k - 1]);
            };
            return {
                length,
                at: ds => {
                    const u = uAt(ds);
                    return local(u, cubic(rec, u), Math.atan(slope(u)));
                }
            };
        }
        if (kind === 'paramPoly3') {
            const U = { a: num(shape, 'aU'), b: num(shape, 'bU'), c: num(shape, 'cU'), d: num(shape, 'dU') };
            const V = { a: num(shape, 'aV'), b: num(shape, 'bV'), c: num(shape, 'cV'), d: num(shape, 'dV') };
            const derivative = (rec, p) => rec.b + 2 * rec.c * p + 3 * rec.d * p * p;
            const arcLength = shape.attrs.pRange === 'arcLength';
            return {
                length,
                at: ds => {
                    const p = arcLength ? ds : (length > 0 ? ds / length : 0);
                    return local(cubic(U, p), cubic(V, p), Math.atan2(derivative(V, p), derivative(U, p)));
                }
            };
        }
        return { length, at: ds => local(ds, 0, 0) };
    }

    function referenceLine(roadNode) {
        const geometries = childrenOf(childOf(roadNode, 'planView'), 'geometry')
            .map(node => ({ s: num(node, 's'), ...geometryEvaluator(node) }))
            .sort((a, b) => a.s - b.s);
        if (!geometries.length) return null;
        return {
            geometries,
            at(s) {
                let geometry = geometries[0];
                geometries.forEach(candidate => { if (candidate.s <= s + 1e-9) geometry = candidate; });
                return geometry.at(Math.min(geometry.length, Math.max(0, s - geometry.s)));
            }
        };
    }

    // The s values to sample in [s0, s1]: both ends, every break inside, and at most `step` apart.
    function sampleStations(s0, s1, breaks, step) {
        const marks = [s0, s1, ...breaks.filter(s => s > s0 + 1e-6 && s < s1 - 1e-6)].sort((a, b) => a - b);
        const stations = [marks[0]];
        for (let k = 1; k < marks.length; k += 1) {
            const a = marks[k - 1];
            const b = marks[k];
            if (b - a < 1e-6) continue;
            const n = Math.max(1, Math.ceil((b - a) / step - 1e-9));
            for (let j = 1; j <= n; j += 1) stations.push(j === n ? b : a + ((b - a) * j) / n);
        }
        return stations;
    }

    // ---- lanes -----------------------------------------------------------------------------------

    function laneWidthAt(widths, ds) {
        const rec = recordAt(widths, ds);
        return rec ? cubic(rec, ds - rec.s) : 0;
    }

    // ---- placement -------------------------------------------------------------------------------

    function placementOf(header, options) {
        const geoNode = childOf(header, 'geoReference');
        const projString = geoNode ? geoNode.text.replace(/\s+/g, ' ').trim() : '';
        if (projString) {
            const offset = childOf(header, 'offset');
            const ox = num(offset, 'x');
            const oy = num(offset, 'y');
            const oh = num(offset, 'hdg');
            let converter;
            try { converter = proj4Lib()(projString, 'WGS84'); } catch (error) {
                throw new Error(`OpenDRIVE: the geoReference "${projString}" is not a projection proj4 can use (${error.message})`);
            }
            return {
                placement: 'georeference',
                toLatLon(x, y) {
                    const xi = x * Math.cos(oh) - y * Math.sin(oh) + ox;
                    const yi = x * Math.sin(oh) + y * Math.cos(oh) + oy;
                    const [lon, lat] = converter.forward([xi, yi]);
                    if (!finite(lon) || !finite(lat)) throw new Error(`OpenDRIVE: point (${x}, ${y}) does not project to a longitude/latitude`);
                    return { lat, lon };
                }
            };
        }
        const anchor = options.anchor;
        if (!anchor || !finite(anchor.lat) || !finite(anchor.lng)) {
            throw new Error('OpenDRIVE: the file has no georeference (<geoReference> in its header); give it a place on the map (an anchor point) to import it');
        }
        const round6 = value => Math.round(value * 1e6) / 1e6;
        const frame = metricFrameLib().frameAt([round6(anchor.lng), round6(anchor.lat)]);
        const [ax, ay] = frame.toMetric([anchor.lng, anchor.lat]);
        const heading = (finite(anchor.headingDeg) ? anchor.headingDeg : 0) * Math.PI / 180;
        return {
            placement: 'anchor',
            toLatLon(x, y) {
                const [lat, lon] = frame.metricToLatLng(ax + x * Math.cos(heading) - y * Math.sin(heading), ay + x * Math.sin(heading) + y * Math.cos(heading));
                return { lat, lon };
            }
        };
    }

    // ---- roads -----------------------------------------------------------------------------------

    function linkOf(roadNode, which) {
        const node = childOf(childOf(roadNode, 'link'), which);
        if (!node) return null;
        return { elementType: node.attrs.elementType, elementId: node.attrs.elementId, contactPoint: node.attrs.contactPoint || null };
    }

    // One road's ways before placement: per kept lane section the inertial points of its centreline
    // (the geometric middle of the cross-section it carries) and its profile.
    function buildRoad(roadNode, step, warnings, unsupported) {
        const id = String(roadNode.attrs.id);
        const name = (roadNode.attrs.name || '').trim();
        const rule = roadNode.attrs.rule === 'LHT' ? 'LHT' : 'RHT';
        const line = referenceLine(roadNode);
        if (!line) {
            warnings.push(`road ${id} has no planView geometry and was skipped`);
            return null;
        }
        const geometryEnd = line.geometries.reduce((end, g) => Math.max(end, g.s + g.length), 0);
        const length = num(roadNode, 'length', geometryEnd);
        const types = childrenOf(roadNode, 'type').map(node => ({ s: num(node, 's'), type: node.attrs.type })).sort((a, b) => a.s - b.s);
        const lanesNode = childOf(roadNode, 'lanes');
        const laneOffsets = childrenOf(lanesNode, 'laneOffset').map(node => polyRecord(node, 's')).sort((a, b) => a.s - b.s);
        const laneOffsetAt = s => { const rec = recordAt(laneOffsets, s); return rec ? cubic(rec, s - rec.s) : 0; };
        const sectionNodes = childrenOf(lanesNode, 'laneSection').map(node => ({ node, s: num(node, 's') })).sort((a, b) => a.s - b.s);
        const breaks = [...line.geometries.flatMap(g => [g.s, g.s + g.length]), ...sectionNodes.map(section => section.s)];
        const forwardSide = rule === 'RHT' ? 'right' : 'left';

        const sections = [];
        sectionNodes.forEach((section, index) => {
            const s0 = section.s;
            const s1 = index + 1 < sectionNodes.length ? sectionNodes[index + 1].s : length;
            const span = s1 - s0;
            if (!(span > 1e-6)) return;
            const sideLanes = side => childrenOf(childOf(section.node, side), 'lane').map(node => {
                const widths = childrenOf(node, 'width').map(w => polyRecord(w, 'sOffset')).sort((a, b) => a.s - b.s);
                if (!widths.length && childrenOf(node, 'border').length) {
                    warnings.push(`road ${id}, lane ${node.attrs.id} at s=${round3(s0)}: lane borders (<border>) are not supported; the lane was dropped`);
                }
                return { id: num(node, 'id'), rawType: node.attrs.type || 'none', side, widthStart: laneWidthAt(widths, 0), widthEnd: laneWidthAt(widths, span) };
            });
            const left = sideLanes('left').filter(lane => lane.id > 0).sort((a, b) => b.id - a.id);  // outermost first
            const right = sideLanes('right').filter(lane => lane.id < 0).sort((a, b) => b.id - a.id); // innermost first
            const strips = [];
            const tapered = [];
            let L = 0;
            let R = 0;
            [...left, ...right].forEach(lane => {
                if (!Object.prototype.hasOwnProperty.call(OPENDRIVE_LANE_TYPES, lane.rawType)) {
                    unsupported.add(lane.rawType);
                    return;
                }
                const type = OPENDRIVE_LANE_TYPES[lane.rawType];
                if (!type) return;
                if (Math.abs(lane.widthEnd - lane.widthStart) > TAPER_WARN_M) tapered.push(`lane ${lane.id} (${lane.rawType}) ${round3(lane.widthStart)} → ${round3(lane.widthEnd)} m`);
                if (lane.widthEnd < MIN_LANE_WIDTH_M) return;
                if (lane.rawType === 'border' && lane.widthEnd < MIN_BORDER_VERGE_M) return;
                const strip = { type, width: round3(lane.widthEnd) };
                if (DIRECTIONAL.has(type)) strip.direction = lane.side === forwardSide ? 'forward' : 'backward';
                if (type === 'rail') strip.gauge = RAIL_GAUGE_MM;
                strips.push(strip);
                if (lane.side === 'left') L += lane.widthEnd; else R += lane.widthEnd;
            });
            if (tapered.length) {
                warnings.push(`road ${id}, lane section at s=${round3(s0)}: widths change along the section (${tapered.join('; ')}); imported at the section's end width, our transition zones redraw the taper`);
            }
            if (!strips.length) {
                warnings.push(`road ${id}, lane section at s=${round3(s0)}: no lanes left after dropping unsupported or too-narrow ones; skipped`);
                return;
            }
            const shift = (L - R) / 2;
            const points = sampleStations(s0, s1, breaks, step).map(s => {
                const p = line.at(s);
                const lateral = laneOffsetAt(s) + shift;
                return { x: p.x - Math.sin(p.hdg) * lateral, y: p.y + Math.cos(p.hdg) * lateral, hdg: p.hdg };
            });
            const typeRec = recordAt(types, s0);
            const highway = typeRec && Object.prototype.hasOwnProperty.call(OPENDRIVE_ROAD_TYPES, typeRec.type) ? OPENDRIVE_ROAD_TYPES[typeRec.type] : DEFAULT_HIGHWAY;
            const previous = sections[sections.length - 1];
            // Consecutive sections share their boundary node. Where the cross-section's middle moves
            // at the boundary (a lane added on one side), the boundary stays at the previous section's
            // end and the new middle starts from the next sample.
            if (previous && Math.abs(previous.s1 - s0) < 1e-6) points[0] = { ...previous.points[previous.points.length - 1] };
            sections.push({ s0, s1, points, profile: { strips }, highway });
        });
        return {
            id, name, sections,
            predecessor: linkOf(roadNode, 'predecessor'),
            successor: linkOf(roadNode, 'successor')
        };
    }

    // The end of a road touching a link: its outermost point and the unit tangent pointing out of it.
    function roadEnd(road, which) {
        if (!road.sections.length) return null;
        if (which === 'start') {
            const p = road.sections[0].points[0];
            return { point: p, tangent: { x: -Math.cos(p.hdg), y: -Math.sin(p.hdg) } };
        }
        const last = road.sections[road.sections.length - 1].points;
        const p = last[last.length - 1];
        return { point: p, tangent: { x: Math.cos(p.hdg), y: Math.sin(p.hdg) } };
    }
    function setRoadEnd(road, which, point, extend) {
        const start = which === 'start';
        const points = start ? road.sections[0].points : road.sections[road.sections.length - 1].points;
        const carried = { x: point.x, y: point.y, hdg: (start ? points[0] : points[points.length - 1]).hdg };
        if (extend) { if (start) points.unshift(carried); else points.push(carried); }
        else if (start) points[0] = carried;
        else points[points.length - 1] = carried;
    }

    // The point closest (least squares) to every line P + t·T of the road ends meeting at a junction.
    function junctionPoint(ends) {
        if (ends.length === 1) return { x: ends[0].point.x, y: ends[0].point.y };
        let a11 = 0; let a12 = 0; let a22 = 0; let b1 = 0; let b2 = 0;
        ends.forEach(({ point, tangent }) => {
            const m11 = 1 - tangent.x * tangent.x;
            const m12 = -tangent.x * tangent.y;
            const m22 = 1 - tangent.y * tangent.y;
            a11 += m11; a12 += m12; a22 += m22;
            b1 += m11 * point.x + m12 * point.y;
            b2 += m12 * point.x + m22 * point.y;
        });
        const det = a11 * a22 - a12 * a12;
        if (Math.abs(det) < 1e-9 * ends.length * ends.length) {
            return { x: ends.reduce((sum, e) => sum + e.point.x, 0) / ends.length, y: ends.reduce((sum, e) => sum + e.point.y, 0) / ends.length };
        }
        return { x: (a22 * b1 - a12 * b2) / det, y: (a11 * b2 - a12 * b1) / det };
    }

    // ---- entry -------------------------------------------------------------------------------------

    function parseOpenDrive(xmlText, options = {}) {
        const rootNode = parseXml(xmlText);
        if (rootNode.name !== 'OpenDRIVE') throw new Error(`OpenDRIVE: the document's root is <${rootNode.name}>, not <OpenDRIVE>`);
        const step = finite(options.sampleStepM) && options.sampleStepM > 0 ? options.sampleStepM : 2;
        const place = placementOf(childOf(rootNode, 'header'), options);
        const warnings = [];
        const unsupported = new Set();

        const roads = childrenOf(rootNode, 'road')
            .filter(node => !node.attrs.junction || node.attrs.junction.trim() === '-1' || node.attrs.junction.trim() === '')
            .map(node => buildRoad(node, step, warnings, unsupported))
            .filter(Boolean);
        unsupported.forEach(type => warnings.push(`lane type "${type}" is not supported; those lanes were dropped`));
        const byId = new Map(roads.map(road => [road.id, road]));

        // Junctions: every road end touching one meets the others at one shared node.
        const junctionEnds = new Map();
        roads.forEach(road => {
            [['start', road.predecessor], ['end', road.successor]].forEach(([which, link]) => {
                if (!link || link.elementType !== 'junction') return;
                const end = roadEnd(road, which);
                if (!end) return;
                const key = String(link.elementId);
                if (!junctionEnds.has(key)) junctionEnds.set(key, []);
                junctionEnds.get(key).push({ road, which, ...end });
            });
        });
        junctionEnds.forEach(ends => {
            const node = junctionPoint(ends);
            ends.forEach(end => setRoadEnd(end.road, end.which, node, true));
        });
        // Roads linked directly to roads: their contact points coincide; make them one point exactly.
        roads.forEach(road => {
            [['start', road.predecessor], ['end', road.successor]].forEach(([which, link]) => {
                if (!link || link.elementType !== 'road' || !byId.has(String(link.elementId))) return;
                const other = byId.get(String(link.elementId));
                const otherWhich = link.contactPoint === 'end' ? 'end' : 'start';
                const mine = roadEnd(road, which);
                const theirs = roadEnd(other, otherWhich);
                if (!mine || !theirs) return;
                if (Math.hypot(mine.point.x - theirs.point.x, mine.point.y - theirs.point.y) < LINK_SNAP_M) setRoadEnd(other, otherWhich, mine.point, false);
            });
        });

        // Placement and the OSM form.
        const osmForm = osmFormLib();
        const nodes = new Map();
        const nodeFor = point => {
            const { lat, lon } = place.toLatLon(point.x, point.y);
            const key = `${lat.toFixed(COORD_DECIMALS)},${lon.toFixed(COORD_DECIMALS)}`;
            if (!nodes.has(key)) nodes.set(key, { type: 'node', id: -(nodes.size + 1), lat, lon });
            return nodes.get(key).id;
        };
        const ways = [];
        const roadEntries = roads.map(road => {
            const wayIds = [];
            road.sections.forEach(section => {
                const nodeIds = section.points.map(nodeFor).filter((nodeId, index, all) => index === 0 || nodeId !== all[index - 1]);
                if (nodeIds.length < 2) {
                    warnings.push(`road ${road.id}, lane section at s=${round3(section.s0)} is shorter than a centimetre; skipped`);
                    return;
                }
                const railOnly = section.profile.strips.every(strip => strip.type === 'rail');
                const tags = { ...(osmForm.laneTagsOf(section.profile) || {}) };
                if (!railOnly) tags.highway = section.highway;
                if (road.name) tags.name = road.name;
                tags['cb:road'] = road.id;
                // laneTagsOf proves its tags against a class-less reading; with the class added, a
                // reading that would no longer give the lanes back gets them whole in `cb:lanes`.
                const readBack = osmForm.profileFromLaneTags(tags);
                if (!tags['cb:lanes'] && JSON.stringify(readBack) !== JSON.stringify(osmForm.profileFromLaneTags({ 'cb:lanes': section.profile.strips.map(osmForm.encodeLane).join('|') }))) {
                    tags['cb:lanes'] = section.profile.strips.map(osmForm.encodeLane).join('|');
                }
                const way = { type: 'way', id: -(ways.length + 1), nodes: nodeIds, tags };
                ways.push(way);
                wayIds.push(way.id);
            });
            return { id: road.id, name: road.name, wayIds };
        });

        return {
            form: { version: 0.6, generator: 'consensus-builder', elements: [...nodes.values(), ...ways] },
            roads: roadEntries,
            placement: place.placement,
            warnings
        };
    }

    return { parseOpenDrive, parseXml, OPENDRIVE_LANE_TYPES, OPENDRIVE_ROAD_TYPES };
});
