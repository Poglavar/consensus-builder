// Metric frames for geometry anywhere on the globe (projections.md §2). One explicit frame per
// operation: a local transverse Mercator with k₀ = 1 centred on a canonical anchor derived from the
// operation's own coordinates, so a metre is a metre on the WGS84 ellipsoid wherever the geometry
// is, independent of which city is active (measured: < 0.5 mm per 19 m everywhere, 0.8 mm at 60 km
// from the anchor). Pure: proj4 is the only dependency (the browser global, or require('proj4') in
// node). Everything here THROWS on bad input — a point outside the frame's domain, a non-finite
// number, a non-canonical provenance — because a silent fallback is how a 19 m street became 13.65 m.

(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__metricFrame = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const CONTRACT = Object.freeze({
        KIND: 'local-tmerc',
        // The supported latitude band, a product boundary just inside Leaflet's 85.05°.
        MAX_LAT_DEG: 85,
        // Inside this radius the local TM's scale error stays ≤ 4.4e-5 (< 1 mm per 19 m).
        MAX_RADIUS_FROM_ANCHOR_M: 60000,
        // The geodesic diameter a generated footprint may have (checked by construction, not here).
        MAX_FOOTPRINT_DIAMETER_M: 60000,
        ANCHOR_DECIMALS: 6,
        SCALE_TOLERANCE: 5e-5
    });

    function proj4Lib() {
        if (global && global.proj4 && typeof global.proj4 === 'function') return global.proj4;
        if (typeof require === 'function') {
            try { return require('proj4'); } catch (_) { /* not resolvable from frontend/js */ }
            // In node (backend, tests) proj4 lives in backend/node_modules: resolve from the process cwd.
            try { return require(require.resolve('proj4', { paths: [process.cwd()] })); } catch (_) { /* fall through */ }
        }
        throw new Error('metric-frame: proj4 is not available');
    }

    const finite = value => typeof value === 'number' && Number.isFinite(value);

    function wrapLongitude(lon) {
        if (!finite(lon)) throw new Error(`metric-frame: longitude is not a finite number (${lon})`);
        const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
        return wrapped === 0 ? 0 : wrapped; // never -0
    }

    function assertPosition(position) {
        if (!Array.isArray(position) || position.length < 2 || !finite(position[0]) || !finite(position[1])) {
            throw new Error(`metric-frame: position is not [lon, lat] finite numbers (${JSON.stringify(position)})`);
        }
        if (Math.abs(position[1]) > CONTRACT.MAX_LAT_DEG) {
            throw new Error(`metric-frame: latitude ${position[1]} is outside the supported band ±${CONTRACT.MAX_LAT_DEG}°`);
        }
    }

    // Every [lon, lat] in a GeoJSON geometry/feature/collection, a nested coordinate array, or an
    // array of {lat, lng} points. Order is preserved; the first position is the unwrap reference.
    function collectPositions(input, out = []) {
        if (Array.isArray(input)) {
            if (input.length >= 2 && finite(input[0]) && finite(input[1]) && (input.length === 2 || finite(input[2]))) {
                out.push([input[0], input[1]]);
            } else {
                input.forEach(item => collectPositions(item, out));
            }
            return out;
        }
        if (input && typeof input === 'object') {
            if (finite(input.lat) && finite(input.lng)) { out.push([input.lng, input.lat]); return out; }
            if (input.type === 'FeatureCollection') { (input.features || []).forEach(f => collectPositions(f, out)); return out; }
            if (input.type === 'Feature') return collectPositions(input.geometry, out);
            if (input.type === 'GeometryCollection') { (input.geometries || []).forEach(g => collectPositions(g, out)); return out; }
            if (typeof input.type === 'string' && input.coordinates) return collectPositions(input.coordinates, out);
        }
        throw new Error('metric-frame: cannot read positions from this input');
    }

    // Longitudes unwrapped by shortest arc relative to the FIRST position, so a geometry crossing
    // the antimeridian is contiguous (179.99 and -179.99 become 179.99 and 180.01).
    function unwrapLongitudes(positions) {
        if (!positions.length) throw new Error('metric-frame: no positions');
        const first = wrapLongitude(positions[0][0]);
        return positions.map(([lon, lat]) => {
            let delta = wrapLongitude(lon) - first;
            if (delta > 180) delta -= 360;
            if (delta <= -180) delta += 360;
            return [first + delta, lat];
        });
    }

    function roundAnchor(value) {
        const factor = 10 ** CONTRACT.ANCHOR_DECIMALS;
        const rounded = Math.round(value * factor) / factor;
        return rounded === 0 ? 0 : rounded;
    }

    // The canonical anchor of an operation: the midpoint of the bbox of its unwrapped positions,
    // rounded to 1e-6°. Identical for any ring start, winding, multipart order or ±360° longitude
    // representation of the same geometry.
    function canonicalAnchor(input) {
        const positions = collectPositions(input);
        if (!positions.length) throw new Error('metric-frame: no positions to anchor');
        positions.forEach(assertPosition);
        const unwrapped = unwrapLongitudes(positions);
        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const [lon, lat] of unwrapped) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
        if (maxLon - minLon > 180) throw new Error('metric-frame: geometry spans more than 180° of longitude');
        return [roundAnchor(wrapLongitude((minLon + maxLon) / 2)), roundAnchor((minLat + maxLat) / 2)];
    }

    const fixed = value => {
        const text = value.toFixed(CONTRACT.ANCHOR_DECIMALS);
        return text === `-0.${'0'.repeat(CONTRACT.ANCHOR_DECIMALS)}` ? text.slice(1) : text;
    };

    // The one canonical projection string for an anchor. Never accept any other string for a frame.
    function projString(anchor) {
        return `+proj=tmerc +lat_0=${fixed(anchor[1])} +lon_0=${fixed(anchor[0])} +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs +type=crs`;
    }

    function assertAnchor(anchor) {
        if (!Array.isArray(anchor) || anchor.length !== 2 || !finite(anchor[0]) || !finite(anchor[1])) {
            throw new Error('metric-frame: anchor must be [lon, lat]');
        }
        if (roundAnchor(anchor[0]) !== anchor[0] || roundAnchor(anchor[1]) !== anchor[1]) {
            throw new Error(`metric-frame: anchor is not rounded to ${CONTRACT.ANCHOR_DECIMALS} decimals`);
        }
        if (anchor[0] < -180 || anchor[0] >= 180) throw new Error('metric-frame: anchor longitude must be in [-180, 180)');
        if (Math.abs(anchor[1]) > CONTRACT.MAX_LAT_DEG) {
            throw new Error(`metric-frame: anchor latitude ${anchor[1]} is outside the supported band ±${CONTRACT.MAX_LAT_DEG}°`);
        }
    }

    function frameAt(anchorInput) {
        const anchor = [anchorInput[0], anchorInput[1]];
        assertAnchor(anchor);
        const proj4 = proj4Lib();
        const proj = projString(anchor);
        const converter = proj4('EPSG:4326', proj);
        const radius = CONTRACT.MAX_RADIUS_FROM_ANCHOR_M;

        function assertRadius(x, y) {
            const d = Math.hypot(x, y);
            if (!(d <= radius)) {
                throw new Error(`metric-frame: point is ${Math.round(d)} m from the anchor, beyond the ${radius} m domain of this frame`);
            }
        }
        function toMetric(position) {
            assertPosition(position);
            const [x, y] = converter.forward([position[0], position[1]]);
            if (!finite(x) || !finite(y)) throw new Error('metric-frame: projection returned a non-finite result');
            assertRadius(x, y);
            return [x, y];
        }
        function toLngLat(xy) {
            if (!Array.isArray(xy) || !finite(xy[0]) || !finite(xy[1])) throw new Error('metric-frame: metric point must be [x, y] finite numbers');
            assertRadius(xy[0], xy[1]);
            const [lon, lat] = converter.inverse([xy[0], xy[1]]);
            if (!finite(lon) || !finite(lat)) throw new Error('metric-frame: inverse projection returned a non-finite result');
            return [wrapLongitude(lon), lat];
        }
        const frame = {
            kind: CONTRACT.KIND,
            anchor: Object.freeze(anchor),
            proj,
            toMetric,
            toLngLat,
            // {lat, lng} conveniences for code that works in Leaflet order.
            latLngToMetric: (lat, lng) => toMetric([lng, lat]),
            metricToLatLng: (x, y) => { const [lon, lat] = toLngLat([x, y]); return [lat, lon]; },
            // Every position of `input` lies inside this frame's domain (throws otherwise).
            assertWithin(input) { collectPositions(input).forEach(toMetric); return true; },
            provenance: () => ({ kind: CONTRACT.KIND, anchor: [anchor[0], anchor[1]], proj, proj4: String(proj4.version || 'unknown') })
        };
        return Object.freeze(frame);
    }

    function frameFor(input) {
        return frameAt(canonicalAnchor(input));
    }

    // Rebuild a frame from persisted provenance. Only the canonical string for the stated anchor is
    // accepted: a client cannot smuggle in a different projection.
    function frameFromProvenance(provenance) {
        if (!provenance || typeof provenance !== 'object') throw new Error('metric-frame: provenance missing');
        if (provenance.kind !== CONTRACT.KIND) throw new Error(`metric-frame: unsupported frame kind ${provenance.kind}`);
        const anchor = provenance.anchor;
        assertAnchor(anchor);
        if (provenance.proj !== projString(anchor)) throw new Error('metric-frame: provenance proj string is not the canonical string for its anchor');
        return frameAt(anchor);
    }

    // Vincenty's inverse on WGS84: the distance in metres between two [lon, lat] positions along
    // the ellipsoid. Used for measurement (no projection needed) and as the yardstick for frames.
    function geodesicDistance(a, b) {
        assertPosition(a); assertPosition(b);
        const A = 6378137, F = 1 / 298.257223563, B = A * (1 - F), rad = Math.PI / 180;
        const L = (b[0] - a[0]) * rad;
        const U1 = Math.atan((1 - F) * Math.tan(a[1] * rad)), U2 = Math.atan((1 - F) * Math.tan(b[1] * rad));
        const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
        let lam = L, lamPrev, iterations = 0, sinSigma, cosSigma, sigma, sinAlpha, cosSqAlpha, cos2SigmaM;
        do {
            const sinLam = Math.sin(lam), cosLam = Math.cos(lam);
            sinSigma = Math.sqrt((cU2 * sinLam) ** 2 + (cU1 * sU2 - sU1 * cU2 * cosLam) ** 2);
            if (sinSigma === 0) return 0;
            cosSigma = sU1 * sU2 + cU1 * cU2 * cosLam;
            sigma = Math.atan2(sinSigma, cosSigma);
            sinAlpha = cU1 * cU2 * sinLam / sinSigma;
            cosSqAlpha = 1 - sinAlpha * sinAlpha;
            cos2SigmaM = cosSqAlpha ? cosSigma - 2 * sU1 * sU2 / cosSqAlpha : 0;
            const C = F / 16 * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
            lamPrev = lam;
            lam = L + (1 - C) * F * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
        } while (Math.abs(lam - lamPrev) > 1e-12 && ++iterations < 200);
        if (iterations >= 200) throw new Error('metric-frame: geodesic distance did not converge (near-antipodal points)');
        const uSq = cosSqAlpha * (A * A - B * B) / (B * B);
        const bigA = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
        const bigB = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
        const deltaSigma = bigB * sinSigma * (cos2SigmaM + bigB / 4 * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
            - bigB / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
        return B * bigA * (sigma - deltaSigma);
    }

    return Object.freeze({
        CONTRACT, wrapLongitude, collectPositions, unwrapLongitudes, canonicalAnchor, projString,
        frameAt, frameFor, frameFromProvenance, geodesicDistance
    });
});
