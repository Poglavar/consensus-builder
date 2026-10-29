// Published design/v1 and agreement/v1 objects for the publish-route tests (plan-design-agreement.md
// M2), the index rows the server stores for them, and a scripted cadastre that answers the HR
// candidate statements a design's site runs (parcels/oss-binding-source.js) as a mock pool's
// `bindingAnswer`: real geometry, so the server's binding (site-binding.js) decides as it does live.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cidOfObject } from '../../cid.js';
import { HR_PARCEL_IDS_SQL, HR_SITE_CANDIDATES_SQL } from '../../parcels/oss-binding-source.js';
import { MAX_SOURCE_BINDING_PARCELS } from '../../parcels/source-binding.js';

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

/** A parcel layout of SITE in two plots. */
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

// The cadastre under SITE: its west and east halves (bound), and a northern neighbour whose edge lies
// 4e-9° (0.4 mm, under the 1 mm noise) inside the site, so SITE only touches it.
export const SPILL = [
    { parcelId: 'HR-335649-100', bound: true, geometry: box(15.969, 45.799, 15.9705, 45.802) },
    { parcelId: 'HR-335649-101', bound: true, geometry: box(15.9705, 45.799, 15.972, 45.802) },
    { parcelId: 'HR-335649-102', bound: false, geometry: box(15.969, 45.801999996, 15.972, 45.803) }
];
// The same cadastre with a 0.0002° strip along the site's east edge left unsurveyed.
export const SPILL_WITH_GAP = [SPILL[0], { ...SPILL[1], geometry: box(15.9705, 45.799, 15.9718, 45.802) }, SPILL[2]];
// The cadastral municipality around SITE.
export const REGION = box(15.96, 45.79, 15.98, 45.81);

/**
 * The HR candidate statements answered as a cadastre holding `parcels` in `regions` under any
 * site (null for every other statement, which then goes to the mock pool's answers and queue).
 * `regions: []` = the site is outside every cadastral municipality; `truncated` = over the cap.
 * Every declared id exists (its SPILL geometry, else the site's west half).
 */
export function scriptedCadastre({ parcels = SPILL, regions = [REGION], truncated = false } = {}) {
    return (sql, params) => {
        if (sql === HR_SITE_CANDIDATES_SQL) {
            const found = truncated
                ? Array.from({ length: MAX_SOURCE_BINDING_PARCELS + 1 }, (_, i) => ({ id: `HR-1-${i}`, geometry: null }))
                : parcels.map(parcel => ({ id: parcel.parcelId, geometry: parcel.geometry }));
            return { rows: [{ parcels: found, regions: regions.map((geometry, i) => ({ id: String(i + 1), geometry })) }] };
        }
        if (sql === HR_PARCEL_IDS_SQL) {
            const ids = JSON.parse(params[0]).map(entry => entry.id);
            return { rows: ids.map(id => ({ id, geometry: parcels.find(parcel => parcel.parcelId === id)?.geometry || SPILL[0].geometry })) };
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
 * one output per design splitting the input land evenly, each output allocated in turn to one input
 * parcel's abstract owners' party, and the cash derived from the default area settlement. `overrides` replace whole fields of
 * the published object afterwards, as given.
 * @param designs design/v1 objects (linked by CID in this order)
 */
export function agreementContent(designs, overrides = {}) {
    const cids = designs.map(design => cidOfObject(design));
    const plan = planContent(designs);
    const planCid = cidOfObject(plan);
    const inputs = {
        parcels: [
            { parcelId: 'HR-335649-100', parcelSourceId: 'oss-wfs', areaM2: 600 },
            { parcelId: 'HR-335649-101', parcelSourceId: 'oss-wfs', areaM2: 400 }
        ],
        openGroundM2: 0
    };
    const parties = inputs.parcels.map(parcel => AgreementRecord.partyKey(parcel.parcelId));
    const outputs = cids.map((cid, index) => ({
        pieceId: pieceHash(`piece-${index}`), hash: pieceHash(`piece-${index}`), areaM2: 1000 / cids.length,
        fromParcelIds: ['HR-335649-100', 'HR-335649-101'], role: 'plot', producedBy: cid, geometry: null
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
