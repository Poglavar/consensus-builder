// IFC building models (ISO 16739: what Revit, ArchiCAD, Allplan, Vectorworks and SketchUp Pro export)
// → the self-contained GLB an uploaded glTF model is, and where the file says the building stands.
// web-ifc parses the file; the caller passes its module (the browser loads it from the CDN on first use,
// the backend from npm). Everything after its meshes is plain arithmetic, shared by Upload model
// (building-upload.js) and MCP ugt_import_model. UMD: window.IfcModelReader, or require() in node.
(function (global) {
    'use strict';

    const cityModels = () => (global && global.CityModelReader) || require('./city-model-reader.js');
    const modelGeometry = () => (global && global.BuildingModelGeometry) || require('./building-model-geometry.js');

    // The browser's web-ifc; the backend pins the same version in backend/package.json.
    const WEB_IFC_VERSION = '0.0.77';
    const WEB_IFC_BASE = `https://cdn.jsdelivr.net/npm/web-ifc@${WEB_IFC_VERSION}/`;
    const WEB_IFC_URL = `${WEB_IFC_BASE}web-ifc-api.js`;
    // The /models upload limit (backend/routes/file-storage.js) less room for the GLB's JSON.
    const MAX_GLB_BYTES = 10 * 1024 * 1024 - 64 * 1024;
    // The envelope is what the building looks like from outside. Every other building element (doors,
    // stairs, railings, generic objects) is detail: kept only inside the envelope's plan, and left out,
    // the heaviest kind first, when the model is over the size limits.
    const ENVELOPE = new Set(['IFCWALL', 'IFCCURTAINWALL', 'IFCSLAB', 'IFCROOF', 'IFCWINDOW', 'IFCPLATE', 'IFCMEMBER',
        'IFCCOLUMN', 'IFCBEAM', 'IFCCOVERING', 'IFCCHIMNEY', 'IFCSHADINGDEVICE']);
    // Detail reaching this far past the envelope's plan still counts as inside it (metres).
    const DETAIL_MARGIN_M = 0.5;
    const LENGTH_PREFIX = { KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6 };

    function fail(code, message, detail) {
        throw Object.assign(new Error(message), { code }, detail ? { detail } : {});
    }

    // True for the start of an IFC STEP file (its first few kB as text).
    function looksLikeIfc(head) {
        const text = String(head || '').replace(/^﻿/, '').trimStart();
        return text.startsWith('ISO-10303-21;') && /FILE_SCHEMA\s*\(\s*\(\s*'IFC/i.test(text.slice(0, 8000));
    }

    const num = value => {
        const n = value && typeof value === 'object' ? value.value : value;
        return typeof n === 'number' && Number.isFinite(n) ? n : null;
    };

    // An IfcCompoundPlaneAngleMeasure (degrees, minutes, seconds, millionths of a second, one sign) →
    // decimal degrees, or null when absent.
    function compoundAngle(parts) {
        const values = (Array.isArray(parts) ? parts : parts?.value || []).map(num);
        if (!values.length || values.some(value => value === null)) return null;
        const [d, m = 0, s = 0, us = 0] = values;
        return d + m / 60 + (s + us / 1e6) / 3600;
    }

    // Metres per unit of an IfcSIUnit or IfcConversionBasedUnit (flattened web-ifc line), or null.
    function unitMetres(unit) {
        if (!unit) return null;
        if (unit.ConversionFactor) {
            const factor = num(unit.ConversionFactor.ValueComponent);
            const base = unitMetres(unit.ConversionFactor.UnitComponent);
            return factor !== null && base !== null ? factor * base : null;
        }
        if (unit.Name?.value !== 'METRE') return null;
        return unit.Prefix?.value ? LENGTH_PREFIX[unit.Prefix.value] ?? null : 1;
    }

    function projectLengthUnit(api, W, model) {
        const projects = api.GetLineIDsWithType(model, W.IFCPROJECT);
        if (!projects.size()) return 1;
        const units = api.GetLine(model, projects.get(0), true).UnitsInContext?.Units || [];
        const length = units.find(unit => unit?.UnitType?.value === 'LENGTHUNIT');
        return unitMetres(length) ?? 1;
    }

    // ---- Where the file says the building stands ----
    // IFC4's IfcMapConversion: a deliberate georeference to a projected CRS.
    function readMapConversion(api, W, model) {
        const ids = api.GetLineIDsWithType(model, W.IFCMAPCONVERSION);
        if (!ids.size()) return null;
        const line = api.GetLine(model, ids.get(0), true);
        const eastings = num(line.Eastings), northings = num(line.Northings);
        if (eastings === null || northings === null) return null;
        return { eastings, northings, abscissa: num(line.XAxisAbscissa) ?? 1, ordinate: num(line.XAxisOrdinate) ?? 0,
            scale: num(line.Scale), crsName: line.TargetCRS?.Name?.value || '', mapUnitMetres: unitMetres(line.TargetCRS?.MapUnit) ?? 1 };
    }

    // IfcSite's reference latitude and longitude (at the site's placement) and the model context's true
    // north. Design tools fill these from a template, so the caller decides whether they are plausible.
    function readSiteReference(api, W, model, unit) {
        for (const id of api.GetLineIDsWithType(model, W.IFCSITE)) {
            const site = api.GetLine(model, id);
            const lat = compoundAngle(site.RefLatitude), lng = compoundAngle(site.RefLongitude);
            if (lat === null || lng === null || (lat === 0 && lng === 0) || Math.abs(lat) > 85 || Math.abs(lng) > 180) continue;
            const matrix = site.ObjectPlacement ? api.GetWorldTransformMatrix(model, site.ObjectPlacement.value) : null;
            let trueNorth = null;
            for (const context of api.GetLineIDsWithType(model, W.IFCGEOMETRICREPRESENTATIONCONTEXT)) {
                const ratios = api.GetLine(model, context, true).TrueNorth?.DirectionRatios?.map(num);
                if (ratios && ratios[0] !== null && ratios[1] !== null && Math.hypot(ratios[0], ratios[1]) > 1e-9) { trueNorth = ratios.slice(0, 2); break; }
            }
            return { lat, lng, origin: matrix ? [matrix[12] * unit, matrix[13] * unit] : [0, 0], trueNorth };
        }
        return null;
    }

    // Where a point of the model stands and which way its x axis points: lngLatAt([x, y]) → [lng, lat] for
    // model metres (IFC plan axes). rotationDeg is counterclockwise from east, as placeModelFootprint takes.
    function orientedPlacement(lngLatAt, [x, y]) {
        const [lng0, lat0] = lngLatAt([x, y]), [lng1, lat1] = lngLatAt([x + 10, y]);
        // Metres per degree on the WGS84 ellipsoid at this latitude (meridian and prime-vertical radii).
        const phi = lat0 * Math.PI / 180, e2 = 0.00669437999014, w = 1 - e2 * Math.sin(phi) ** 2;
        const perDegree = Math.PI / 180 * 6378137;
        const east = (lng1 - lng0) * perDegree * Math.cos(phi) / Math.sqrt(w), north = (lat1 - lat0) * perDegree * (1 - e2) / w ** 1.5;
        return { center: { lng: lng0, lat: lat0 }, rotationDeg: Math.round(Math.atan2(north, east) * 180 / Math.PI * 1e4) / 1e4 };
    }

    // The map conversion's E = E0 + s·(a·x − b·y), N = N0 + s·(b·x + a·y), with x, y in project units. An
    // absent Scale means the project and map units alone convert (what exporters writing millimetres mean).
    function mapConversionPlacement(conversion, centre, { unitMetres: unit, toLngLat }) {
        const length = Math.hypot(conversion.abscissa, conversion.ordinate) || 1;
        const a = conversion.abscissa / length, b = conversion.ordinate / length;
        const perMetre = (conversion.scale ?? unit / conversion.mapUnitMetres) / unit;
        const lngLatAt = ([x, y]) => toLngLat(conversion.eastings + perMetre * (a * x - b * y), conversion.northings + perMetre * (b * x + a * y));
        return { ...orientedPlacement(lngLatAt, centre), source: 'map-conversion' };
    }

    // A site reference point: true north (tx, ty) in model axes makes east (ty, −tx); a local transverse
    // Mercator at the reference point turns metres into degrees.
    function siteReferencePlacement(site, centre, { proj4 }) {
        const [tx, ty] = site.trueNorth ? site.trueNorth.map(value => value / Math.hypot(...site.trueNorth)) : [0, 1];
        const local = proj4(`+proj=tmerc +lat_0=${site.lat} +lon_0=${site.lng} +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`, 'EPSG:4326');
        const lngLatAt = ([x, y]) => {
            const dx = x - site.origin[0], dy = y - site.origin[1];
            return local.forward([dx * ty - dy * tx, dx * tx + dy * ty]);
        };
        return { ...orientedPlacement(lngLatAt, centre), source: 'site-reference' };
    }

    // ---- Meshes ----
    // An element's IFC class without the StandardCase/ElementedCase variants (IfcWall, IfcDoor, …).
    function categoryOf(api, model, expressID) {
        return String(api.GetNameFromTypeCode(api.GetLineType(model, expressID)) || '').replace(/(StandardCase|ElementedCase)$/i, '');
    }

    // Calls visit(element, geometry) for each placed geometry of the elements, with its world-space
    // vertices (Y up, metres: web-ifc applies the unit and turns IFC's z up into y).
    function streamGeometry(api, model, ids, visit) {
        api.StreamMeshes(model, ids, mesh => {
            for (let i = 0; i < mesh.geometries.size(); i++) {
                const placed = mesh.geometries.get(i);
                const geometry = api.GetGeometry(model, placed.geometryExpressID);
                try {
                    visit(mesh.expressID, {
                        vertices: api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize()),
                        indices: api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize()),
                        matrix: placed.flatTransformation,
                        colour: [placed.color.x, placed.color.y, placed.color.z, placed.color.w]
                    });
                } finally { geometry.delete(); }
            }
        });
    }

    const colourKey = colour => colour.map(value => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000).join(',');

    // First pass: per element, its kind, cost and plan box, and its vertex and index counts per colour.
    function surveyElements(api, model, ids) {
        const elements = new Map();
        streamGeometry(api, model, ids, (id, { vertices, indices, matrix, colour }) => {
            let element = elements.get(id);
            if (!element) {
                element = { id, category: categoryOf(api, model, id), triangles: 0, vertices: 0, colours: new Map(),
                    min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
                elements.set(id, element);
            }
            const m = matrix;
            for (let k = 0; k < vertices.length; k += 6) {
                const x = vertices[k], y = vertices[k + 1], z = vertices[k + 2];
                const p = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
                for (let a = 0; a < 3; a++) {
                    if (p[a] < element.min[a]) element.min[a] = p[a];
                    if (p[a] > element.max[a]) element.max[a] = p[a];
                }
            }
            const key = colourKey(colour), counts = element.colours.get(key) || { colour, vertices: 0, indices: 0 };
            counts.vertices += vertices.length / 6;
            counts.indices += indices.length;
            element.colours.set(key, counts);
            element.triangles += indices.length / 3;
            element.vertices += vertices.length / 6;
        });
        return [...elements.values()].filter(element => element.triangles > 0);
    }

    const bytesOf = element => element.vertices * 24 + element.triangles * 12;

    // Which elements make the model: the envelope, then whole kinds of detail inside its plan, cheapest
    // kind first, while the model stays within the footprint's triangle limit and the upload limit.
    function selectElements(elements, { maxTriangles, maxBytes }) {
        const envelope = elements.filter(element => ENVELOPE.has(element.category.toUpperCase()));
        // A model of generic objects only (as simple exporters write) is all envelope.
        const shell = envelope.length ? envelope : elements;
        const plan = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
        for (const element of shell) for (const [a, axis] of [[0, 0], [2, 1]]) {
            plan.min[axis] = Math.min(plan.min[axis], element.min[a]);
            plan.max[axis] = Math.max(plan.max[axis], element.max[a]);
        }
        const inside = element => [[0, 0], [2, 1]].every(([a, axis]) =>
            element.min[a] >= plan.min[axis] - DETAIL_MARGIN_M && element.max[a] <= plan.max[axis] + DETAIL_MARGIN_M);
        let triangles = shell.reduce((sum, element) => sum + element.triangles, 0);
        let bytes = shell.reduce((sum, element) => sum + bytesOf(element), 0);
        if (triangles > maxTriangles || bytes > maxBytes)
            fail('complex', 'The building envelope alone is over the model limits.', { triangles, bytes, maxTriangles, maxBytes });
        const kinds = new Map(), inShell = new Set(shell);
        for (const element of elements) {
            if (inShell.has(element) || !inside(element)) continue;
            const kind = kinds.get(element.category) || { category: element.category, elements: [], triangles: 0, bytes: 0 };
            kind.elements.push(element);
            kind.triangles += element.triangles;
            kind.bytes += bytesOf(element);
            kinds.set(element.category, kind);
        }
        const selected = [...shell], leftOut = [];
        for (const kind of [...kinds.values()].sort((a, b) => a.triangles - b.triangles)) {
            if (triangles + kind.triangles <= maxTriangles && bytes + kind.bytes <= maxBytes) {
                selected.push(...kind.elements);
                triangles += kind.triangles;
                bytes += kind.bytes;
            } else leftOut.push({ category: kind.category, triangles: kind.triangles });
        }
        return { selected, leftOut, triangles };
    }

    // Second pass: the selected elements as one primitive per colour, centred on their plan box with
    // their lowest point at y = 0 (Float64 placement first, so large map coordinates keep their precision).
    function buildPrimitives(api, model, selected) {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        const groups = new Map();
        for (const element of selected) {
            for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], element.min[a]); max[a] = Math.max(max[a], element.max[a]); }
            for (const [key, counts] of element.colours) {
                const group = groups.get(key) || { colour: counts.colour, vertices: 0, indices: 0 };
                group.vertices += counts.vertices;
                group.indices += counts.indices;
                groups.set(key, group);
            }
        }
        for (const group of groups.values()) {
            group.positions = new Float32Array(group.vertices * 3);
            group.normals = new Float32Array(group.vertices * 3);
            group.indexArray = new Uint32Array(group.indices);
            group.vertex = 0;
            group.index = 0;
        }
        const offset = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
        streamGeometry(api, model, selected.map(element => element.id), (id, { vertices, indices, matrix: m, colour }) => {
            const group = groups.get(colourKey(colour));
            const base = group.vertex;
            for (let k = 0; k < vertices.length; k += 6) {
                const x = vertices[k], y = vertices[k + 1], z = vertices[k + 2];
                const nx = vertices[k + 3], ny = vertices[k + 4], nz = vertices[k + 5];
                const at = group.vertex * 3;
                group.positions[at] = m[0] * x + m[4] * y + m[8] * z + m[12] - offset[0];
                group.positions[at + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] - offset[1];
                group.positions[at + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] - offset[2];
                const n = [m[0] * nx + m[4] * ny + m[8] * nz, m[1] * nx + m[5] * ny + m[9] * nz, m[2] * nx + m[6] * ny + m[10] * nz];
                const length = Math.hypot(n[0], n[1], n[2]) || 1;
                group.normals[at] = n[0] / length; group.normals[at + 1] = n[1] / length; group.normals[at + 2] = n[2] / length;
                group.vertex++;
            }
            for (let k = 0; k < indices.length; k++) group.indexArray[group.index++] = base + indices[k];
        });
        const primitives = [...groups.values()].map((group, i) => ({ name: `ifc-${i + 1}`, color: group.colour,
            positions: group.positions, normals: group.normals, indices: group.indexArray }));
        return { primitives, min, max, centre: [offset[0], -offset[2]] };
    }

    const apis = new WeakMap();
    function apiFor(webIfc) {
        if (!apis.has(webIfc)) {
            const api = new webIfc.IfcAPI();
            // The browser module would look for its .wasm beside the page: it is beside the module.
            if (webIfc.WASM_PATH) api.SetWasmPath(webIfc.WASM_PATH, true);
            apis.set(webIfc, api.Init().then(() => api, error => { apis.delete(webIfc); throw error; }));
        }
        return apis.get(webIfc);
    }

    // The browser's web-ifc module, loaded on the first IFC import.
    let browserModule = null;
    function loadBrowserWebIfc() {
        browserModule ||= import(WEB_IFC_URL).then(module => ({ ...module, WASM_PATH: WEB_IFC_BASE }), error => { browserModule = null; throw error; });
        return browserModule;
    }

    // bytes (Uint8Array of an IFC file) → { glb, heightM, triangles, leftOut: [{ category, triangles }],
    // placement: { center: { lng, lat }, rotationDeg, source: 'map-conversion' | 'site-reference' } | null,
    // unsupportedCrs: the map conversion's CRS name when it cannot be read }. Throws with code
    // 'ifc-unreadable', 'empty' or 'complex'. webIfc: the web-ifc module; proj4: the proj4 function.
    async function ifcBuildingGlb(bytes, { webIfc, proj4, maxTriangles = modelGeometry().MAX_FOOTPRINT_TRIANGLES, maxBytes = MAX_GLB_BYTES }) {
        // web-ifc takes seconds and then crashes on bytes that are not a STEP file: refuse them first.
        if (!looksLikeIfc(new TextDecoder('latin1').decode(bytes.subarray(0, 8000)))) fail('ifc-unreadable', 'The file is not an IFC file.');
        const api = await apiFor(webIfc);
        let model;
        try { model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false }); }
        catch (error) {
            // A crashed WebAssembly instance is not reused.
            apis.delete(webIfc);
            model = -1;
        }
        if (!(model >= 0)) fail('ifc-unreadable', 'The file could not be read as IFC.');
        try {
            const ids = new Set();
            for (const type of [webIfc.IFCBUILDINGELEMENT, webIfc.IFCBUILTELEMENT]) {
                for (const id of api.GetLineIDsWithType(model, type, true)) ids.add(id);
            }
            const elements = ids.size ? surveyElements(api, model, [...ids]) : [];
            if (!elements.length) fail('empty', 'The IFC file holds no building element with geometry.');
            const { selected, leftOut, triangles } = selectElements(elements, { maxTriangles, maxBytes });
            const { primitives, min, max, centre } = buildPrimitives(api, model, selected);
            const glb = cityModels().glbFromPrimitives(primitives, 'Urban Game Theory ifc-model-reader');

            const unit = projectLengthUnit(api, webIfc, model);
            let placement = null, unsupportedCrs = null;
            const conversion = readMapConversion(api, webIfc, model);
            if (conversion) {
                try {
                    const crs = cityModels().crsOf(conversion.crsName);
                    const transform = proj4(crs.definition, 'EPSG:4326');
                    placement = mapConversionPlacement(conversion, centre, { unitMetres: unit, toLngLat: (e, n) => transform.forward([e, n]) });
                } catch (error) {
                    if (error?.code !== 'unsupported-crs') throw error;
                    unsupportedCrs = conversion.crsName || 'unnamed';
                }
            }
            if (!placement) {
                const site = readSiteReference(api, webIfc, model, unit);
                if (site) placement = siteReferencePlacement(site, centre, { proj4 });
            }
            return { glb, heightM: Math.round((max[1] - min[1]) * 100) / 100, triangles, leftOut, placement, unsupportedCrs };
        } finally {
            api.CloseModel(model);
        }
    }

    const api = { WEB_IFC_VERSION, WEB_IFC_URL, MAX_GLB_BYTES, looksLikeIfc, compoundAngle, unitMetres, mapConversionPlacement,
        siteReferencePlacement, selectElements, ifcBuildingGlb, loadBrowserWebIfc };
    if (global) global.IfcModelReader = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
