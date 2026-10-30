// City model reader shared by the browser and the backend: CityGML 1.0/2.0 and CityJSON 1.x/2.0
// buildings → one building shape ({ id, name, attributes, measuredHeightM, roofType, storeysAboveGround,
// function, usage, surfaces: [{ kind, rings }] }) in the file's coordinates; mesh records for the 3D
// view; footprints (WGS84 GeoJSON) for the building editors; the file's coordinate system. Pure: the
// XML events come from the caller (saxes in node, a DOMParser walk in the browser).
(function (global) {
    'use strict';

    const SEMANTIC = { WallSurface: 'wall', RoofSurface: 'roof', GroundSurface: 'ground', ClosureSurface: 'closure',
        OuterCeilingSurface: 'roof', OuterFloorSurface: 'ground', FloorSurface: 'floor', CeilingSurface: 'ceiling',
        InteriorWallSurface: 'interior' };

    function finite(value) {
        const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
        return typeof number === 'number' && Number.isFinite(number) ? number : null;
    }

    // ---- CityGML ----
    // Fed open(name, attribute)/text(text)/close(name) with local element names; buildings() at the end.
    // A building's parts belong to it. Semantic surfaces are taken when a building has any; otherwise
    // its geometry's polygons, as kind "surface", so a LOD1 solid still draws.
    function createCityGmlCollector() {
        const buildings = [], stack = [];
        let building = null, depth = 0, polygon = null, ring = null, chars = '', attribute = null, semantic = [], dimension = 3;
        function open(name, attr) {
            stack.push(name);
            chars = '';
            if (name === 'Building' && !building) {
                building = { id: attr('gml:id') || attr('id') || null, name: null, attributes: {}, measuredHeightM: null, roofType: null,
                    storeysAboveGround: null, function: null, usage: null, semanticSurfaces: [], otherSurfaces: [] };
                depth = stack.length;
            }
            if (!building) return;
            if (SEMANTIC[name]) semantic.push(SEMANTIC[name]);
            if (name === 'stringAttribute' || name === 'intAttribute' || name === 'doubleAttribute') attribute = attr('name') || null;
            if (name === 'Polygon') polygon = { kind: semantic[semantic.length - 1] || null, rings: [] };
            if ((name === 'posList' || name === 'pos') && attr('srsDimension')) dimension = Number(attr('srsDimension')) || 3;
            if (name === 'LinearRing') ring = [];
        }
        function text(value) { chars += value; }
        function close(name) {
            const parent = stack[stack.length - 2];
            if (building) {
                const value = chars.trim();
                if ((name === 'posList' || name === 'pos') && ring) ring.push(...triples(value, dimension));
                else if (name === 'LinearRing' && polygon && ring) { if (ring.length >= 3) polygon.rings.push(ring); ring = null; }
                else if (name === 'Polygon' && polygon) {
                    if (polygon.rings.length) (polygon.kind ? building.semanticSurfaces : building.otherSurfaces).push(polygon);
                    polygon = null;
                } else if (SEMANTIC[name]) semantic.pop();
                else if (name === 'value' && attribute) { building.attributes[attribute] = value; attribute = null; }
                else if (name === 'name' && parent === 'Building' && stack.length === depth + 1) building.name = value;
                else if (name === 'measuredHeight' && building.measuredHeightM == null) building.measuredHeightM = finite(value);
                else if (name === 'roofType' && !building.roofType) building.roofType = value;
                else if (name === 'storeysAboveGround' && building.storeysAboveGround == null) building.storeysAboveGround = finite(value);
                else if (name === 'function' && !building.function) building.function = value;
                else if (name === 'usage' && !building.usage) building.usage = value;
                if (name === 'Building' && stack.length === depth) {
                    const { semanticSurfaces, otherSurfaces, ...rest } = building;
                    const surfaces = semanticSurfaces.length ? semanticSurfaces : otherSurfaces.map(surface => ({ ...surface, kind: 'surface' }));
                    if (surfaces.length) buildings.push({ ...rest, surfaces });
                    building = null; semantic = [];
                }
            }
            stack.pop();
            chars = '';
        }
        return { open, text, close, buildings: () => buildings };
    }

    function triples(text, dimension) {
        const numbers = text.split(/\s+/).filter(Boolean).map(Number);
        if (dimension !== 3 || numbers.length % 3 || numbers.some(n => !Number.isFinite(n))) {
            throw new Error(`CityGML coordinates must be finite 3D triples (srsDimension ${dimension}).`);
        }
        const points = [];
        for (let i = 0; i < numbers.length; i += 3) points.push([numbers[i], numbers[i + 1], numbers[i + 2]]);
        return points;
    }

    const localName = name => name.slice(name.indexOf(':') + 1);

    // CityGML text → buildings through the browser's DOMParser.
    function parseCityGmlDom(text, DOMParserImpl = global && global.DOMParser) {
        if (!DOMParserImpl) throw new Error('parseCityGmlDom needs a DOMParser.');
        const doc = new DOMParserImpl().parseFromString(text, 'application/xml');
        const error = doc.getElementsByTagName('parsererror')[0];
        if (error) throw new Error(`The file is not valid XML: ${error.textContent.trim().slice(0, 200)}`);
        const collector = createCityGmlCollector();
        (function walk(node) {
            if (node.nodeType === 3 || node.nodeType === 4) { collector.text(node.nodeValue); return; }
            if (node.nodeType !== 1) return;
            const name = node.localName || localName(node.nodeName);
            collector.open(name, attributeName => node.getAttribute(attributeName));
            for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
            collector.close(name);
        })(doc.documentElement);
        return collector.buildings();
    }

    // ---- CityJSON ----
    // doc: a CityJSON object, or { transform | metadata.transform, features: [CityJSONFeature] }.
    // A building's parts join it; each object draws its most detailed geometry up to maxLod.
    function parseCityJson(doc, { maxLod = Infinity } = {}) {
        if (!doc || typeof doc !== 'object') throw new Error('CityJSON must be an object.');
        const pieces = doc.type === 'CityJSON' && !Array.isArray(doc.features)
            ? [{ CityObjects: doc.CityObjects || {}, vertices: doc.vertices || [] }]
            : (doc.features || []).map(feature => {
                if (!feature || feature.type !== 'CityJSONFeature') throw new Error('Expected CityJSONFeature items.');
                return feature;
            });
        const transform = doc.transform || (doc.metadata && doc.metadata.transform) || null;
        const buildings = [];
        for (const piece of pieces) {
            const real = realVertices(piece.vertices, transform);
            const objects = piece.CityObjects || {};
            for (const [id, object] of Object.entries(objects)) {
                if (object.type !== 'Building') continue;
                const members = [object, ...(object.children || []).map(child => objects[child]).filter(part => part && part.type === 'BuildingPart')];
                // A LoD 0 footprint stands in only when no member has a body (3D BAG keeps one on the
                // building and the solids on its part): taken together, the ground would count twice.
                const picks = members.map(member => bestGeometry(member.geometry, maxLod)).filter(Boolean);
                const bodies = picks.filter(geometry => Number(geometry.lod) > 0);
                const surfaces = (bodies.length ? bodies : picks).flatMap(geometry => surfacesOf(geometry, real));
                if (!surfaces.length) continue;
                const attributes = object.attributes || {};
                buildings.push({
                    id, name: attributes.name != null ? attributes.name : null, attributes,
                    measuredHeightM: finite(attributes.measuredHeight),
                    roofType: attributes.roofType != null ? attributes.roofType : null,
                    storeysAboveGround: finite(attributes.storeysAboveGround),
                    function: attributes.function != null ? attributes.function : null,
                    usage: attributes.usage != null ? attributes.usage : null,
                    surfaces
                });
            }
        }
        return buildings;
    }

    function realVertices(vertices, transform) {
        if (!Array.isArray(vertices)) throw new Error('CityJSON vertices must be an array.');
        const scale = (transform && transform.scale) || [1, 1, 1], translate = (transform && transform.translate) || [0, 0, 0];
        return vertices.map(([x, y, z]) => [x * scale[0] + translate[0], y * scale[1] + translate[1], z * scale[2] + translate[2]]);
    }

    // The most detailed geometry of one object up to maxLod.
    function bestGeometry(geometries, maxLod) {
        let best = null, bestLod = -Infinity;
        for (const geometry of geometries || []) {
            const lod = Number(geometry.lod);
            if (!Number.isFinite(lod) || lod > maxLod || geometry.type === 'GeometryInstance') continue;
            if (lod > bestLod) { best = geometry; bestLod = lod; }
        }
        return best;
    }

    function surfacesOf(geometry, vertices) {
        const semantics = geometry.semantics;
        const kindOf = index => {
            const surface = index == null ? null : semantics && semantics.surfaces && semantics.surfaces[index];
            return (surface && SEMANTIC[surface.type]) || (Number(geometry.lod) === 0 ? 'ground' : 'surface');
        };
        const ring = indices => indices.map(index => {
            const point = vertices[index];
            if (!point) throw new Error(`CityJSON vertex ${index} does not exist.`);
            return point;
        });
        const surface = (boundary, value) => ({ kind: kindOf(value), rings: boundary.map(ring).filter(points => points.length >= 3) });
        const values = semantics && semantics.values;
        const at = (array, ...indices) => indices.reduce((value, index) => (value == null ? null : value[index]), array);
        const out = [];
        switch (geometry.type) {
            case 'MultiSurface': case 'CompositeSurface':
                geometry.boundaries.forEach((boundary, s) => out.push(surface(boundary, at(values, s))));
                break;
            case 'Solid':
                geometry.boundaries.forEach((shell, h) => shell.forEach((boundary, s) => out.push(surface(boundary, at(values, h, s)))));
                break;
            case 'MultiSolid': case 'CompositeSolid':
                geometry.boundaries.forEach((solid, d) => solid.forEach((shell, h) => shell.forEach((boundary, s) =>
                    out.push(surface(boundary, at(values, d, h, s))))));
                break;
            default:
                return [];
        }
        return out.filter(entry => entry.rings.length);
    }

    // ---- Coordinate systems ----
    // The common city-model systems; UTM (WGS84 326zz/327zz, ETRS89 258zz) follow from their code.
    // zToMetres converts heights stated in feet.
    const CRS = {
        31254: '+proj=tmerc +lat_0=0 +lon_0=10.33333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs',
        31255: '+proj=tmerc +lat_0=0 +lon_0=13.33333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs',
        31256: '+proj=tmerc +lat_0=0 +lon_0=16.33333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs',
        28992: '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs',
        3765: '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
        3879: '+proj=tmerc +lat_0=0 +lon_0=25 +k=1 +x_0=25500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
        2056: '+proj=somerc +lat_0=46.95240555555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs',
        2154: '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
        31370: '+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs',
        2263: '+proj=lcc +lat_0=40.1666666666667 +lon_0=-74 +lat_1=41.0333333333333 +lat_2=40.6666666666667 +x_0=300000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs',
        4326: '+proj=longlat +datum=WGS84 +no_defs'
    };
    const FEET = { 2263: 0.3048006096012192 };
    // Compound systems name their horizontal part: 7415 is 28992 + NAP heights.
    const COMPOUND = { 7415: 28992 };

    function crsDefinition(code) {
        const n = COMPOUND[code] || code;
        if (CRS[n]) return { code: n, definition: CRS[n], zToMetres: FEET[n] || 1 };
        const zone = n % 100;
        if (zone >= 1 && zone <= 60) {
            if (n - zone === 32600) return { code: n, definition: `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`, zToMetres: 1 };
            if (n - zone === 32700) return { code: n, definition: `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`, zToMetres: 1 };
            if (n - zone === 25800) return { code: n, definition: `+proj=utm +zone=${zone} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`, zToMetres: 1 };
        }
        return null;
    }

    // The EPSG codes a CRS name lists ("EPSG:25832", "urn:ogc:def:crs,crs:EPSG::31256,crs:EPSG::5778",
    // "https://www.opengis.net/def/crs/EPSG/0/7415"), horizontal first as written.
    function epsgCodes(name) {
        return String(name || '').match(/EPSG(?::+|\/0\/|::?)(\d{4,5})/gi)?.map(part => Number(part.match(/(\d{4,5})$/)[1])) || [];
    }

    function crsOf(name) {
        const codes = epsgCodes(name);
        for (const code of codes) {
            const known = crsDefinition(code);
            if (known) return known;
        }
        throw Object.assign(new Error(codes.length
            ? `The file's coordinate system (EPSG:${codes.join(' + EPSG:')}) is not one we can read yet.`
            : 'The file does not say which coordinate system it uses.'), { code: 'unsupported-crs', codes });
    }

    // ---- Reading a file ----
    // text → { format, crs, buildings } or null when the text is neither CityJSON nor CityGML.
    // parseGml(text) parses CityGML (default: the browser DOM walk).
    function readCityModel(text, { parseGml = parseCityGmlDom, maxLod = Infinity } = {}) {
        const trimmed = String(text || '').replace(/^﻿/, '').trimStart();
        if (trimmed.startsWith('{')) {
            let doc;
            try { doc = JSON.parse(trimmed); } catch (_) { return null; }
            if (doc.type !== 'CityJSON') return null;
            const reference = doc.metadata && doc.metadata.referenceSystem;
            return { format: 'cityjson', crs: crsOf(reference), buildings: parseCityJson(doc, { maxLod }) };
        }
        if (trimmed.startsWith('<') && /CityModel/.test(trimmed.slice(0, 4000))) {
            const srs = (trimmed.match(/srsName="([^"]+)"/) || [])[1];
            return { format: 'citygml', crs: crsOf(srs), buildings: parseGml(trimmed) };
        }
        return null;
    }

    // ---- Output ----
    // A building → the 3D view's { object_id, z_min, z_max, faces } and its footprint (the ground
    // surfaces as a MultiPolygon, or null). toLngLat(x, y) → [lng, lat]; heightOffsetM moves the
    // source's height datum to metres above sea level; zToMetres converts heights stated in feet.
    function buildingRecord(building, toLngLat, { heightOffsetM = 0, idPrefix = '', zToMetres = 1 } = {}) {
        let zMin = Infinity, zMax = -Infinity;
        const project = point => {
            const [lng, lat] = toLngLat(point[0], point[1]);
            const z = point[2] * zToMetres + heightOffsetM;
            if (z < zMin) zMin = z;
            if (z > zMax) zMax = z;
            return [round(lng, 1e7), round(lat, 1e7), round(z, 1e3)];
        };
        const faces = [], ground = [];
        for (const surface of building.surfaces) {
            const rings = surface.rings.map(ring => closed(ring.map(project)));
            faces.push({ type: 'Polygon', coordinates: rings, kind: surface.kind });
            if (surface.kind === 'ground') ground.push(rings.map(ring => ring.map(([lng, lat]) => [lng, lat])));
        }
        if (!faces.length) return null;
        const id = `${idPrefix}${building.id || building.name}`;
        return {
            record: { object_id: id, z_min: round(zMin, 1e3), z_max: round(zMax, 1e3), faces },
            footprint: ground.length ? { type: 'MultiPolygon', coordinates: ground } : null,
            heightM: building.measuredHeightM != null ? building.measuredHeightM * zToMetres : round(zMax - zMin, 1e3),
            storeys: building.storeysAboveGround
        };
    }

    // A read model's buildings as WGS84 footprint features for the building editors: one Polygon per
    // building (its ground surfaces joined), with height, storeys and name. A building without ground
    // surfaces uses the outline of all its faces seen from above. toLngLat(x, y) → [lng, lat].
    function footprintFeatures(model, { toLngLat, turf }) {
        const features = [];
        for (const building of model.buildings) {
            const entry = buildingRecord(building, toLngLat, { zToMetres: model.crs.zToMetres });
            if (!entry) continue;
            const pieces = entry.footprint ? entry.footprint.coordinates
                : entry.record.faces.map(face => face.coordinates.map(ring => ring.map(([lng, lat]) => [lng, lat])));
            let outline = null;
            for (const rings of pieces) {
                let piece;
                try { piece = turf.polygon(rings); } catch (_) { continue; }
                if (!(turf.area(piece) > 0.01)) continue;
                outline = outline ? (turf.union(outline, piece) || outline) : piece;
            }
            if (!outline) continue;
            const polygons = outline.geometry.type === 'Polygon' ? [outline.geometry.coordinates] : outline.geometry.coordinates;
            const largest = polygons.map(coordinates => ({ coordinates, area: turf.area(turf.polygon(coordinates)) }))
                .sort((a, b) => b.area - a.area)[0];
            const properties = { height: round(entry.heightM, 100) };
            if (entry.storeys) properties.storeys = entry.storeys;
            if (building.name) properties.name = String(building.name).slice(0, 120);
            if (building.function) properties.function = building.function;
            features.push({ type: 'Feature', ...(building.id ? { id: String(building.id) } : {}), properties, geometry: { type: 'Polygon', coordinates: largest.coordinates } });
        }
        return { type: 'FeatureCollection', features };
    }

    // The text of a file chosen in a building editor → GeoJSON: GeoJSON as it is, a CityGML or CityJSON
    // city model as its buildings' footprints. Throws on anything else, and on a city model without
    // buildings. proj4 and turf come from the caller (browser globals).
    function geoJsonFromFileText(text, { proj4, turf, parseGml = parseCityGmlDom }) {
        const model = readCityModel(text, { parseGml });
        if (!model) return JSON.parse(String(text).replace(/^\uFEFF/, ''));
        const transform = proj4(model.crs.definition, 'EPSG:4326');
        const collection = footprintFeatures(model, { toLngLat: (x, y) => transform.forward([x, y]), turf });
        if (!collection.features.length) throw new Error('The city model holds no building with a footprint.');
        return collection;
    }

    // ---- A building as a model ----
    const MODEL_COLOURS = { roof: [0.62, 0.36, 0.3, 1], wall: [0.86, 0.84, 0.79, 1], other: [0.62, 0.62, 0.6, 1] };

    // One building → a self-contained GLB (glTF 2.0: Y up, metres, x east, −z north, centred on its
    // box) and where it stands: center { lat, lng } of the box, rotationDeg (counterclockwise, the
    // grid's convergence from true north) and heightM. Faces keep their kind as roof, wall or other
    // material. toLngLat(x, y) → [lng, lat] in the model's CRS; unitToMetres converts feet CRSs;
    // triangulate(contour, holes) → index triples into contour.concat(...holes), with [x, y] points.
    function buildingGlb(building, { toLngLat, unitToMetres = 1, triangulate }) {
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const surface of building.surfaces) for (const ring of surface.rings) for (const [x, y, z] of ring) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }
        if (!Number.isFinite(minX)) throw Object.assign(new Error('The building has no geometry.'), { code: 'empty' });
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        // The grid's local scale and its north at the centre, measured on 100 units of grid north.
        const [lng0, lat0] = toLngLat(cx, cy), [lngN, latN] = toLngLat(cx, cy + 100);
        const east = (lngN - lng0) * 111320 * Math.cos(lat0 * Math.PI / 180), north = (latN - lat0) * 110574;
        const scale = Math.hypot(east, north) / (100 * unitToMetres) * unitToMetres;
        const rotationDeg = -Math.atan2(east, north) * 180 / Math.PI;
        const groups = { roof: [], wall: [], other: [] };
        for (const surface of building.surfaces) {
            const local = surface.rings.map(ring => {
                const open = ring.length > 1 && ring[0].every((value, i) => value === ring[ring.length - 1][i]) ? ring.slice(0, -1) : ring;
                return open.map(([x, y, z]) => [(x - cx) * scale, (z - minZ) * unitToMetres, -(y - cy) * scale]);
            });
            if (!local[0] || local[0].length < 3) continue;
            const normal = newellNormal(local[0]);
            const length = Math.hypot(...normal);
            if (!(length > 1e-9)) continue;
            const n = normal.map(value => value / length);
            // Drop the axis the face is most perpendicular to; flip so the 2D contour keeps its winding.
            const axis = [0, 1, 2].reduce((best, i) => Math.abs(n[i]) > Math.abs(n[best]) ? i : best, 0);
            const [u, v] = [[1, 2], [2, 0], [0, 1]][axis];
            const flat = ring => ring.map(point => n[axis] >= 0 ? [point[u], point[v]] : [point[v], point[u]]);
            const triangles = triangulate(flat(local[0]), local.slice(1).map(flat));
            const points = [].concat(...local);
            const group = groups[surface.kind === 'roof' ? 'roof' : surface.kind === 'wall' ? 'wall' : 'other'];
            for (const triangle of triangles) for (const index of triangle) group.push(points[index], n);
        }
        return {
            glb: writeGlb(groups),
            center: { lat: lat0, lng: lng0 },
            rotationDeg: Math.round(rotationDeg * 1e4) / 1e4,
            heightM: Math.round((maxZ - minZ) * unitToMetres * 100) / 100
        };
    }

    function newellNormal(ring) {
        const normal = [0, 0, 0];
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
            normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
            normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
        }
        return normal;
    }

    // groups: { roof|wall|other: [position, normal, position, normal, …] } → GLB bytes, one primitive per
    // non-empty group with its own material.
    function writeGlb(groups) {
        const json = { asset: { version: '2.0', generator: 'Urban Game Theory city-model-reader' }, scene: 0, scenes: [{ nodes: [0] }],
            nodes: [{ mesh: 0 }], meshes: [{ primitives: [] }], materials: [], accessors: [], bufferViews: [], buffers: [] };
        const chunks = [];
        let offset = 0;
        for (const [kind, entries] of Object.entries(groups)) {
            if (!entries.length) continue;
            const count = entries.length / 2;
            const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < count; i++) {
                const p = entries[i * 2], n = entries[i * 2 + 1];
                for (let k = 0; k < 3; k++) {
                    positions[i * 3 + k] = p[k]; normals[i * 3 + k] = n[k];
                    min[k] = Math.min(min[k], Math.fround(p[k])); max[k] = Math.max(max[k], Math.fround(p[k]));
                }
            }
            const attributes = {};
            for (const [name, array, extra] of [['POSITION', positions, { min, max }], ['NORMAL', normals, {}]]) {
                json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: array.byteLength, target: 34962 });
                json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count, type: 'VEC3', ...extra });
                attributes[name] = json.accessors.length - 1;
                chunks.push(new Uint8Array(array.buffer));
                offset += array.byteLength;
            }
            json.materials.push({ name: kind, pbrMetallicRoughness: { baseColorFactor: MODEL_COLOURS[kind], metallicFactor: 0, roughnessFactor: 0.9 },
                doubleSided: true });
            json.meshes[0].primitives.push({ attributes, material: json.materials.length - 1, mode: 4 });
        }
        if (!json.meshes[0].primitives.length) throw Object.assign(new Error('The building has no faces.'), { code: 'empty' });
        json.buffers.push({ byteLength: offset });
        const encoder = new TextEncoder();
        let jsonBytes = encoder.encode(JSON.stringify(json));
        const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20);
        jsonPadded.set(jsonBytes);
        const binLength = Math.ceil(offset / 4) * 4;
        const total = 12 + 8 + jsonPadded.length + 8 + binLength;
        const out = new Uint8Array(total), view = new DataView(out.buffer);
        view.setUint32(0, 0x46546C67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
        view.setUint32(12, jsonPadded.length, true); view.setUint32(16, 0x4E4F534A, true);
        out.set(jsonPadded, 20);
        let at = 20 + jsonPadded.length;
        view.setUint32(at, binLength, true); view.setUint32(at + 4, 0x004E4942, true);
        at += 8;
        for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
        return out;
    }

    // The message for a city model whose coordinate system cannot be read, or null for other errors.
    // i18n: the page's translator ({ t(key, params) }), or null for English.
    function crsErrorMessage(error, i18n) {
        if (!error || error.code !== 'unsupported-crs') return null;
        const crs = (error.codes || []).map(code => `EPSG:${code}`).join(' + ');
        const [key, fallback] = crs
            ? ['common.cityModelCrsUnsupported', `The file's coordinate system (${crs}) is not one we can read yet.`]
            : ['common.cityModelCrsMissing', 'The file does not say which coordinate system it uses.'];
        const translated = i18n && typeof i18n.t === 'function' ? i18n.t(key, { crs }) : key;
        return translated && translated !== key ? translated : fallback;
    }

    function closed(ring) {
        const first = ring[0], last = ring[ring.length - 1];
        return first[0] === last[0] && first[1] === last[1] && first[2] === last[2] ? ring : [...ring, first];
    }

    function round(value, scale) {
        return Math.round(value * scale) / scale;
    }

    const api = { createCityGmlCollector, parseCityGmlDom, parseCityJson, crsDefinition, crsOf, epsgCodes,
        readCityModel, buildingRecord, footprintFeatures, geoJsonFromFileText, crsErrorMessage, buildingGlb };
    if (global) global.CityModelReader = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
