// The on-chain identity of a proposal's site: proposal_nft v3 stores `site_hash`, the sha256 of the
// site's canonical encoding below, plus `open_ground` (part of the site lies on no bound parcel).
// One definition, used by every minter (browser bridge, agents) and decoder; see PARCEL-OPTIONAL.md
// "Chain (phase 5)".
//
// CANONICAL ENCODING (version 1). Input: a GeoJSON Polygon or MultiPolygon in EPSG:4326 (or a
// Feature holding one). Output: the UTF-8 bytes of
//   {"coordinates":[...],"type":"MultiPolygon"}
// with no whitespace, where coordinates are INTEGERS in units of 1e-7 degree (Math.round(deg * 1e7),
// so float printing never matters), z values dropped, and
//   - each ring: closing vertex removed, consecutive duplicates (after rounding) removed, rotated to
//     start at its smallest vertex (x, then y), oriented exterior counter-clockwise and holes
//     clockwise (RFC 7946), then closed again by repeating the first vertex; rings with fewer than 3
//     distinct vertices are dropped;
//   - holes of a polygon sorted, polygons sorted (lexicographic over their rings' integer arrays);
//   - nothing is unioned: deriving the site (and merging overlaps) is site-binding.js's job.
// The hash is sha256 over those bytes: 32 bytes, never all zero for a real site. A zero hash on
// chain means "no site" (every v1/v2 proposal).
//
// Pure; sha256 comes from WebCrypto (globalThis.crypto.subtle, in browsers and node >= 19).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__siteHash = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const SITE_HASH_VERSION = 1;
    const COORDINATE_SCALE = 1e7;
    const ZERO_SITE_HASH = Object.freeze(Array(32).fill(0));

    function geometryOf(input) {
        if (!input || typeof input !== 'object') throw new Error('site must be a GeoJSON Polygon or MultiPolygon');
        if (input.type === 'Feature') return geometryOf(input.geometry);
        if (input.type === 'Polygon') return [input.coordinates];
        if (input.type === 'MultiPolygon') return input.coordinates;
        throw new Error(`site must be a Polygon or MultiPolygon, not ${input.type}`);
    }

    function toUnit(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('site coordinate is not a finite number');
        const scaled = Math.round(value * COORDINATE_SCALE);
        return scaled === 0 ? 0 : scaled; // never -0
    }

    function compareVertex(a, b) {
        return a[0] - b[0] || a[1] - b[1];
    }

    function compareArrays(a, b) {
        const length = Math.min(a.length, b.length);
        for (let i = 0; i < length; i += 1) {
            const order = Array.isArray(a[i]) ? compareArrays(a[i], b[i]) : a[i] - b[i];
            if (order) return order;
        }
        return a.length - b.length;
    }

    // Twice the signed area (shoelace) in degree units; positive = counter-clockwise.
    function signedArea(vertices) {
        let sum = 0;
        for (let i = 0; i < vertices.length; i += 1) {
            const [x1, y1] = vertices[i];
            const [x2, y2] = vertices[(i + 1) % vertices.length];
            sum += (x1 / COORDINATE_SCALE) * (y2 / COORDINATE_SCALE) - (x2 / COORDINATE_SCALE) * (y1 / COORDINATE_SCALE);
        }
        return sum;
    }

    // An open list of distinct integer vertices, or null when the ring is degenerate.
    function canonicalRing(ring, counterClockwise) {
        if (!Array.isArray(ring)) throw new Error('site ring is not an array');
        const vertices = [];
        for (const point of ring) {
            if (!Array.isArray(point) || point.length < 2) throw new Error('site vertex is not a coordinate pair');
            const vertex = [toUnit(point[0]), toUnit(point[1])];
            const last = vertices[vertices.length - 1];
            if (!last || compareVertex(last, vertex) !== 0) vertices.push(vertex);
        }
        while (vertices.length > 1 && compareVertex(vertices[0], vertices[vertices.length - 1]) === 0) vertices.pop();
        if (vertices.length < 3) return null;
        const area = signedArea(vertices);
        if (area === 0) return null;
        if ((area > 0) !== counterClockwise) vertices.reverse();
        let start = 0;
        for (let i = 1; i < vertices.length; i += 1) if (compareVertex(vertices[i], vertices[start]) < 0) start = i;
        const rotated = vertices.slice(start).concat(vertices.slice(0, start));
        rotated.push(rotated[0].slice());
        return rotated;
    }

    /** The canonical MultiPolygon coordinates (integer 1e-7 degree units) of a site. */
    function canonicalSiteCoordinates(site) {
        const polygons = [];
        for (const polygon of geometryOf(site)) {
            if (!Array.isArray(polygon) || !polygon.length) continue;
            const exterior = canonicalRing(polygon[0], true);
            if (!exterior) continue;
            const holes = polygon.slice(1).map(ring => canonicalRing(ring, false)).filter(Boolean).sort(compareArrays);
            polygons.push([exterior, ...holes]);
        }
        if (!polygons.length) throw new Error('site has no polygon with area');
        return polygons.sort(compareArrays);
    }

    /** The exact string whose UTF-8 bytes are hashed. */
    function canonicalSiteJson(site) {
        return JSON.stringify({ coordinates: canonicalSiteCoordinates(site), type: 'MultiPolygon' });
    }

    function subtle() {
        const scope = typeof globalThis !== 'undefined' ? globalThis : null;
        if (scope && scope.crypto && scope.crypto.subtle) return scope.crypto.subtle;
        throw new Error('WebCrypto (crypto.subtle) is not available to hash the site');
    }

    /** sha256 of the canonical site encoding, as a 32-byte Uint8Array. */
    async function siteHash(site) {
        const bytes = new TextEncoder().encode(canonicalSiteJson(site));
        return new Uint8Array(await subtle().digest('SHA-256', bytes));
    }

    function toHex(bytes) {
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function siteHashHex(site) {
        return toHex(await siteHash(site));
    }

    function isZeroSiteHash(bytes) {
        if (!bytes || bytes.length !== 32) throw new Error('a site hash is 32 bytes');
        for (const byte of bytes) if (byte !== 0) return false;
        return true;
    }

    /** A decoded on-chain site_hash: lowercase hex, or null for the zero hash ("no site"). */
    function siteHashFromChain(bytes) {
        return isZeroSiteHash(bytes) ? null : toHex(bytes);
    }

    /**
     * The two v3 mint arguments for a proposal: `siteHash` (32 bytes, zero without a site) and
     * `openGround`. Open ground is every part of the site no bound parcel covers, so it is true for
     * an empty binding and for a binding whose coverage is not `complete` (partial, none, unknown).
     * A site is required whenever the parcel list is empty.
     */
    async function chainSiteArgs({ site = null, binding = null, parcelIds = [] } = {}) {
        const hasParcels = Array.isArray(parcelIds) && parcelIds.length > 0;
        if (!site) {
            if (!hasParcels) throw new Error('a proposal without parcels needs a site');
            return { siteHash: Uint8Array.from(ZERO_SITE_HASH), openGround: false };
        }
        const coverage = binding && typeof binding === 'object' ? binding.coverage : null;
        const openGround = !hasParcels || (binding !== null && coverage !== 'complete');
        return { siteHash: await siteHash(site), openGround };
    }

    return {
        SITE_HASH_VERSION,
        COORDINATE_SCALE,
        ZERO_SITE_HASH,
        canonicalSiteCoordinates,
        canonicalSiteJson,
        siteHash,
        siteHashHex,
        isZeroSiteHash,
        siteHashFromChain,
        chainSiteArgs
    };
});
