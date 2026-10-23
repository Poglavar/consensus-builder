// Published design/v1 and agreement/v1 objects for the publish-route tests (plan-design-agreement.md
// M2), the index rows the server stores for them, and a scripted cadastre that answers the binding
// statements a design's site runs (proposals/binding.js) as a mock pool's `bindingAnswer`.
import { createHash } from 'node:crypto';
import { cidOfObject } from '../../cid.js';
import { BINDING_COUNT_SQL, BINDING_SQL, FOOTPRINT_OUTSIDE_SITE_SQL, PARCEL_ACT_SITE_SQL } from '../../proposals/binding.js';

export const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
// A park inside its site, both in Zagreb.
export const PARK = box(15.97, 45.80, 15.971, 45.801);
export const SITE = box(15.969, 45.799, 15.972, 45.802);
export const SITE_MULTI = { type: 'MultiPolygon', coordinates: [SITE.coordinates] };
export const AUTHORED_AT = '2026-10-21T08:00:00.000Z';

export const cidOf = cidOfObject;

/** A park design on SITE; every design/v1 field present. */
export function designContent(overrides = {}) {
    return {
        schema: 'design/v1',
        goal: 'park',
        title: 'Riverside park',
        description: 'A park on the river bank.',
        author: 'Studio North',
        city: 'zagreb',
        site: SITE,
        toleranceM: null,
        geometry: null,
        origin: null,
        authoredAt: AUTHORED_AT,
        structureProposal: { kind: 'park', geometry: PARK },
        ...overrides
    };
}

/** A parcel layout of SITE in two plots: published only with the agreement that settles its land. */
export function layoutContent(overrides = {}) {
    const { structureProposal: _park, ...design } = designContent();
    return {
        ...design,
        goal: 'parcel-layout',
        title: 'Two plots',
        parcelLayout: {
            algorithm: 'manual', generatedAt: AUTHORED_AT, pool: SITE, totalArea: 9000,
            plots: [
                { geometry: box(15.969, 45.799, 15.9705, 45.802), area: 4500, source: 'manual' },
                { geometry: box(15.9705, 45.799, 15.972, 45.802), area: 4500, source: 'manual' }
            ]
        },
        ...overrides
    };
}

// A parcel the cadastre finds under a site: bound (it reaches in beyond the tolerance) or touched.
export const hit = (parcelId, intrusionM, bound = true, overlapM2 = 50) => ({ parcelId, overlapM2, intrusionM, bound });
// Two parcels bound, a third only touched.
export const SPILL = [hit('HR-335649-100', 40.2), hit('HR-335649-101', 0.42), hit('HR-335649-102', 0.0004, false, 0.01)];

/**
 * The binding statements answered as a cadastre holding `parcels` under any site (null for every
 * other statement, which then goes to the mock pool's answers and queue).
 */
export function scriptedCadastre({ count = 3, parcels = SPILL, inRegion = true, unsurveyedM2 = 0, unknownM2 = 0, outsideM2 = 0 } = {}) {
    return (sql, params) => {
        if (sql === BINDING_COUNT_SQL) return { rows: [{ parcels: count }] };
        if (sql === FOOTPRINT_OUTSIDE_SITE_SQL) return { rows: [{ outside_m2: outsideM2 }] };
        if (sql === BINDING_SQL) {
            return { rows: [{ parcels, site_m2: 9000, in_region: inRegion, unsurveyed_m2: unsurveyedM2, unknown_m2: unknownM2, site_geojson: JSON.stringify(SITE_MULTI) }] };
        }
        if (sql === PARCEL_ACT_SITE_SQL) {
            const ids = JSON.parse(params[0]).map(entry => entry.id);
            return { rows: [{ parcels: ids.map(id => ({ parcelId: id, overlapM2: 400 })), site_geojson: JSON.stringify(SITE_MULTI), site_m2: 400 * ids.length }] };
        }
        return null;
    };
}

/** The binding the server stores for a design taking `parcelIds`. */
export function bindingOf(parcelIds, extra = {}) {
    return {
        parcels: parcelIds.map(parcelId => ({ parcelId, overlapM2: 50, intrusionM: 1 })),
        touched: [], toleranceM: 0, coverage: 'complete', unsurveyedM2: 0, unknownM2: 0, siteM2: 9000,
        source: 'server:hr-cadastre', parcelSource: { sourceId: 'hr-cadastre', snapshotId: null },
        computedAt: '2026-10-21T08:05:00.000Z', ...extra
    };
}

/** A consensus.design row as its SELECT returns it. */
export function designRow(content, { binding = bindingOf(['HR-335649-100', 'HR-335649-101']), city = 'zagreb', ...overrides } = {}) {
    return {
        cid: cidOfObject(content), city, goal: content.goal, title: content.title ?? null, author: content.author ?? null,
        origin_cid: content.origin?.cid ?? null, binding, content,
        screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null,
        created_at: new Date('2026-10-21T08:05:00.000Z'), ...overrides
    };
}

/** An output piece hash (AgreementRecord.outputHash form) for a readable seed. */
export const pieceHash = seed => `piece1-sha256:${createHash('sha256').update(String(seed)).digest('hex')}`;

/**
 * An owner deal over the parcels two designs take, one output per design, owners as holders.
 * @param designs design/v1 objects (linked by CID in this order)
 */
export function agreementContent(designs, overrides = {}) {
    const cids = designs.map(design => cidOfObject(design));
    return {
        schema: 'agreement/v1',
        title: 'Riverside deal',
        author: 'Studio North',
        sponsor: null,
        city: 'zagreb',
        createdAt: '2026-10-21T09:00:00.000Z',
        designs: designs.map((design, index) => ({ cid: cids[index], goal: design.goal, title: design.title })),
        inputs: {
            parcels: [
                { parcelId: 'HR-335649-100', parcelSourceId: 'oss-wfs', areaM2: 600, holders: [{ ownerKey: 'owner-a', displayName: 'Ana', share: 1 }] },
                { parcelId: 'HR-335649-101', parcelSourceId: 'oss-wfs', areaM2: 400, holders: [{ ownerKey: 'owner-b', displayName: 'Boris', share: 0.5 }, { ownerKey: 'owner-c', displayName: 'Cvita', share: 0.5 }] }
            ],
            openGroundM2: 0
        },
        outputs: cids.map((cid, index) => ({
            hash: pieceHash(`piece-${index}`), areaM2: 500, fromParcelIds: ['HR-335649-100', 'HR-335649-101'], role: 'plot', producedBy: cid
        })),
        allocations: [{ output: pieceHash('piece-0'), to: { kind: 'holders' } }],
        money: { currency: 'EUR', lines: [{ ownerKey: 'owner-a', amountCents: 150000 }, { ownerKey: 'owner-b', amountCents: -150000 }] },
        rule: { electorate: 'owners', binding: true, approvalConfig: null, lens: [] },
        deadline: '2099-01-01T00:00:00.000Z',
        ...overrides
    };
}

/** A consensus.agreement row as its SELECT returns it. */
export function agreementRow(content, overrides = {}) {
    return {
        cid: cidOfObject(content), city: 'zagreb', title: content.title ?? null, author: content.author ?? null,
        design_cids: content.designs.map(design => design.cid),
        input_parcel_ids: content.inputs.parcels.map(parcel => parcel.parcelId).sort(),
        parcel_source_id: null, deadline: content.deadline ? new Date(content.deadline) : null, status: 'active',
        content, onchain: null, screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null,
        created_at: new Date('2026-10-21T09:05:00.000Z'), ...overrides
    };
}
