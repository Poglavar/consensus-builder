// Portable, bounded share snapshots for proposal comparisons. The codec deliberately knows nothing
// about proposal storage, the map, or application state: callers provide the exact inputs and result.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ComparisonSnapshot = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const MAX_JSON_BYTES = 2 * 1024 * 1024;
    const MAX_HASH_LENGTH = 64000;
    const MAX_PROPOSALS = 1000;
    const MAX_COORDINATE_VERTICES = 100000;
    const HASH_PREFIX = '#comparison=v1.';
    const FORMAT = 'ugt-comparison';
    const VERSION = 1;
    const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

    function fail(message) { throw new Error(`ComparisonSnapshot: ${message}`); }

    function byteLength(text) {
        let bytes = 0;
        for (let i = 0; i < text.length; i += 1) {
            const code = text.charCodeAt(i);
            if (code <= 0x7f) bytes += 1;
            else if (code <= 0x7ff) bytes += 2;
            else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
                && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
                bytes += 4;
                i += 1;
            } else bytes += 3;
            if (bytes > MAX_JSON_BYTES) return bytes;
        }
        return bytes;
    }

    function assertJsonTree(value, label) {
        const ancestors = new Set();
        const coordinateCounts = { total: 0 };
        let visited = 0;
        let stringUnits = 0;

        function visit(node, path, depth) {
            visited += 1;
            if (visited > MAX_JSON_BYTES) fail(`${label} contains too many JSON values`);
            if (depth > 100) fail(`${label} is nested too deeply at ${path}`);
            if (typeof node === 'string') {
                stringUnits += node.length;
                if (stringUnits > MAX_JSON_BYTES) fail(`${label} exceeds ${MAX_JSON_BYTES} bytes`);
                return;
            }
            if (node === null || typeof node === 'boolean') return;
            if (typeof node === 'number') {
                if (!Number.isFinite(node)) fail(`${label} contains a non-finite number at ${path}`);
                return;
            }
            if (typeof node !== 'object') fail(`${label} must contain only JSON values (${path})`);
            if (ancestors.has(node)) fail(`${label} contains a circular reference at ${path}`);
            if (Array.isArray(node)) {
                ancestors.add(node);
                node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
                ancestors.delete(node);
                return;
            }
            const prototype = Object.getPrototypeOf(node);
            if (prototype !== Object.prototype && prototype !== null) {
                fail(`${label} contains a non-plain object at ${path}`);
            }
            const ownKeys = Reflect.ownKeys(node);
            if (ownKeys.some(ownKey => typeof ownKey !== 'string')) fail(`${label} contains a non-JSON key at ${path}`);
            ancestors.add(node);
            for (const childKey of ownKeys) {
                if (FORBIDDEN_KEYS.has(childKey)) fail(`${label} contains forbidden key ${childKey} at ${path}`);
                stringUnits += childKey.length;
                if (stringUnits > MAX_JSON_BYTES) fail(`${label} exceeds ${MAX_JSON_BYTES} bytes`);
                const descriptor = Object.getOwnPropertyDescriptor(node, childKey);
                if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                    fail(`${label} contains an accessor at ${path}.${childKey}`);
                }
                if (childKey === 'coordinates') {
                    coordinateCounts.total += countVertices(descriptor.value);
                    if (coordinateCounts.total > MAX_COORDINATE_VERTICES) {
                        fail(`${label} exceeds ${MAX_COORDINATE_VERTICES} coordinate vertices`);
                    }
                }
                visit(descriptor.value, `${path}.${childKey}`, depth + 1);
            }
            ancestors.delete(node);
        }

        visit(value, '$', 0);
        return coordinateCounts.total;
    }

    function countVertices(coordinates) {
        let count = 0;
        const stack = [{ value: coordinates, depth: 0, index: 0 }];
        while (stack.length) {
            const frame = stack[stack.length - 1];
            const value = frame.value;
            if (!Array.isArray(value)) {
                stack.pop();
                continue;
            }
            if (frame.depth > 100) fail('snapshot coordinates are nested too deeply');
            if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
                count += 1;
                if (count > MAX_COORDINATE_VERTICES) return count;
                stack.pop();
                continue;
            }
            if (frame.index >= value.length) {
                stack.pop();
                continue;
            }
            const child = value[frame.index++];
            if (Array.isArray(child)) stack.push({ value: child, depth: frame.depth + 1, index: 0 });
        }
        return count;
    }

    function isPlainObject(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function validatePolygonGeometry(geometry, label, allowNull) {
        if (geometry === null && allowNull) return;
        if (!isPlainObject(geometry) || !['Polygon', 'MultiPolygon'].includes(geometry.type)
            || !Array.isArray(geometry.coordinates)) {
            fail(`${label} must be a Polygon, MultiPolygon, or allowed null geometry`);
        }
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        if (!polygons.length) fail(`${label} has no polygon rings`);
        polygons.forEach((rings, polygonIndex) => {
            if (!Array.isArray(rings) || !rings.length) fail(`${label} polygon ${polygonIndex} has no rings`);
            rings.forEach((ring, ringIndex) => {
                if (!Array.isArray(ring) || ring.length < 4 || ring.some(position => (
                    !Array.isArray(position) || position.length < 2
                    || !Number.isFinite(position[0]) || !Number.isFinite(position[1])
                ))) fail(`${label} ring ${ringIndex} has invalid coordinates`);
            });
        });
    }

    function validateFeature(feature, label) {
        if (!isPlainObject(feature) || feature.type !== 'Feature') fail(`${label} must be a GeoJSON Feature`);
        if (feature.properties !== null && !isPlainObject(feature.properties)) fail(`${label}.properties must be an object or null`);
        validatePolygonGeometry(feature.geometry, `${label}.geometry`, true);
    }

    function validateFeatureCollection(collection, label) {
        if (!isPlainObject(collection) || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
            fail(`${label} must be a GeoJSON FeatureCollection`);
        }
        collection.features.forEach((feature, index) => validateFeature(feature, `${label}.features[${index}]`));
    }

    function cloneJson(value, label) {
        assertJsonTree(value, label);
        return JSON.parse(JSON.stringify(value));
    }

    function validateInput(input) {
        if (!isPlainObject(input)) fail('input must be an object');
        if (!Array.isArray(input.alternatives) || input.alternatives.length !== 2) {
            fail('input.alternatives must contain exactly two alternatives');
        }
        let proposalCount = 0;
        input.alternatives.forEach((alternative, index) => {
            if (!isPlainObject(alternative)) fail(`input.alternatives[${index}] must be an object`);
            if (typeof alternative.name !== 'string' || !alternative.name) fail(`input.alternatives[${index}].name must be a non-empty string`);
            if (!Array.isArray(alternative.proposals)) fail(`input.alternatives[${index}].proposals must be an array`);
            alternative.proposals.forEach((proposal, proposalIndex) => {
                if (!isPlainObject(proposal)) fail(`input.alternatives[${index}].proposals[${proposalIndex}] must be a record object`);
            });
            proposalCount += alternative.proposals.length;
        });
        if (proposalCount > MAX_PROPOSALS) fail(`input exceeds ${MAX_PROPOSALS} proposals`);
        if (!isPlainObject(input.assumptions)) fail('input.assumptions must be an object');
        if (!isPlainObject(input.context)) fail('input.context must be an object');
        if (typeof input.context.city !== 'string') fail('input.context.city must be a string');
        if (!Array.isArray(input.context.parcels)) fail('input.context.parcels must be an array');
        input.context.parcels.forEach((parcel, index) => {
            if (!isPlainObject(parcel) || typeof parcel.id !== 'string') fail(`input.context.parcels[${index}] must have a string id`);
            validateFeature(parcel.feature, `input.context.parcels[${index}].feature`);
        });
        if (input.scope !== null) {
            if (!isPlainObject(input.scope) || typeof input.scope.source !== 'string') fail('input.scope must be null or an object with a source');
            validatePolygonGeometry(input.scope.geometry, 'input.scope.geometry', true);
        }
    }

    function validateIssues(issues, label) {
        if (!Array.isArray(issues)) fail(`${label} must be an array`);
        issues.forEach((issue, index) => {
            if (!isPlainObject(issue)) fail(`${label}[${index}] must be an object`);
        });
    }

    function validateResult(result) {
        if (!isPlainObject(result)) fail('result must be an object');
        if (typeof result.engineVersion !== 'string' || !result.engineVersion) fail('result.engineVersion must be a non-empty string');
        if (!isPlainObject(result.scope)) fail('result.scope must be an object');
        validatePolygonGeometry(result.scope.geometry, 'result.scope.geometry', true);
        if (!isPlainObject(result.assumptions)) fail('result.assumptions must be an object');
        if (!Array.isArray(result.alternatives) || result.alternatives.length !== 2) {
            fail('result.alternatives must contain exactly two alternatives');
        }
        result.alternatives.forEach((alternative, index) => {
            const label = `result.alternatives[${index}]`;
            if (!isPlainObject(alternative) || typeof alternative.name !== 'string' || !alternative.name) {
                fail(`${label}.name must be a non-empty string`);
            }
            if (!isPlainObject(alternative.metrics)) fail(`${label}.metrics must be an object`);
            validateIssues(alternative.issues, `${label}.issues`);
            if (alternative.features !== undefined) validateFeatureCollection(alternative.features, `${label}.features`);
        });
        if (!isPlainObject(result.deltas)) fail('result.deltas must be an object');
        validateIssues(result.issues, 'result.issues');
    }

    function validateSnapshot(snapshot) {
        assertJsonTree(snapshot, 'snapshot');
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('snapshot must be an object');
        if (snapshot.format !== FORMAT) fail(`unsupported format: ${String(snapshot.format)}`);
        if (snapshot.version !== VERSION) fail(`unsupported version: ${String(snapshot.version)}`);
        if (typeof snapshot.createdAt !== 'string' || !snapshot.createdAt) fail('createdAt must be a non-empty string');
        if (!Object.prototype.hasOwnProperty.call(snapshot, 'input')) fail('snapshot is missing input');
        if (!Object.prototype.hasOwnProperty.call(snapshot, 'result')) fail('snapshot is missing result');
        validateInput(snapshot.input);
        validateResult(snapshot.result);
        if (snapshot.engineVersion !== snapshot.result.engineVersion) fail('engineVersion must match result.engineVersion');
    }

    function encodeUtf8(text) {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
        if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'utf8'));
        const binary = unescape(encodeURIComponent(text)); // eslint-disable-line no-undef
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function decodeUtf8(bytes) {
        if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('utf8');
        let binary = '';
        bytes.forEach(byte => { binary += String.fromCharCode(byte); });
        return decodeURIComponent(escape(binary)); // eslint-disable-line no-undef
    }

    function pakoApi() {
        if (global && global.pako) return global.pako;
        if (typeof globalThis !== 'undefined' && globalThis.pako) return globalThis.pako;
        try { return typeof require === 'function' ? require('../../vendor/pako-2.1.0/pako.min.js') : null; }
        catch (_) { return null; }
    }

    function toBase64Url(bytes) {
        if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function fromBase64Url(value) {
        if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) fail('hash payload is not valid base64url');
        if (typeof Buffer !== 'undefined') {
            const bytes = Buffer.from(value, 'base64url');
            if (bytes.toString('base64url') !== value) fail('hash payload is not canonical base64url');
            return new Uint8Array(bytes);
        }
        let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        let binary;
        try { binary = atob(base64); } catch (_) { fail('hash payload is not valid base64url'); }
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function inflateBounded(compressed) {
        const pako = pakoApi();
        if (!pako || typeof pako.Inflate !== 'function') fail('gzip support is unavailable');
        const inflater = new pako.Inflate({ chunkSize: 64 * 1024 });
        const chunks = [];
        let length = 0;
        inflater.onData = chunk => {
            length += chunk.length;
            if (length > MAX_JSON_BYTES) fail(`decoded JSON exceeds ${MAX_JSON_BYTES} bytes`);
            chunks.push(chunk);
        };
        let finished;
        try { finished = inflater.push(compressed, true); }
        catch (error) {
            if (error && error.message && error.message.startsWith('ComparisonSnapshot:')) throw error;
            fail('hash payload is not valid gzip data');
        }
        if (!finished || inflater.err || !inflater.ended) fail('hash payload is not valid gzip data');
        const bytes = new Uint8Array(length);
        let offset = 0;
        chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.length; });
        try { return decodeUtf8(bytes); } catch (_) { fail('decoded payload is not valid UTF-8'); }
    }

    function stringify(snapshot) {
        validateSnapshot(snapshot);
        const text = JSON.stringify(snapshot);
        if (byteLength(text) > MAX_JSON_BYTES) fail(`JSON exceeds ${MAX_JSON_BYTES} bytes`);
        return text;
    }

    function parse(text) {
        if (typeof text !== 'string') fail('JSON input must be a string');
        if (byteLength(text) > MAX_JSON_BYTES) fail(`JSON exceeds ${MAX_JSON_BYTES} bytes`);
        let snapshot;
        try { snapshot = JSON.parse(text); } catch (_) { fail('malformed JSON'); }
        validateSnapshot(snapshot);
        return snapshot;
    }

    function create(input, result, options = {}) {
        const safeInput = cloneJson(input, 'input');
        const safeResult = cloneJson(result, 'result');
        validateInput(safeInput);
        validateResult(safeResult);
        const snapshot = {
            format: FORMAT,
            version: VERSION,
            createdAt: options.createdAt === undefined ? new Date().toISOString() : options.createdAt,
            engineVersion: safeResult.engineVersion,
            input: safeInput,
            result: safeResult
        };
        validateSnapshot(snapshot);
        stringify(snapshot);
        return snapshot;
    }

    function toHash(snapshot) {
        const text = stringify(snapshot);
        const pako = pakoApi();
        if (!pako || typeof pako.gzip !== 'function') fail('gzip support is unavailable');
        const hash = HASH_PREFIX + toBase64Url(pako.gzip(encodeUtf8(text), { level: 9 }));
        if (hash.length > MAX_HASH_LENGTH) fail(`hash exceeds ${MAX_HASH_LENGTH} characters`);
        return hash;
    }

    function fromHash(hash) {
        if (typeof hash !== 'string') fail('hash must be a string');
        if (hash.length > MAX_HASH_LENGTH) fail(`hash exceeds ${MAX_HASH_LENGTH} characters`);
        if (!hash.startsWith(HASH_PREFIX)) fail('unsupported hash format or version');
        const text = inflateBounded(fromBase64Url(hash.slice(HASH_PREFIX.length)));
        return parse(text);
    }

    return {
        MAX_JSON_BYTES,
        MAX_HASH_LENGTH,
        MAX_PROPOSALS,
        MAX_COORDINATE_VERTICES,
        create,
        stringify,
        parse,
        toHash,
        fromHash
    };
});
