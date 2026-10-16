// Heights and extrusion for building footprints that may carry no height, shared by the backend
// providers (backend/buildings/building-heights.js and extrude.js re-export it) and by the browser,
// which extrudes buildings it reads straight from a public source (overture-tiles.js). One file so a
// building drawn from a server answer and one drawn in the browser rise by the same rule.
//
// Heights, cheapest truth first and the invented value last:
//   1. a measured height (the OSM `height` tag, Overture's `height`)       → source 'measured'
//   2. a storey count (`building:levels`, Overture's `num_floors`) × 3 m   → source 'levels'
//   3. an ESTIMATE: storeys drawn from a range that suits the building's OSM type and footprint
//      area, seeded by the building's id so the same building gets the same height on every load
//      and from every server                                               → source 'estimated'
// The source travels with every height so nothing downstream mistakes an estimate for a survey.
//
// Extrusion turns a 2D footprint (GeoJSON Polygon/MultiPolygon in lng/lat) into the flat-face mesh
// shape the 3D renderer consumes — the same { faces: [<GeoJSON Polygon with [lng,lat,z] coords in
// metres>] } format that Zagreb's pre-built `gdi_building_3d` meshes produce, so the renderer stays
// source-agnostic. It is also how a CUT building is rebuilt (backend carve.js re-extrudes the
// remainder polygon the demolition record carries).
(function () {
    const STOREY_M = 3;

    // FNV-1a over the id's UTF-16 code units, then mulberry32: tiny, fast and stable across processes.
    function seededRandom(id) {
        let h = 0x811c9dc5;
        const text = String(id);
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        let a = h >>> 0;
        return function next() {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Storey ranges [min, max]. Types first: a shed is one storey whatever its size, a block of flats
    // is never one. Untyped (`building=yes`) falls back to the footprint area.
    const TYPE_STOREYS = {
        garage: [1, 1], garages: [1, 1], shed: [1, 1], carport: [1, 1], hut: [1, 1], cabin: [1, 1],
        kiosk: [1, 1], roof: [1, 1], greenhouse: [1, 1], service: [1, 1], toilets: [1, 1],
        house: [1, 3], detached: [1, 3], semidetached_house: [2, 3], bungalow: [1, 1], farm: [1, 2],
        terrace: [2, 3], residential: [2, 5], apartments: [3, 8], dormitory: [3, 6], hotel: [3, 8],
        commercial: [2, 5], office: [3, 8], retail: [1, 3], supermarket: [1, 2], industrial: [1, 2],
        warehouse: [1, 2], church: [2, 4], school: [2, 4], hospital: [3, 6], university: [3, 5]
    };

    function areaStoreys(areaM2) {
        if (!(areaM2 > 0)) return [1, 3];
        if (areaM2 < 50) return [1, 2];
        if (areaM2 < 150) return [1, 3];
        if (areaM2 < 400) return [2, 4];
        if (areaM2 < 1500) return [2, 6];
        return [3, 8];
    }

    function positive(value) {
        const n = typeof value === 'number' ? value : parseFloat(value);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    // { id, heightM, levels, building, areaM2 } → { heightM, floors, source }.
    function resolveBuildingHeight({ id, heightM, levels, building, areaM2 } = {}) {
        const measured = positive(heightM);
        const storeys = positive(levels);
        if (measured) return { heightM: measured, floors: storeys, source: 'measured' };
        if (storeys) return { heightM: storeys * STOREY_M, floors: storeys, source: 'levels' };
        const [min, max] = TYPE_STOREYS[String(building || '').toLowerCase()] || areaStoreys(areaM2);
        const floors = min + Math.floor(seededRandom(id)() * (max - min + 1));
        return { heightM: floors * STOREY_M, floors, source: 'estimated' };
    }

    // Planar area in m² of a lng/lat Polygon or MultiPolygon (outer rings minus holes), scaled by the
    // cosine of its latitude: plenty for choosing a storey range, not a survey measurement.
    function footprintAreaM2(geometry) {
        if (!geometry) return 0;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
            : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        let total = 0;
        for (const polygon of polygons) {
            (polygon || []).forEach((ring, index) => {
                if (!Array.isArray(ring) || ring.length < 4) return;
                const lat = ring[0][1] * Math.PI / 180;
                const kx = 111320 * Math.cos(lat);
                const ky = 110540;
                let sum = 0;
                for (let i = 0; i < ring.length - 1; i++) {
                    sum += (ring[i][0] * kx) * (ring[i + 1][1] * ky) - (ring[i + 1][0] * kx) * (ring[i][1] * ky);
                }
                total += (index === 0 ? 1 : -1) * Math.abs(sum) / 2;
            });
        }
        return Math.max(0, total);
    }

    // Walls: one vertical quad per footprint edge. Roof: the footprint outline (with holes)
    // lifted to the roof height. The base is left open — it never faces the camera in a
    // ground-level scene, so omitting it halves the wall-adjacent payload.
    function ringWalls(ring, baseZ, topZ, faces) {
        for (let i = 0; i < ring.length - 1; i++) {
            const a = ring[i];
            const b = ring[i + 1];
            if (!a || !b || a.length < 2 || b.length < 2) continue;
            faces.push({
                type: 'Polygon',
                coordinates: [[
                    [a[0], a[1], baseZ],
                    [b[0], b[1], baseZ],
                    [b[0], b[1], topZ],
                    [a[0], a[1], topZ],
                    [a[0], a[1], baseZ]
                ]]
            });
        }
    }

    // polygon: array of rings (outer + optional holes), each a closed [ [lng,lat], ... ] ring.
    function extrudePolygon(polygon, baseZ, topZ, faces) {
        if (!Array.isArray(polygon) || polygon.length === 0) return;
        for (const ring of polygon) {
            if (Array.isArray(ring) && ring.length >= 4) ringWalls(ring, baseZ, topZ, faces);
        }
        // Roof: same rings (outer drives the outline, the rest punch holes) at roof height.
        const roof = polygon
            .filter(r => Array.isArray(r) && r.length >= 4)
            .map(r => r.map(c => [c[0], c[1], topZ]));
        if (roof.length > 0) faces.push({ type: 'Polygon', coordinates: roof });
    }

    // Returns the building record in the common renderer shape, or null if degenerate.
    //
    // `baseZ` is the elevation the walls rise FROM, in the same frame as the source data's Z. It is 0
    // for footprint+height cities (NYC), where Z is height above ground. Zagreb's `gdi_building_3d`
    // faces carry ABSOLUTE elevation instead (z_min is the ground under the building, ~120 m in the
    // centre), so re-extruding one of those meshes must pass its z_min or the rebuilt building sinks
    // to sea level.
    function extrudeFootprint(objectId, geometry, heightMeters, baseZ = 0) {
        if (!geometry || !(heightMeters > 0)) return null;
        const base = Number.isFinite(Number(baseZ)) ? Number(baseZ) : 0;
        const top = base + heightMeters;
        const faces = [];
        if (geometry.type === 'Polygon') {
            extrudePolygon(geometry.coordinates, base, top, faces);
        } else if (geometry.type === 'MultiPolygon') {
            for (const poly of geometry.coordinates) extrudePolygon(poly, base, top, faces);
        } else {
            return null;
        }
        if (faces.length === 0) return null;
        return { object_id: objectId, z_min: base, z_max: top, faces };
    }

    const api = { STOREY_M, TYPE_STOREYS, resolveBuildingHeight, footprintAreaM2, extrudeFootprint };
    if (typeof window !== 'undefined') window.BuildingExtrusion = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
