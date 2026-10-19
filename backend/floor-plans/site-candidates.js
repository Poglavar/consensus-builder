// Gathers the places a posting could be talking about: official address points for its street and
// number, eDozvola permits it cites or that sit near its pin or on its street, and the parcels under
// them. Overlapping evidence merges into one candidate site. Scoring lives in site-scoring.js.
import { buildStreetIndex, fold } from './site-signals.js';
import { sameStreet } from './site-scoring.js';
import { stem } from './site-signals.js';

// The City of Zagreb's extent; listings elsewhere get no candidates until their sources are loaded.
const ZAGREB_BBOX = [15.75, 45.68, 16.25, 45.97];
const BUILDING_LAYERS = ['eDozvola_building_polygon', 'eDozvola_area_polygon'];

let streetCache = null;
// Synchronous readers (page qualification) use the index once a crawl or reparse has loaded it;
// before that, street-name mentions are simply not read.
export const cachedStreetIndex = () => streetCache || [];
export async function zagrebStreetIndex(db) {
    if (!streetCache) {
        const names = (await db.query(`SELECT DISTINCT street_name FROM public.street WHERE current AND city_name='Zagreb'`)).rows.map(r => r.street_name);
        streetCache = buildStreetIndex(names);
    }
    return streetCache;
}

// Number forms an official register may use for what an ad wrote: exact, base number, or a range.
export function numberVariants(raw) {
    const value = fold(raw).replace(/\s+/g, '');
    if (!value) return { exact: [], loose: [] };
    const range = value.match(/^(\d+)-(\d+)$/);
    if (range) {
        const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
        const span = b - a <= 40 ? Array.from({ length: b - a + 1 }, (_, i) => String(a + i)) : [String(a), String(b)];
        return { exact: [], loose: span };
    }
    const base = value.match(/^\d+/)?.[0];
    return { exact: [value], loose: base && base !== value ? [base] : [] };
}

async function addressPointSites(db, signals) {
    const sites = [];
    for (const claim of signals.addresses || []) {
        if (!claim.number) continue;
        const { exact, loose } = numberVariants(claim.number);
        const numbers = [...exact, ...loose];
        if (!numbers.length) continue;
        // Points first, street filter in code, then parcels and survey only for the few that match.
        const points = (await db.query(`SELECT a.id, a.street, a.number, a.settlement, ST_X(a.geom) AS lng, ST_Y(a.geom) AS lat
            FROM public.overture_address a
            WHERE a.current AND a.country='HR' AND a.geom_3765 && ST_Transform(ST_MakeEnvelope($2,$3,$4,$5,4326),3765)
              AND lower(regexp_replace(a.number,'\\s','','g')) = ANY($1::text[])`, [numbers, ...ZAGREB_BBOX])).rows
            .filter(row => sameStreet(row.street, claim.street));
        const rows = points.length ? (await db.query(`SELECT a.id,
                (SELECT jsonb_agg(jsonb_build_object('cesticaId', p.cestica_id, 'ko', p.maticni_broj_ko::text, 'kc', p.broj_cestice))
                   FROM public.parcel p WHERE p.current AND ST_Contains(p.geom, a.geom_3765)) AS parcels,
                (SELECT jsonb_agg(b.object_id::text) FROM public.gdi_building_3d b WHERE ST_Contains(b.geom2d_3765, a.geom_3765)) AS survey
            FROM public.overture_address a WHERE a.id = ANY($1::text[])`, [points.map(p => p.id)])).rows
            .map(row => ({ ...points.find(p => p.id === row.id), ...row })) : [];
        for (const row of rows) {
            const number = fold(row.number).replace(/\s+/g, '');
            sites.push({ source: 'address-point', key: `address:${row.id}`, parcels: row.parcels || [], survey: row.survey || [],
                addressPoints: [{ id: row.id, street: row.street, number: row.number, settlement: row.settlement,
                    matchKind: exact.includes(number) ? 'exact' : 'base', basis: claim.basis || null, claim: claim.quote || `${claim.street} ${claim.number}` }],
                point: { lng: row.lng, lat: row.lat } });
        }
    }
    return sites;
}

