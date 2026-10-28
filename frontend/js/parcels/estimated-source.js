// Browser-local store and provider adapter for imagery-derived parcel estimates.
(function attachEstimatedParcelSource(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.EstimatedParcelSource = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const SCHEMA = 'estimated-parcel-source/1';
    const MAX_FEATURES = 5000;
    const PREFIX = 'cb_estimated_parcels:';

    function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
    function clone(value) {
        if (value === undefined || value === null) return value;
        if (typeof structuredClone === 'function') { try { return structuredClone(value); } catch (_) { /* JSON fallback */ } }
        return JSON.parse(JSON.stringify(value));
    }
    function stableJson(value) {
        if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
        if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
        return JSON.stringify(value);
    }
    function hash(text) {
        const sha = root.Sha256 || (typeof require === 'function' ? require('../bets/sha256.js') : null);
        if (!sha) throw new Error('Estimated parcel identity hashing is unavailable.');
        return sha.hex(text);
    }
    function cityName(city) {
        if (typeof city !== 'string' || !city.trim() || city.trim().length > 120) throw new TypeError('A valid city is required.');
        return city.trim();
    }
    function belongsToCity(parcelId, city) {
        if (typeof city !== 'string' || !city.trim()) return false;
        const identity = /^EST:([a-f0-9]{64}):[a-f0-9]{64}(?:#.+)?$/i.exec(String(parcelId || '').trim());
        return !!identity && identity[1].toLowerCase() === hash(cityName(city));
    }
    function geometryBounds(geometry) {
        let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
        const visit = coordinates => {
            if (!Array.isArray(coordinates)) return;
            if (coordinates.length >= 2 && Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1])) {
                const [lon, lat] = coordinates;
                if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new TypeError('Estimated geometry must use WGS84 coordinates.');
                west = Math.min(west, lon); south = Math.min(south, lat); east = Math.max(east, lon); north = Math.max(north, lat);
                return;
            }
            coordinates.forEach(visit);
        };
        visit(geometry.coordinates);
        if (!Number.isFinite(west)) throw new TypeError('Estimated geometry has no coordinates.');
        return [west, south, east, north];
    }
    function validateGeometry(geometry) {
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) {
            throw new TypeError('Estimated parcels must be Polygon or MultiPolygon geometry.');
        }
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        if (!polygons.length) throw new TypeError('Estimated polygon has no rings.');
        for (const polygon of polygons) {
            if (!Array.isArray(polygon) || !polygon.length) throw new TypeError('Estimated polygon has no rings.');
            for (const ring of polygon) {
                if (!Array.isArray(ring) || ring.length < 4) throw new TypeError('Estimated polygon rings need at least four positions.');
                for (const point of ring) {
                    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) throw new TypeError('Estimated geometry contains an invalid position.');
                }
                const first = ring[0], last = ring[ring.length - 1];
                if (first[0] !== last[0] || first[1] !== last[1]) throw new TypeError('Estimated polygon rings must be closed.');
            }
        }
        return geometryBounds(geometry);
    }
    function normalizeCollection(city, collection) {
        if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features) || collection.features.length > MAX_FEATURES) {
            throw new TypeError(`Estimated collection must contain at most ${MAX_FEATURES} features.`);
        }
        const cityHash = hash(city);
        const ids = new Set();
        const features = collection.features.map(raw => {
            if (!raw || raw.type !== 'Feature' || !raw.geometry) throw new TypeError('Estimated collection contains a non-feature.');
            if (raw.properties?.estimated !== true) throw new TypeError('Estimated parcel features must be marked estimated.');
            const geometry = clone(raw.geometry);
            validateGeometry(geometry);
            const geometryHash = hash(JSON.stringify(geometry));
            const id = `EST:${cityHash}:${geometryHash}`;
            if (ids.has(id)) throw new TypeError('Estimated collection contains duplicate geometry identities.');
            ids.add(id);
            const originalId = raw.properties?.sourceParcelId ?? (raw.id === undefined || raw.id === null ? null : String(raw.id));
            return {
                ...clone(raw), id, geometry,
                properties: { ...(clone(raw.properties) || {}), parcelId: id, id, parcel_id: id,
                    sourceId: `estimated-local:sha256:${cityHash}`, sourceParcelId: originalId,
                    estimated: true, provenance: 'imagery-estimate', accuracy: 'unvalidated',
                    sourceIdentityKind: 'geometry-content', parcelIdentityKind: 'geometry-sha256-v1',
                    geometryDisplayId: `EST-${geometryHash.slice(0, 12)}`, parcelSource: { sourceId: `estimated-local:sha256:${cityHash}`, snapshotId: null } }
            };
        });
        return { collection: { ...clone(collection), type: 'FeatureCollection', features }, ids };
    }
    function validateRecord(value, expectedCity = null) {
        if (!value || value.schema !== SCHEMA || typeof value.active !== 'boolean' || typeof value.city !== 'string' || (expectedCity && value.city !== expectedCity)) {
            throw new TypeError('Stored estimated parcel record is invalid.');
        }
        const normalized = normalizeCollection(value.city, value.collection);
        if (normalized.collection.features.some((feature, index) => feature.id !== value.collection.features[index]?.id)) throw new TypeError('Stored estimated parcel identities are invalid.');
        if (!validBounds(value.bounds)) throw new TypeError('Stored estimated bounds are invalid.');
        return { ...clone(value), collection: normalized.collection };
    }
    function validBounds(bounds) {
        return Array.isArray(bounds) && bounds.length === 4 && bounds.every(value => typeof value === 'number' && Number.isFinite(value))
            && bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] >= -90 && bounds[3] <= 90
            && bounds[0] < bounds[2] && bounds[1] < bounds[3];
    }
    function intersects(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
    function featureBounds(feature) { return geometryBounds(feature.geometry); }
    function bboxFromCell(cell) {
        const raw = cell?.latLonBbox;
        if (Array.isArray(raw) && raw.length === 4 && raw.every(Number.isFinite)) return raw;
        if (typeof raw === 'string') {
            const values = raw.split(',').map(Number);
            if (values.length === 4 && values.every(Number.isFinite)) return values;
        }
        throw new TypeError('Estimated source needs a lat/lng bbox.');
    }
    function createSource(record) {
        const stored = validateRecord(record);
        const all = stored.collection.features;
        const select = bounds => all.filter(feature => intersects(featureBounds(feature), bounds)).map(clone);
        return {
            id: `estimated-local:sha256:${hash(stored.city)}`, kind: 'estimated-local', label: 'Local imagery estimates', record: clone(stored),
            fetchCell(cell) { return { features: select(bboxFromCell(cell)), returnsWGS84: true, sourceSrid: 'EPSG:4326' }; },
            fetchByIds(ids) {
                const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
                const features = all.filter(feature => wanted.has(feature.id)).map(clone);
                const found = new Set(features.map(feature => feature.id));
                return { features, absentIds: [...wanted].filter(id => !found.has(id)), returnsWGS84: true, sourceSrid: 'EPSG:4326' };
            },
            fetchUnderGeometry(geometry) { return { features: select(geometryBounds(geometry)), returnsWGS84: true, sourceSrid: 'EPSG:4326' }; },
            describe() { return { kind: 'estimated-local' }; }
        };
    }
    function createStore(storage) {
        storage = storage || root.BrowserWorkspace?.storage || root.localStorage;
        function key(city) { return PREFIX + encodeURIComponent(cityName(city)); }
        function read(city) {
            const name = cityName(city);
            let raw;
            try { raw = storage.getItem(key(name)); } catch (error) { fail('estimate-storage', `Cannot read estimated parcels: ${error.message}`); }
            if (raw === null || raw === undefined) return null;
            let parsed;
            try { parsed = JSON.parse(raw); return validateRecord(parsed, name); }
            catch (error) { if (error.code) throw error; fail('estimate-corrupt', error.message); }
        }
        function prepare(city, input, { referencedIds = [] } = {}) {
            const name = cityName(city);
            if (!input || !input.collection) throw new TypeError('An estimated collection is required.');
            const normalized = normalizeCollection(name, input.collection);
            const bounds = Array.isArray(input.bounds) ? input.bounds.slice() : null;
            if (!validBounds(bounds)) throw new TypeError('Estimated bounds are invalid.');
            const previous = read(name);
            const referenced = new Set((referencedIds || []).map(String));
            const nextIds = normalized.ids;
            if (previous?.collection.features.some(feature => referenced.has(feature.id) && !nextIds.has(feature.id))) fail('estimate-in-use', 'Referenced estimated parcels cannot be removed.');
            return { schema: SCHEMA, city: name, collection: normalized.collection, imageUrl: input.imageUrl == null ? null : String(input.imageUrl), bounds, active: true };
        }
        function save(city, input, options = {}) {
            const record = prepare(city, input, options);
            const storageKey = key(record.city);
            let previous;
            try { previous = storage.getItem(storageKey); }
            catch (error) { fail('estimate-storage', `Cannot read previous estimated parcels: ${error.message}`); }
            try { storage.setItem(storageKey, JSON.stringify(record)); }
            catch (error) { try { if (previous === null || previous === undefined) storage.removeItem(storageKey); else storage.setItem(storageKey, previous); } catch (_) { /* best effort rollback */ } fail('estimate-storage', `Cannot save estimated parcels: ${error.message}`); }
            try {
                const verified = read(record.city);
                if (!verified || stableJson(verified) !== stableJson(JSON.parse(JSON.stringify(record)))) throw new Error('Storage readback did not match.');
            } catch (error) {
                try { if (previous === null || previous === undefined) storage.removeItem(storageKey); else storage.setItem(storageKey, previous); } catch (_) { /* best effort rollback */ }
                fail('estimate-storage', `Cannot verify estimated parcel save: ${error.message}`);
            }
            return clone(record);
        }
        function readSource(city) { const record = read(city); return record?.active ? createSource(record) : null; }
        function setActive(city, active) {
            const record = read(city); if (!record) return null;
            const next = { ...record, active: Boolean(active) };
            try { storage.setItem(key(record.city), JSON.stringify(next)); }
            catch (error) { fail('estimate-storage', `Cannot update estimated source: ${error.message}`); }
            return clone(next);
        }
        return { prepare, save, read, readSource, setActive };
    }
    return { createStore, createSource, belongsToCity, schema: SCHEMA, maxFeatures: MAX_FEATURES };
});
