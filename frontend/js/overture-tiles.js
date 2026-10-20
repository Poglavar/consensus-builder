// Buildings read in the browser straight from Overture Maps' public PMTiles (a single file on their
// CDN that answers byte-range requests with CORS open), so a city needs no import and our server is
// not in the path. The latest release is looked up in Overture's STAC catalogue, since every release
// gets a new file and old ones are deleted after a few months. Only the most detailed zoom (z14) is
// read: lower zooms drop small buildings.
//
// The decoding half is pure (Mapbox Vector Tile protobuf → GeoJSON footprints in lng/lat) and runs in
// node tests; the fetching half needs the vendored `pmtiles` reader (vendor/pmtiles-4.4.1).
(function () {
    const STAC_CATALOG_URL = 'https://stac.overturemaps.org/catalog.json';
    // Widest box one query may read. At the equator a z14 tile is ~0.022°, so this is at most 3×3 tiles;
    // a dense tile (central Bogotá) holds ~20 000 buildings and ~8 MB of decoded tile.
    const MAX_SPAN_DEG = 0.03;
    // Tiles one query reads at most. Away from the equator a tile covers fewer degrees of latitude, so
    // a box at the span limit can touch more; the tiles nearest its centre are read and the answer
    // says it is truncated.
    const MAX_TILES = 9;
    const TILE_CACHE_SIZE = 12;

    // --- Minimal protobuf reader for the vector-tile schema (no dependency) ---

    function reader(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let pos = 0;
        const varint = () => {
            let result = 0, shift = 1, byte;
            do {
                byte = bytes[pos++];
                result += (byte & 0x7f) * shift;
                shift *= 128;
            } while (byte & 0x80);
            return result;
        };
        const skip = wire => {
            if (wire === 0) varint();
            else if (wire === 1) pos += 8;
            else if (wire === 2) pos += varint();
            else if (wire === 5) pos += 4;
            else throw new Error(`Unsupported protobuf wire type ${wire}`);
        };
        return {
            get pos() { return pos; },
            end: () => pos >= bytes.length,
            varint,
            skip,
            tag: () => { const t = varint(); return [t >>> 3, t & 7]; },
            bytes: () => { const len = varint(); const out = bytes.subarray(pos, pos + len); pos += len; return out; },
            string: () => { const len = varint(); const out = new TextDecoder().decode(bytes.subarray(pos, pos + len)); pos += len; return out; },
            float: () => { const v = view.getFloat32(pos, true); pos += 4; return v; },
            double: () => { const v = view.getFloat64(pos, true); pos += 8; return v; },
            packed: () => { const len = varint(); const stop = pos + len; const out = []; while (pos < stop) out.push(varint()); return out; }
        };
    }

    const zigzag = n => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

    function decodeValue(bytes) {
        const r = reader(bytes);
        let value = null;
        while (!r.end()) {
            const [field, wire] = r.tag();
            if (field === 1) value = r.string();
            else if (field === 2) value = r.float();
            else if (field === 3) value = r.double();
            else if (field === 4 || field === 5) value = r.varint();
            else if (field === 6) value = zigzag(r.varint());
            else if (field === 7) value = r.varint() !== 0;
            else r.skip(wire);
        }
        return value;
    }

    function decodeFeature(bytes) {
        const r = reader(bytes);
        const feature = { tags: [], type: 0, geometry: [] };
        while (!r.end()) {
            const [field, wire] = r.tag();
            if (field === 2) feature.tags = r.packed();
            else if (field === 3) feature.type = r.varint();
            else if (field === 4) feature.geometry = r.packed();
            else r.skip(wire);
        }
        return feature;
    }

    function decodeLayer(bytes) {
        const r = reader(bytes);
        const layer = { name: '', extent: 4096, keys: [], values: [], features: [] };
        while (!r.end()) {
            const [field, wire] = r.tag();
            if (field === 1) layer.name = r.string();
            else if (field === 2) layer.features.push(r.bytes());
            else if (field === 3) layer.keys.push(r.string());
            else if (field === 4) layer.values.push(decodeValue(r.bytes()));
            else if (field === 5) layer.extent = r.varint();
            else r.skip(wire);
        }
        layer.features = layer.features.map(decodeFeature);
        return layer;
    }

    // Raw tile bytes → { [layerName]: { extent, features: [{ properties, type, geometry }] } }.
    function decodeTile(bytes) {
        const r = reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        const layers = {};
        while (!r.end()) {
            const [field, wire] = r.tag();
            if (field !== 3) { r.skip(wire); continue; }
            const layer = decodeLayer(r.bytes());
            layers[layer.name] = {
                extent: layer.extent,
                features: layer.features.map(f => {
                    const properties = {};
                    for (let i = 0; i + 1 < f.tags.length; i += 2) properties[layer.keys[f.tags[i]]] = layer.values[f.tags[i + 1]];
                    return { properties, type: f.type, geometry: f.geometry };
                })
            };
        }
        return layers;
    }

    // Command-encoded polygon geometry → rings in tile coordinates, each closed.
    function decodeRings(commands) {
        const rings = [];
        let x = 0, y = 0, ring = null, i = 0;
        while (i < commands.length) {
            const command = commands[i] & 0x7, count = commands[i] >>> 3;
            i++;
            if (command === 7) {
                if (ring && ring.length) { ring.push(ring[0].slice()); rings.push(ring); }
                ring = null;
                continue;
            }
            for (let k = 0; k < count; k++) {
                x += zigzag(commands[i++]);
                y += zigzag(commands[i++]);
                if (command === 1) { if (ring && ring.length) rings.push(ring); ring = [[x, y]]; }
                else if (ring) ring.push([x, y]);
            }
        }
        return rings;
    }

    // Surveyor's formula in tile coordinates (y down): exterior rings are positive (MVT spec 4.3.4.4).
    function ringArea(ring) {
        let sum = 0;
        for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        return sum / 2;
    }

    // Rings in tile coordinates → a lng/lat Polygon or MultiPolygon, or null when nothing has area.
    function ringsToGeometry(rings, z, x, y, extent) {
        const n = 2 ** z;
        const toLngLat = ([px, py]) => {
            const lng = ((x + px / extent) / n) * 360 - 180;
            const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / extent) / n))) * 180 / Math.PI;
            return [lng, lat];
        };
        const polygons = [];
        for (const ring of rings) {
            const area = ringArea(ring);
            if (area === 0 || ring.length < 4) continue;
            if (area > 0) polygons.push([ring.map(toLngLat)]);
            else if (polygons.length) polygons[polygons.length - 1].push(ring.map(toLngLat));
        }
        if (!polygons.length) return null;
        return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons };
    }

    // The building's id: the OpenStreetMap element id when OSM drew its outline, in the form the OSM
    // provider uses ('w123', 'r45'), so a demolition recorded against OSM keeps naming the same
    // building; otherwise Overture's own stable id.
    function buildingId(properties) {
        let sources = properties.sources;
        if (typeof sources === 'string') { try { sources = JSON.parse(sources); } catch (_) { sources = null; } }
        const outline = Array.isArray(sources) ? (sources.find(s => s && !s.property) || sources[0]) : null;
        const osm = outline && outline.dataset === 'OpenStreetMap' && /^([nwr])(\d+)/.exec(String(outline.record_id || ''));
        return osm ? osm[1] + osm[2] : String(properties.id);
    }

    function positive(value) {
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    }

    // One decoded z14 tile → building footprint features in the provider shape
    // ({ id, geometry, properties: { measured_height_m, levels, building, dataset } }). Underground
    // buildings are left out: they would be extruded above ground.
    function buildingFeaturesFromTile(bytes, z, x, y) {
        const layer = decodeTile(bytes).building;
        if (!layer) return [];
        const out = [];
        for (const feature of layer.features) {
            const p = feature.properties;
            if (feature.type !== 3 || p.is_underground === true) continue;
            const geometry = ringsToGeometry(decodeRings(feature.geometry), z, x, y, layer.extent);
            if (!geometry) continue;
            out.push({
                type: 'Feature',
                id: buildingId(p),
                geometry,
                properties: {
                    measured_height_m: positive(p.height),
                    levels: positive(p.num_floors),
                    building: p.class || p.subtype || null,
                    dataset: p['@geometry_source'] || null
                }
            });
        }
        return out;
    }

    function tileRange(bbox, z) {
        const n = 2 ** z;
        const tx = lng => Math.min(n - 1, Math.max(0, Math.floor((lng + 180) / 360 * n)));
        const ty = lat => {
            const r = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
            return Math.min(n - 1, Math.max(0, Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)));
        };
        const tiles = [];
        for (let x = tx(bbox[0]); x <= tx(bbox[2]); x++) {
            for (let y = ty(bbox[3]); y <= ty(bbox[1]); y++) tiles.push([z, x, y]);
        }
        return tiles;
    }

    const boxOf = geometry => {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        for (const polygon of polygons) for (const [lng, lat] of polygon[0]) {
            if (lng < w) w = lng; if (lng > e) e = lng; if (lat < s) s = lat; if (lat > n) n = lat;
        }
        return [w, s, e, n];
    };

    // A building crossing a tile edge comes once per tile, each copy clipped to its tile (plus a small
    // buffer). Copies sharing an id are joined back into one outline; if the union fails the larger
    // copy stands in, so a building is never counted twice.
    function mergeTileCopies(features, turf) {
        const byId = new Map();
        for (const feature of features) {
            const seen = byId.get(feature.id);
            if (!seen) { byId.set(feature.id, feature); continue; }
            let merged = null;
            try { merged = turf.union(seen, feature); } catch (error) {
                // Context buildings for display: the larger copy stands in, as before, and the
                // failure is reported and counted in clipHealth() (parcel-arrangement.js).
                const clips = (typeof window !== 'undefined' && window.__parcelArrangement)
                    || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
                if (!clips || typeof clips.reportClipFailure !== 'function') throw error;
                clips.reportClipFailure('union', error, { site: 'overture-tiles.mergeTileCopies', parcelId: feature.id }, [seen, feature]);
                merged = null;
            }
            if (merged && merged.geometry) byId.set(feature.id, { ...seen, geometry: merged.geometry });
            else if (turf.area(feature) > turf.area(seen)) byId.set(feature.id, feature);
        }
        return [...byId.values()];
    }

    // The newest release's buildings PMTiles URL, from the STAC catalogue's `pmtiles` link.
    async function latestBuildingsUrl(fetchImpl) {
        const json = async url => {
            const response = await fetchImpl(url);
            if (!response.ok) throw Object.assign(new Error(`Overture catalogue ${url} answered ${response.status}`), { status: response.status });
            return response.json();
        };
        const root = await json(STAC_CATALOG_URL);
        const release = root.latest;
        if (!release) throw new Error('Overture catalogue names no latest release');
        const theme = await json(`https://stac.overturemaps.org/${release}/buildings/catalog.json`);
        const link = (theme.links || []).find(l => l.rel === 'pmtiles');
        if (!link || !link.href) throw new Error(`Overture release ${release} lists no buildings PMTiles`);
        return { release, url: link.href };
    }

    // featuresIn(bbox) over the live tiles, with decoded tiles cached and concurrent reads shared.
    // `openArchive(url)` returns an object with getZxy(z, x, y) → { data } | undefined (pmtiles.PMTiles).
    function createOvertureTilesSource({ turf, fetchImpl, openArchive, zoom = 14, log = () => {} }) {
        let archive = null;
        const cache = new Map();
        const archiveFor = () => {
            if (!archive) {
                archive = latestBuildingsUrl(fetchImpl).then(({ release, url }) => {
                    log(`Overture buildings release ${release}: ${url}`);
                    return { release, tiles: openArchive(url) };
                });
                archive.catch(() => { archive = null; });
            }
            return archive;
        };
        const tile = (z, x, y) => {
            const key = `${z}/${x}/${y}`;
            if (cache.has(key)) {
                const hit = cache.get(key);
                cache.delete(key); cache.set(key, hit);
                return hit;
            }
            const started = Date.now();
            const pending = archiveFor().then(({ tiles }) => tiles.getZxy(z, x, y)).then(result => {
                const features = result && result.data ? buildingFeaturesFromTile(new Uint8Array(result.data), z, x, y) : [];
                log(`tile ${key}: ${features.length} buildings in ${Date.now() - started} ms`);
                return features;
            });
            pending.catch(() => cache.delete(key));
            cache.set(key, pending);
            while (cache.size > TILE_CACHE_SIZE) cache.delete(cache.keys().next().value);
            return pending;
        };
        async function featuresIn(bbox) {
            let tiles = tileRange(bbox, zoom);
            const truncated = tiles.length > MAX_TILES;
            if (truncated) {
                const mid = arr => (arr[0] + arr[arr.length - 1]) / 2;
                const cx = mid(tiles.map(t => t[1])), cy = mid(tiles.map(t => t[2]));
                tiles = tiles.slice().sort((a, b) => ((a[1] - cx) ** 2 + (a[2] - cy) ** 2) - ((b[1] - cx) ** 2 + (b[2] - cy) ** 2))
                    .slice(0, MAX_TILES);
                log(`box spans ${tileRange(bbox, zoom).length} tiles; reading the ${MAX_TILES} nearest its centre`);
            }
            const all = (await Promise.all(tiles.map(([z, x, y]) => tile(z, x, y)))).flat();
            const [w, s, e, n] = bbox;
            // Joined before the box test, so a building half outside the box is not cut at a tile edge.
            const inside = mergeTileCopies(all, turf).filter(feature => {
                const [fw, fs, fe, fn] = boxOf(feature.geometry);
                return fe >= w && fw <= e && fn >= s && fs <= n;
            });
            return { type: 'FeatureCollection', features: inside, truncated, partial: false };
        }
        return { featuresIn };
    }

    const api = {
        STAC_CATALOG_URL, MAX_SPAN_DEG, decodeTile, decodeRings, ringsToGeometry, buildingId,
        buildingFeaturesFromTile, tileRange, mergeTileCopies, latestBuildingsUrl, createOvertureTilesSource
    };
    if (typeof window !== 'undefined') window.OvertureTiles = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
