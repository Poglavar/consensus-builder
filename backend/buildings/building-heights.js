// Heights for building footprints that may carry none. OpenStreetMap records a height or a storey
// count for only a minority of buildings, and a footprint without a height is not drawn in 3D at
// all, so most of a city would vanish. The chain, cheapest truth first and the invented value last:
//   1. a measured height (the OSM `height` tag, Overture's `height`)       → source 'measured'
//   2. a storey count (`building:levels`, Overture's `num_floors`) × 3 m   → source 'levels'
//   3. an ESTIMATE: storeys drawn from a range that suits the building's OSM type and footprint
//      area, seeded by the building's id so the same building gets the same height on every load
//      and from every server                                               → source 'estimated'
// The source travels with every height so nothing downstream mistakes an estimate for a survey.

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
export function resolveBuildingHeight({ id, heightM, levels, building, areaM2 } = {}) {
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
export function footprintAreaM2(geometry) {
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

export { STOREY_M, TYPE_STOREYS };
