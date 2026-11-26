// Building heights measured on demand from a height survey (data/height-surveys.json): a public
// surface map (roofs, trees) and terrain map (bare ground) in one metric grid. For the buildings
// asked about, it cuts one window of both maps around them, subtracts terrain from surface over the
// cells inside each footprint and keeps the numbers in memory; nothing is stored. The estimator is
// cadastre-data's raster tier (buildings/lidar/lib/heights.py estimate_from_rasters), whose
// percentiles were measured against Zagreb's surveyed 3D buildings. A building without enough clean
// cells gets no height and a reason, never a number. Pure apart from `fetch`, so the browser and the
// MCP server share it; `proj4` is passed in.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HeightSurvey = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const finite = value => typeof value === 'number' && Number.isFinite(value);

    // The raster tier's settings (heights.py): ridge and eave percentiles, the inset that keeps
    // facade and neighbouring-roof cells out, and what a roof can plausibly be.
    const RIDGE_PERCENTILE = 90;
    const EAVE_PERCENTILE = 25;
    const INSET_M = 1.0;
    const MIN_CELLS = 9;
    const MIN_ROOF_HEIGHT_M = 1.5;
    const MAX_ROOF_HEIGHT_M = 80;
    // One window per group of buildings at most this wide: a street is one or two requests.
    const MAX_WINDOW_M = 600;
    const PAD_M = 3;

    // --- GeoTIFF ---------------------------------------------------------------------------
    // The subset a WCS answers with: one band of uncompressed 32- or 64-bit floats in strips or
    // tiles, georeferenced by ModelPixelScale + ModelTiepoint or by a north-up ModelTransformation,
    // with GDAL's no-data tag. Anything else throws,
    // naming what it found, rather than decoding garbage.
    const TAG = { width: 256, height: 257, bits: 258, compression: 259, stripOffsets: 273, samples: 277,
        rowsPerStrip: 278, stripBytes: 279, tileWidth: 322, tileLength: 323, tileOffsets: 324, tileBytes: 325,
        sampleFormat: 339, pixelScale: 33550, tiepoint: 33922, transformation: 34264, noData: 42113 };
    const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };
    function readGeoTiff(buffer) {
        const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
        const order = view.getUint16(0);
        if (order !== 0x4949 && order !== 0x4d4d) throw new Error('Not a TIFF (no byte-order mark).');
        const little = order === 0x4949;
        if (view.getUint16(2, little) !== 42) throw new Error('Not a classic TIFF (BigTIFF is not read).');
        const ifd = view.getUint32(4, little), count = view.getUint16(ifd, little), tags = {};
        const valueOf = (type, at) => type === 3 ? view.getUint16(at, little) : type === 4 || type === 16 ? view.getUint32(at, little)
            : type === 11 ? view.getFloat32(at, little) : type === 12 ? view.getFloat64(at, little) : view.getUint8(at);
        for (let i = 0; i < count; i++) {
            const at = ifd + 2 + i * 12, tag = view.getUint16(at, little), type = view.getUint16(at + 2, little), n = view.getUint32(at + 4, little);
            const size = (TYPE_SIZE[type] || 1) * n, start = size <= 4 ? at + 8 : view.getUint32(at + 8, little);
            if (type === 2) { let text = ''; for (let k = 0; k < n; k++) { const c = view.getUint8(start + k); if (c) text += String.fromCharCode(c); } tags[tag] = text; continue; }
            const values = []; for (let k = 0; k < n; k++) values.push(valueOf(type, start + k * (TYPE_SIZE[type] || 1)));
            tags[tag] = values;
        }
        const first = tag => tags[tag]?.[0];
        const width = first(TAG.width), height = first(TAG.height), bits = first(TAG.bits);
        if ((first(TAG.compression) ?? 1) !== 1) throw new Error(`Compressed TIFF (compression ${first(TAG.compression)}) is not read.`);
        if ((first(TAG.samples) ?? 1) !== 1) throw new Error('Only one-band TIFFs are read.');
        if (first(TAG.sampleFormat) !== 3 || ![32, 64].includes(bits)) throw new Error(`Only float samples are read (format ${first(TAG.sampleFormat)}, ${bits} bits).`);
        const grid = gridOf(tags);
        const values = new Float64Array(width * height).fill(NaN), bytes = bits / 8;
        const read = at => bits === 32 ? view.getFloat32(at, little) : view.getFloat64(at, little);
        const put = (row, col, at) => { if (row < height && col < width) values[row * width + col] = read(at); };
        if (tags[TAG.tileOffsets]) {
            const tw = first(TAG.tileWidth), th = first(TAG.tileLength), across = Math.ceil(width / tw);
            tags[TAG.tileOffsets].forEach((offset, index) => {
                const row0 = Math.floor(index / across) * th, col0 = (index % across) * tw;
                for (let r = 0; r < th; r++) for (let c = 0; c < tw; c++) put(row0 + r, col0 + c, offset + (r * tw + c) * bytes);
            });
        } else {
            const rowsPerStrip = first(TAG.rowsPerStrip) ?? height;
            tags[TAG.stripOffsets].forEach((offset, index) => {
                for (let r = 0; r < rowsPerStrip; r++) for (let c = 0; c < width; c++) put(index * rowsPerStrip + r, c, offset + (r * width + c) * bytes);
            });
        }
        const noData = tags[TAG.noData] != null ? Number(String(tags[TAG.noData]).trim()) : null;
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (!Number.isFinite(v) || v < -1e30 || (noData !== null && v === noData)) values[i] = NaN;
        }
        return { values, width, height, ...grid };
    }
    // The grid's pixel size and top-left corner. A tiepoint pins raster (i, j) to model (x, y); a
    // transformation is the 4×4 matrix x = a·i + b·j + d, y = e·i + f·j + h.
    function gridOf(tags) {
        const scale = tags[TAG.pixelScale], tie = tags[TAG.tiepoint], matrix = tags[TAG.transformation];
        let pixel, minx, maxy;
        if (scale && tie) {
            if (Math.abs(scale[1] - scale[0]) > 1e-9) throw new Error('Only square pixels are read.');
            pixel = scale[0]; minx = tie[3] - tie[0] * pixel; maxy = tie[4] + tie[1] * pixel;
        } else if (matrix?.length === 16) {
            const [a, b, , d, e, f, , h] = matrix;
            if (b !== 0 || e !== 0 || Math.abs(f + a) > 1e-9) throw new Error('Only north-up square-pixel grids are read.');
            pixel = a; minx = d; maxy = h;
        } else throw new Error('The TIFF has no georeference (ModelPixelScale/ModelTiepoint or ModelTransformation).');
        return { pixel, minx, maxy };
    }
    // Nearest-cell value; outside the window it is NaN, never a plausible elevation.
    function sample(raster, x, y) {
        const col = Math.floor((x - raster.minx) / raster.pixel), row = Math.floor((raster.maxy - y) / raster.pixel);
        if (col < 0 || row < 0 || col >= raster.width || row >= raster.height) return NaN;
        return raster.values[row * raster.width + col];
    }

    // --- Estimator -------------------------------------------------------------------------
    // numpy's default (linear) percentile.
    function percentile(values, q) {
        if (!values.length) return null;
        const sorted = Float64Array.from(values).sort(), at = (sorted.length - 1) * q / 100, low = Math.floor(at);
        const value = sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
        return Number.isFinite(value) ? value : null;
    }
    function confidenceOf(coverage, cells) {
        if (coverage >= 0.6 && cells >= 30) return 'high';
        if (coverage >= 0.3) return 'medium';
        return 'low';
    }
    // Rings of a metric Polygon or MultiPolygon as [[outer, ...holes], ...].
    const polygonsOf = geometry => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    function ringContains(ring, x, y) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }
    const contains = (polygons, x, y) => polygons.some(([outer, ...holes]) => ringContains(outer, x, y) && !holes.some(hole => ringContains(hole, x, y)));
    function edgeDistance(polygons, x, y) {
        let best = Infinity;
        for (const rings of polygons) for (const ring of rings) for (let i = 1; i < ring.length; i++) {
            const [ax, ay] = ring[i - 1], [bx, by] = ring[i], dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
            const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
            best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
        }
        return best;
    }
    function areaOf(polygons) {
        let total = 0;
        for (const rings of polygons) rings.forEach((ring, index) => {
            let sum = 0;
            for (let i = 1; i < ring.length; i++) sum += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
            total += (index === 0 ? 1 : -1) * Math.abs(sum) / 2;
        });
        return Math.max(0, total);
    }
    // Surface minus terrain over the cells whose centres lie inside the footprint and at least
    // INSET_M from its edge (heights.py `inset` + `estimate_from_rasters`). A footprint the inset
    // leaves no cell of is measured over its whole outline, as heights.py keeps a footprint the
    // inset would erase. `geometry` is in the survey's metric CRS.
    function estimate(geometry, surface, terrain) {
        const polygons = polygonsOf(geometry);
        if (!polygons.length) return { rejection: 'no-footprint' };
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (const [outer] of polygons) for (const [x, y] of outer) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
        const p = surface.pixel, inside = [], inset = [];
        const col0 = Math.floor((minx - surface.minx) / p), col1 = Math.floor((maxx - surface.minx) / p);
        const row0 = Math.floor((surface.maxy - maxy) / p), row1 = Math.floor((surface.maxy - miny) / p);
        for (let row = row0; row <= row1; row++) for (let col = col0; col <= col1; col++) {
            const x = surface.minx + (col + 0.5) * p, y = surface.maxy - (row + 0.5) * p;
            if (!contains(polygons, x, y)) continue;
            inside.push([x, y]);
            if (edgeDistance(polygons, x, y) >= INSET_M) inset.push([x, y]);
        }
        const cells = inset.length ? inset : inside;
        if (!cells.length) return { rejection: 'smaller-than-a-cell' };
        const heights = [], grounds = [];
        for (const [x, y] of cells) {
            const top = sample(surface, x, y), ground = sample(terrain, x, y);
            if (Number.isFinite(top) && Number.isFinite(ground)) { heights.push(top - ground); grounds.push(ground); }
        }
        if (!heights.length) return { cells: 0, rejection: 'no-survey-data' };
        if (heights.length < MIN_CELLS) return { cells: heights.length, rejection: 'too-few-cells' };
        const ridge = percentile(heights, RIDGE_PERCENTILE);
        let eave = percentile(heights, EAVE_PERCENTILE);
        const groundZ = percentile(grounds, 50);
        const measuredArea = inset.length ? Math.max(areaOf(polygons) - edgeLength(polygons) * INSET_M, p * p) : areaOf(polygons);
        const coverage = Math.min(heights.length / Math.max(measuredArea / (p * p), 1), 1);
        const base = { cells: heights.length, coverage, groundZ };
        // A surface barely above the terrain is not a building: the footprint is stale or misaligned.
        if (ridge === null || ridge < MIN_ROOF_HEIGHT_M) return { ...base, rejection: 'no-building-seen' };
        if (ridge > MAX_ROOF_HEIGHT_M) return { ...base, rejection: 'implausibly-tall' };
        // An eave at ground level is the inset catching ground, not an eave.
        if (eave !== null && eave < MIN_ROOF_HEIGHT_M) eave = null;
        const confidence = confidenceOf(coverage, heights.length);
        if (confidence === 'low') return { ...base, rejection: 'low-confidence' };
        return { ...base, heightM: ridge, eaveM: eave, confidence };
    }
    // The inset band's area, approximately perimeter × inset (the coverage ratio's denominator).
    function edgeLength(polygons) {
        let total = 0;
        for (const rings of polygons) for (const ring of rings) for (let i = 1; i < ring.length; i++) total += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
        return total;
    }

    // --- Requests --------------------------------------------------------------------------
    const surveyAt = (surveys, [lng, lat]) => (surveys || []).find(survey => {
        const [w, s, e, n] = survey.coverage?.bbox || [];
        return lng >= w && lng <= e && lat >= s && lat <= n;
    }) || null;
    function coverageUrl(layer, [minx, miny, maxx, maxy]) {
        const url = new URL(layer.endpoint);
        for (const [key, value] of [['service', 'WCS'], ['version', '2.0.1'], ['request', 'GetCoverage'], ['CoverageId', layer.coverageId],
            ['subset', `E(${minx},${maxx})`], ['subset', `N(${miny},${maxy})`], ['format', 'image/tiff']]) url.searchParams.append(key, value);
        return url.href;
    }
    const timeoutError = ms => Object.assign(new Error(`No answer within ${ms / 1000} s`), { code: 'hang' });
    // A survey service answers in about a second, but now and then a request hangs for a minute.
    // Each attempt is given `attemptMs`; a hang, a network error or a 5xx is retried at once, up to
    // `attempts` times. A 4xx is the request's fault and is not retried. A hang is asked again at once;
    // a request that fails outright (a network error, a 5xx) is asked again after a pause that doubles
    // from `backoffMs`, since an immediate repeat fails the same way.
    const pause = (ms, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason || new Error('Aborted'));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('Aborted')); }, { once: true });
    });
    async function fetchPatiently(url, { fetchImpl = fetch, attemptMs = 6000, attempts = 6, backoffMs = 500, signal, as = 'arrayBuffer', log = () => {} } = {}) {
        let last;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            if (signal?.aborted) throw signal.reason || new Error('Aborted');
            const controller = new AbortController(), stop = () => controller.abort(signal.reason);
            signal?.addEventListener('abort', stop, { once: true });
            const timer = setTimeout(() => controller.abort(timeoutError(attemptMs)), attemptMs);
            try {
                const response = await fetchImpl(url, { signal: controller.signal });
                if (response.status >= 400 && response.status < 500) throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'refused' });
                if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'failed' });
                return await response[as]();
            } catch (error) {
                if (error?.code === 'refused' || signal?.aborted) throw error;
                last = controller.signal.aborted && controller.signal.reason?.code === 'hang' ? controller.signal.reason : error;
                log(`attempt ${attempt}/${attempts} failed (${last.message}); ${attempt < attempts ? 'retrying' : 'giving up'}`);
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', stop);
            }
            if (attempt < attempts && last?.code !== 'hang' && backoffMs > 0) await pause(backoffMs * 2 ** (attempt - 1), signal);
        }
        throw Object.assign(new Error(`The height survey did not answer after ${attempts} attempts: ${last?.message}`), { code: 'unavailable' });
    }

    // Buildings grouped so no window is wider than MAX_WINDOW_M: by the grid cell of their first vertex,
    // the grid anchored at the group's own south-west corner (so a group that fits is one window).
    function windowsFor(entries) {
        const size = MAX_WINDOW_M, firsts = entries.map(entry => polygonsOf(entry.metric)[0][0][0]);
        const x0 = Math.min(...firsts.map(([x]) => x)), y0 = Math.min(...firsts.map(([, y]) => y));
        const groups = new Map();
        for (const [index, entry] of entries.entries()) {
            const [x, y] = firsts[index];
            const key = `${Math.floor((x - x0) / size)}:${Math.floor((y - y0) / size)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(entry);
        }
        return [...groups.values()].map(members => {
            let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
            for (const entry of members) for (const [outer] of polygonsOf(entry.metric)) for (const [x, y] of outer) {
                minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
            }
            return { members, box: [Math.floor(minx - PAD_M), Math.floor(miny - PAD_M), Math.ceil(maxx + PAD_M), Math.ceil(maxy + PAD_M)] };
        });
    }
    // Few windows that still fill a view from its centre outwards: a `coreM` square around `centre`
    // (metric [x, y]) first, then the rest as four strips (north, south, east, west of the core), each
    // cut by windowsFor where it is wider than MAX_WINDOW_M. A survey service limits how often it may
    // be asked, so a view costs about five windows, not a grid of small ones.
    function windowsAround(entries, centre, coreM) {
        const half = coreM / 2, groups = { core: [], north: [], south: [], east: [], west: [] };
        for (const entry of entries) {
            const [x, y] = polygonsOf(entry.metric)[0][0][0], dx = x - centre[0], dy = y - centre[1];
            const side = Math.abs(dx) <= half && Math.abs(dy) <= half ? 'core' : dy > half ? 'north' : dy < -half ? 'south' : dx > 0 ? 'east' : 'west';
            groups[side].push(entry);
        }
        return Object.values(groups).filter(group => group.length).flatMap(group => windowsFor(group));
    }
    const mapCoords = (geometry, fn) => ({ type: geometry.type, coordinates: geometry.type === 'Polygon'
        ? geometry.coordinates.map(ring => ring.map(fn)) : geometry.coordinates.map(poly => poly.map(ring => ring.map(fn))) });
    function firstPoint(geometry) { return polygonsOf(geometry)[0]?.[0]?.[0] || null; }
    // When the patch holding a building was flown: the survey's date index, read for the window's
    // WGS84 box, matched by the building's first vertex. Unknown dates stay null.
    async function datesFor(survey, members, { log, signal, ...patience }) {
        if (!survey.dates?.endpoint) return null;
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const entry of members) for (const [outer] of polygonsOf(entry.geometry)) for (const [lng, lat] of outer) {
            w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat);
        }
        const url = new URL(survey.dates.endpoint);
        url.searchParams.set('f', 'json'); url.searchParams.set('bbox', [w, s, e, n].join(',')); url.searchParams.set('limit', '50');
        try {
            const answer = await fetchPatiently(url.href, { ...patience, signal, as: 'json', log });
            return (answer.features || []).filter(feature => ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type));
        } catch (error) {
            if (signal?.aborted) throw error;
            log(`survey dates unavailable: ${error.message}`);
            return null;
        }
    }
    const dayOf = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

    // A measurer over the configured surveys with an in-memory cache, one entry per survey and
    // building id. `measure(buildings)` takes [{ id, geometry }] (GeoJSON in WGS84) and resolves to
    // a Map id → result: { heightM, eaveM, confidence, survey, surveyedFrom, surveyedTo } when
    // measured, or { rejection } when not (`outside-surveys` where no survey covers the building,
    // `survey-unavailable` when its service never answered).
    function createMeasurer({ surveys, proj4, fetchImpl = (...args) => fetch(...args), log = () => {}, attemptMs, attempts, backoffMs }) {
        const patience = { fetchImpl, log, ...(attemptMs ? { attemptMs } : {}), ...(attempts ? { attempts } : {}), ...(backoffMs !== undefined ? { backoffMs } : {}) };
        if (!proj4) throw new TypeError('A height measurer needs proj4.');
        const cache = new Map(), projections = new Map();
        const projectorOf = survey => {
            if (!projections.has(survey.id)) projections.set(survey.id, proj4('EPSG:4326', survey.proj4));
            return projections.get(survey.id);
        };
        async function measureWindow(survey, window, datesRead, signal) {
            // One map failing for good makes the other useless: it stops asking too.
            const pair = new AbortController(), stop = () => pair.abort(signal.reason);
            signal?.addEventListener('abort', stop, { once: true });
            const read = layer => fetchPatiently(coverageUrl(layer, window.box), { ...patience, signal: pair.signal })
                .catch(error => { pair.abort(error); throw error; });
            const [surfaceBuffer, terrainBuffer, dates] = await Promise.all([read(survey.surface), read(survey.terrain), datesRead])
                .finally(() => signal?.removeEventListener('abort', stop));
            const surface = readGeoTiff(surfaceBuffer), terrain = readGeoTiff(terrainBuffer);
            const results = new Map();
            for (const entry of window.members) {
                const result = estimate(entry.metric, surface, terrain);
                const point = firstPoint(entry.geometry);
                const patch = point && dates?.find(feature => contains(polygonsOf(feature.geometry), point[0], point[1]));
                results.set(entry.id, { ...result, survey: { id: survey.id, name: survey.name },
                    surveyedFrom: dayOf(patch?.properties?.[survey.dates.from]), surveyedTo: dayOf(patch?.properties?.[survey.dates.to]) });
            }
            return results;
        }
        // Options for a view that fills in as answers arrive: `around` ([lng, lat]) reads the windows
        // nearest it first, and with `coreM` cuts them as a core and four strips (windowsAround); at
        // most `concurrency` windows are read at once, and `onWindow(results)` gets each window's Map
        // as it lands (first the buildings already known, in one call). The flight dates are read once
        // per survey for the whole call.
        async function measure(buildings, { signal, around = null, coreM = null, concurrency = 2, onWindow = null } = {}) {
            const out = new Map(), pending = new Map(), known = [];
            for (const building of buildings || []) {
                const id = String(building.id), point = building.geometry && firstPoint(building.geometry);
                const survey = point && surveyAt(surveys, point);
                if (!survey) { out.set(id, { rejection: 'outside-surveys' }); known.push(id); continue; }
                const key = `${survey.id}:${id}`;
                if (cache.has(key)) { out.set(id, cache.get(key)); known.push(id); continue; }
                const projector = projectorOf(survey);
                if (!pending.has(survey.id)) pending.set(survey.id, { survey, entries: [] });
                pending.get(survey.id).entries.push({ id, key, geometry: building.geometry, metric: mapCoords(building.geometry, c => projector.forward([c[0], c[1]])) });
            }
            const windows = [];
            for (const { survey, entries } of pending.values()) {
                const datesRead = datesFor(survey, entries, { ...patience, signal });
                const centre = around ? projectorOf(survey).forward(around) : null;
                for (const window of centre && coreM ? windowsAround(entries, centre, coreM) : windowsFor(entries)) {
                    const [minx, miny, maxx, maxy] = window.box;
                    windows.push({ survey, window, datesRead, distance: centre ? Math.hypot((minx + maxx) / 2 - centre[0], (miny + maxy) / 2 - centre[1]) : 0 });
                }
            }
            windows.sort((a, b) => a.distance - b.distance);
            const reported = onWindow ? Promise.all(known.map(id => out.get(id))).then(values => onWindow(new Map(known.map((id, index) => [id, values[index]])))) : null;
            // A window waits for a free slot (`concurrency` reading at once), nearest first.
            let running = 0;
            const waiting = [];
            const slot = () => running < concurrency ? (running++, Promise.resolve()) : new Promise(resolve => waiting.push(resolve));
            const release = () => { const next = waiting.shift(); if (next) next(); else running--; };
            const landed = [];
            for (const { survey, window, datesRead } of windows) {
                const read = slot().then(() => measureWindow(survey, window, datesRead, signal)).finally(release);
                for (const entry of window.members) {
                    const one = read.then(results => results.get(entry.id), error => {
                        cache.delete(entry.key);
                        if (signal?.aborted) throw error;
                        log(`height survey ${survey.id} unavailable: ${error.message}`);
                        return { rejection: 'survey-unavailable', survey: { id: survey.id, name: survey.name } };
                    });
                    cache.set(entry.key, one);
                    out.set(entry.id, one);
                }
                if (onWindow) landed.push(Promise.all(window.members.map(entry => out.get(entry.id)))
                    .then(values => reported.then(() => onWindow(new Map(window.members.map((entry, index) => [entry.id, values[index]]))))));
            }
            await Promise.all(landed);
            const settled = new Map();
            for (const [id, value] of out) settled.set(id, await value);
            return settled;
        }
        return { measure };
    }

    // A building record with a survey's measured height in place of whatever height its own source gave
    // (a tagged height, storeys × 3 m or an estimate): `height_m` (which the footprint pool and rule
    // terms read as measured) and `height_survey`, the evidence. A stated storey count stays as it is.
    function withMeasuredHeight(record, result) {
        if (!finite(result?.heightM)) return record;
        const evidence = { id: result.survey?.id || null, name: result.survey?.name || null, eaveM: finite(result.eaveM) ? result.eaveM : null,
            confidence: result.confidence, surveyedFrom: result.surveyedFrom || null, surveyedTo: result.surveyedTo || null };
        if (record?.type === 'Feature') return { ...record, properties: { ...record.properties, height_m: result.heightM, height_source: 'measured', height_survey: evidence } };
        return { ...record, height_m: result.heightM, height_source: 'measured', height_survey: evidence };
    }

    // `records` with a survey's height on each one a survey measures, in the same order: the best
    // measure available. A record the survey gives no height for (outside it, no building seen, not
    // answering) keeps its own. `idOf(record)` names a record; one measure() call covers all.
    const surveyed = record => Boolean((record?.properties || record)?.height_survey);
    async function withSurveyedHeights(measurer, records, { idOf, signal } = {}) {
        const lacking = (records || []).filter(record => record?.geometry && !surveyed(record));
        if (!lacking.length) return records;
        const ids = new Map(lacking.map((record, index) => [record, String(idOf?.(record) ?? record.id ?? record.properties?.id ?? `record-${index}`)]));
        const results = await measurer.measure(lacking.map(record => ({ id: ids.get(record), geometry: record.geometry })), { signal });
        return records.map(record => ids.has(record) ? withMeasuredHeight(record, results.get(ids.get(record))) : record);
    }

    return { readGeoTiff, sample, percentile, estimate, coverageUrl, fetchPatiently, windowsFor, windowsAround, surveyAt, createMeasurer, withMeasuredHeight, withSurveyedHeights,
        settings: Object.freeze({ RIDGE_PERCENTILE, EAVE_PERCENTILE, INSET_M, MIN_CELLS, MIN_ROOF_HEIGHT_M, MAX_ROOF_HEIGHT_M, MAX_WINDOW_M }) };
});
