// Published design/v1 and agreement/v1 objects for the publish-route tests (plan-design-agreement.md
// M2), the index rows the server stores for them, and a scripted cadastre that answers the binding
// statements a design's site runs (proposals/binding.js) as a mock pool's `bindingAnswer`.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cidOfObject } from '../../cid.js';
import { BINDING_COUNT_SQL, BINDING_SQL, FOOTPRINT_OUTSIDE_SITE_SQL, PARCEL_ACT_SITE_SQL } from '../../proposals/binding.js';

export const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
// A park inside its site, both in Zagreb.
export const PARK = box(15.97, 45.80, 15.971, 45.801);
export const SITE = box(15.969, 45.799, 15.972, 45.802);
export const SITE_MULTI = { type: 'MultiPolygon', coordinates: [SITE.coordinates] };
export const AUTHORED_AT = '2026-10-21T08:00:00.000Z';
const AgreementRecord = createRequire(import.meta.url)('../../../frontend/js/agreement-record.js');

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

const agreementPlans = new Map();
export function planContent(designs, overrides = {}) {
    return {
        schema: 'plan/v1', title: 'Riverside composition',
        designCids: [...new Set(designs.map(cidOfObject))].sort(),
        view: { at: '45.8,15.97,15', mode: '2d' }, ...overrides
    };
}
export function planForAgreement(content) { return agreementPlans.get(content.planCid); }

/**
 * An owner deal over the parcels the designs take, in its published form (AgreementRecord.published):
 * one output per design splitting the input land evenly, each output allocated to one input party in
 * turn, and the cash derived from the default area settlement. `overrides` replace whole fields of
 * the published object afterwards, as given.
 * @param designs design/v1 objects (linked by CID in this order)
 */
export function agreementContent(designs, overrides = {}) {
    const cids = designs.map(design => cidOfObject(design));
    const plan = planContent(designs);
    const planCid = cidOfObject(plan);
    const inputs = {
        parcels: [
            { parcelId: 'HR-335649-100', parcelSourceId: 'oss-wfs', areaM2: 600, holders: [{ ownerKey: 'owner-a', displayName: 'Ana', share: 1 }] },
            { parcelId: 'HR-335649-101', parcelSourceId: 'oss-wfs', areaM2: 400, holders: [{ ownerKey: 'owner-b', displayName: 'Boris', share: 0.5 }, { ownerKey: 'owner-c', displayName: 'Cvita', share: 0.5 }] }
        ],
        openGroundM2: 0
    };
    const parties = ['owner-a', 'owner-b', 'owner-c'];
    const outputs = cids.map((cid, index) => ({
        pieceId: pieceHash(`piece-${index}`), hash: pieceHash(`piece-${index}`), areaM2: 1000 / cids.length,
        fromParcelIds: ['HR-335649-100', 'HR-335649-101'], role: 'plot', producedBy: cid, holders: [], geometry: null
    }));
    const local = AgreementRecord.settle({
        schema: AgreementRecord.SCHEMA, id: 'content-fixture', title: 'Riverside deal', author: 'Studio North', sponsor: null, city: 'zagreb',
        createdAt: '2026-10-21T09:00:00.000Z', updatedAt: null,
        plan: { cid: planCid, content: plan },
        designs: cids.map((cid, index) => ({ proposalId: cid, cid, title: designs[index].title ?? null, goal: designs[index].goal ?? null })),
        inputs, outputs,
        allocations: outputs.map((output, index) => ({ output: output.hash, to: { kind: 'party', ownerKey: parties[index % parties.length] } })),
        money: { currency: 'EUR', lines: [] },
        rule: { electorate: 'owners', binding: true, approvalConfig: null, lens: [], settlement: { ...AgreementRecord.DEFAULT_SETTLEMENT } },
        deadline: '2099-01-01T00:00:00.000Z'
    });
    const content = { ...AgreementRecord.published(local, cid => cid), ...overrides };
    agreementPlans.set(content.planCid, plan);
    return content;
}

/** A consensus.agreement row as its SELECT returns it. */
export function agreementRow(content, overrides = {}) {
    const plan = planForAgreement(content);
    return {
        cid: cidOfObject(content), city: 'zagreb', title: content.title ?? null, author: content.author ?? null,
        design_cids: plan?.designCids || [],
        input_parcel_ids: content.inputs.parcels.map(parcel => parcel.parcelId).sort(),
        parcel_source_id: null, deadline: content.deadline ? new Date(content.deadline) : null, status: 'active',
        content, onchain: null, screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null,
        created_at: new Date('2026-10-21T09:05:00.000Z'), ...overrides
    };
}