function streetPatterns(signals) {
    const names = [...(signals.addresses || []), ...(signals.streets || [])].map(item => item.street).filter(Boolean);
    const stems = new Set();
    for (const name of names) {
        const words = fold(name).split(' ').filter(word => word.length > 4 && !/^(ulica|ulici|cesta|trg|avenija|grada|obala|odvojak|prilaz|zavrtnica)$/.test(word));
        const longest = words.sort((a, b) => b.length - a.length)[0];
        if (longest) stems.add(`%${stem(longest)}%`);
    }
    return [...stems];
}

async function permitFeatures(db, signals, { radiusM, maxAgeYears }) {
    const pin = signals.pin;
    const patterns = streetPatterns(signals);
    const recent = `COALESCE(f.final_on, f.decided_on, f.received_on) IS NULL
        OR COALESCE(f.final_on, f.decided_on, f.received_on) >= (now() - make_interval(years => $1))::date`;
    const params = [maxAgeYears, BUILDING_LAYERS];
    const clauses = [];
    if (signals.klasa?.length) { params.push(signals.klasa); clauses.push(`f.klasa = ANY($${params.length}::text[])`); }
    if (pin) {
        params.push(pin.lng, pin.lat, radiusM);
        clauses.push(`ST_DWithin(f.geom, ST_Transform(ST_SetSRID(ST_MakePoint($${params.length - 2},$${params.length - 1}),4326),3765), $${params.length})`);
    }
    if (patterns.length) {
        params.push(patterns);
        clauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(f.locations) l WHERE unaccent(lower(l->>'street')) LIKE ANY($${params.length}::text[]))`);
    }
    if (!clauses.length) return [];
    params.push(...ZAGREB_BBOX);
    const n = params.length;
    return (await db.query(`SELECT f.id, f.layer, f.case_id, f.case_kind, f.klasa, f.received_on::text, f.decided_on::text, f.final_on::text,
            f.works, f.works_detail, f.use_kind, f.gbp_m2, f.locations, ST_Area(f.geom) AS area_m2,
            ${pin ? `ST_Distance(f.geom, ST_Transform(ST_SetSRID(ST_MakePoint(${Number(pin.lng)},${Number(pin.lat)}),4326),3765))` : 'NULL'} AS pin_distance_m
        FROM public.edozvola_feature f
        WHERE f.current AND f.layer = ANY($2::text[]) AND (${recent})
          AND f.geom && ST_Transform(ST_MakeEnvelope($${n - 3},$${n - 2},$${n - 1},$${n},4326),3765)
          AND (${clauses.join(' OR ')})
        ORDER BY pin_distance_m NULLS LAST, f.final_on DESC NULLS LAST LIMIT 400`, params)).rows;
}

// Union-find over features: same case, or geometries that touch, belong to one site.
async function groupSites(db, features) {
    const parent = new Map(features.map(feature => [feature.id, feature.id]));
    const find = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
    const join = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(x, y); };
    const byCase = new Map();
    for (const feature of features) {
        if (byCase.has(feature.case_id)) join(feature.id, byCase.get(feature.case_id)); else byCase.set(feature.case_id, feature.id);
    }
    if (features.length > 1) {
        // Some published permit polygons self-intersect; repair a copy once per feature for the overlap test.
        const pairs = (await db.query(`WITH g AS (SELECT id, ST_MakeValid(geom) AS geom FROM public.edozvola_feature WHERE id = ANY($1::text[]))
            SELECT a.id AS a, b.id AS b FROM g a JOIN g b
            ON a.id < b.id AND ST_Intersects(a.geom, b.geom) AND ST_Area(ST_Intersection(a.geom, b.geom)) > 1`, [features.map(f => f.id)])).rows;
        for (const pair of pairs) join(pair.a, pair.b);
    }
    const groups = new Map();
    for (const feature of features) {
        const root = find(feature.id);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(feature);
    }
    return [...groups.values()];
}

function permitSummary(features, details) {
    const cases = new Map();
    for (const feature of features) {
        const entry = cases.get(feature.case_id) || { caseId: feature.case_id, klasa: feature.klasa, kind: feature.case_kind,
            works: feature.works, worksDetail: feature.works_detail, use: feature.use_kind, receivedOn: feature.received_on,
            decidedOn: feature.decided_on, finalOn: feature.final_on, gbpM2: feature.gbp_m2 === null ? null : Number(feature.gbp_m2),
            streets: [], parcels: [], layers: [] };
        for (const location of feature.locations || []) {
            if (location.street && !entry.streets.includes(location.street)) entry.streets.push(location.street);
            for (const kc of location.parcels || []) if (!entry.parcels.some(p => p.kc === kc && p.ko === location.cadastralMunicipalityId))
                entry.parcels.push({ kc, ko: location.cadastralMunicipalityId, koName: location.cadastralMunicipality });
        }
        if (!entry.layers.includes(feature.layer)) entry.layers.push(feature.layer);
        const extra = details.get(feature.klasa);
        if (extra) Object.assign(entry, { units: extra.number_of_units || null, gbpM2: entry.gbpM2 ?? (extra.gbp === null ? null : Number(extra.gbp)),
            height: extra.building_height || null, investor: extra.investor_name || null });
        cases.set(feature.case_id, entry);
    }
    return [...cases.values()];
}

// Only Zagreb's sources are loaded; a posting placed in another town gets no Zagreb street or
// address candidates (its own map pin still counts, since the pin is where it says it is).
const ZAGREB_LOCALITIES = new Set(['zagreb', 'grad zagreb', 'sesvete', 'novi zagreb', 'city of zagreb']);
const outsideZagreb = signals => Boolean(signals.locality) && !ZAGREB_LOCALITIES.has(fold(signals.locality));

export async function siteCandidates(db, signals, { radiusM = 300, maxAgeYears = 12 } = {}) {
    if (outsideZagreb(signals)) signals = { ...signals, addresses: [], streets: [] };
    const [points, fetched] = await Promise.all([addressPointSites(db, signals), permitFeatures(db, signals, { radiusM, maxAgeYears })]);
    // A permit found only through a street-name pattern must really be on one of the named streets.
    const named = [...(signals.addresses || []), ...(signals.streets || [])].map(item => item.street);
    const features = fetched.filter(f => (signals.klasa || []).includes(f.klasa) || (f.pin_distance_m !== null && Number(f.pin_distance_m) <= radiusM)
        || (f.locations || []).some(l => named.some(street => l.street && sameStreet(l.street, street))));
    const klasas = [...new Set(features.map(f => f.klasa).filter(Boolean))];
    const details = new Map(klasas.length ? (await db.query(`SELECT class_number, number_of_units, gbp, building_height, investor_name
        FROM public.permit WHERE class_number = ANY($1::text[])`, [klasas])).rows.map(row => [row.class_number, row]) : []);
    const sites = (await groupSites(db, features)).map(group => {
        const permits = permitSummary(group, details);
        const distances = group.map(f => f.pin_distance_m).filter(d => d !== null).map(Number);
        return { source: 'permit', key: `permit:${group.map(f => f.id).sort()[0]}`, featureIds: group.map(f => f.id),
            permits, parcels: permits.flatMap(p => p.parcels), addressPoints: [], survey: [],
            pinDistanceM: distances.length ? Math.min(...distances) : null };
    });
    // An address point on a permit site is one place seen twice; otherwise it is its own site.
    for (const point of points) {
        const pointParcels = new Set(point.parcels.map(p => `${p.ko}:${p.kc}`));
        let host = sites.find(site => site.parcels.some(p => pointParcels.has(`${p.ko}:${p.kc}`)));
        if (!host && sites.length) {
            const inside = (await db.query(`SELECT DISTINCT f.id FROM public.edozvola_feature f WHERE f.id = ANY($1::text[])
                AND ST_DWithin(ST_MakeValid(f.geom), ST_Transform(ST_SetSRID(ST_MakePoint($2,$3),4326),3765), 2)`,
            [sites.flatMap(s => s.featureIds), point.point.lng, point.point.lat])).rows.map(r => r.id);
            host = sites.find(site => site.featureIds.some(id => inside.includes(id)));
        }
        if (host) {
            host.addressPoints.push(...point.addressPoints);
            for (const parcel of point.parcels) if (!host.parcels.some(p => p.ko === parcel.ko && p.kc === parcel.kc)) host.parcels.push(parcel);
            host.survey.push(...point.survey);
        } else {
            sites.push({ ...point, permits: [], featureIds: [],
                pinDistanceM: signals.pin ? haversineM(signals.pin, point.point) : null });
        }
    }
    return sites.map((site, index) => ({ ...site, id: `S${index + 1}` }));
}

export function haversineM(a, b) {
    const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
