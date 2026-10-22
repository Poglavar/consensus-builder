// The published objects agents and scripts build (plan-design-agreement.md, M2 "Identity: one CID
// scheme"): a design/v1 object from a local design record and an agreement/v1 object from its parts, on
// the browser's own modules (frontend/js/design-record.js, agreement-record.js, cid.js), so an object
// built here has exactly the CID the app computes for it. Pure: no network, no clock (every time is
// passed in), no randomness.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const designRecord = require('../../frontend/js/design-record.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
const cidApi = require('../../frontend/js/cid.js');
const approval = require('../../frontend/js/proposals/approval.js');

export const DESIGN_SCHEMA = designRecord.SCHEMA;
export const AGREEMENT_SCHEMA = agreementRecord.PUBLISHED_SCHEMA;
export const OUTPUT_ROLES = agreementRecord.ROLES;
// An agreement that moves no money still states the money of its place (London GBP, Zagreb EUR;
// utils/city-money.js), so any line added later is in that currency.
export function noMoney(currency) {
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw fail('invalid-agreement', `an agreement's money needs its city's currency, got ${JSON.stringify(currency)}`);
    return { currency, lines: [] };
}
// The rights provider of a snapshot read from the lens member's devnet owner registry
// (consensus.lens_devnet_owner, lens-owner-registry.js).
export const REGISTRY_RIGHTS_PROVIDER = 'lens-devnet-owners';
// An id the local record needs and the published object never carries.
const LOCAL_ID = 'ag-published';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export const cidOfObject = object => cidApi.cidOfObject(object);
export const isCid = value => cidApi.isCid(value);
export const outputHash = geometry => agreementRecord.outputHash(geometry);

/**
 * The design/v1 object of a local design record and its CID. The record has the local design shape
 * (goal, title, description, author, city, site, toleranceM, geometry, origin, createdAt and one of
 * roadProposal | buildingProposal | structureProposal | parcelLayout); DesignRecord.published keeps
 * only what a design is. Throws (code 'invalid-design') for an object the index would refuse.
 * @returns {{ content: object, cid: string }}
 */
export function designObject(localDesign) {
    const content = designRecord.published(localDesign);
    const checked = designRecord.validate(content);
    if (!checked.valid) {
        throw fail('invalid-design', `invalid ${DESIGN_SCHEMA}: ${checked.errors.map(error => error.message).join('; ')}`, { errors: checked.errors });
    }
    return { content, cid: cidApi.cidOfObject(content) };
}

/** A parcel layout publishes only with its agreement (POST /agreements carries it). */
export const isParcelLayout = content => !!(content && content.parcelLayout);

/**
 * parcel-rights/v1 of input parcels as the lens member's devnet owner registry records them: each parcel
 * complete, its owners with equal shares (1/owner_count; the registry keeps no shares) and no area (it
 * keeps none either). The lens member compares the agreement's snapshot with the same rows before it
 * attests rights or a wallet's authority (backend/lens/approval.js), so it must be exactly this.
 * @param parcels [{ parcelId, owners: [{ owner (base58 wallet), ownerCount }] }] (lens-owner-registry.js readParcelOwners)
 */
export function registryRights(parcels) {
    return approval.normalizeRights({
        schema: approval.RIGHTS_SCHEMA,
        source: { provider: REGISTRY_RIGHTS_PROVIDER },
        parcels: (parcels || []).map(parcel => {
            const owners = Array.isArray(parcel?.owners) ? parcel.owners : [];
            if (!owners.length) throw fail('invalid-agreement', `parcel ${parcel?.parcelId} has no owner in the devnet owner registry`);
            if (owners.some(row => row.ownerCount !== owners.length)) {
                throw fail('invalid-agreement', `the devnet owner registry lists ${owners.length} owner(s) of parcel ${parcel.parcelId} but counts ${owners.map(row => row.ownerCount).join('/')}`);
            }
            return {
                parcelId: String(parcel.parcelId), complete: true, areaM2: null,
                owners: owners.map(row => ({ ownerId: row.owner, share: `1/${owners.length}` }))
            };
        })
    });
}

/**
 * The input holders (the agreement's parties) of one parcel of a rights snapshot: each owner by its owner
 * id, with its share as a number and a display name from `names` (owner id → name) when one is known.
 */
export function holdersFromRights(rights, parcelId, names = {}) {
    const parcel = (rights?.parcels || []).find(row => row.parcelId === String(parcelId));
    if (!parcel) throw fail('invalid-agreement', `the rights snapshot has no parcel ${parcelId}`);
    return parcel.owners.map(owner => {
        const [numerator, denominator] = owner.share.split('/').map(Number);
        return { ownerKey: owner.ownerId, displayName: names[owner.ownerId] || owner.ownerId, share: numerator / denominator };
    });
}

/**
 * The decision rule of a binding owners' agreement: every owner of its input parcels approves
 * (unanimous), each through a receipt the named lens member verifies; that member's AgreementDecision
 * attestation is what the agreement program records before it executes.
 */
export function ownersRule({ lens, rights }) {
    const key = String(lens || '').trim();
    if (!key) throw fail('invalid-agreement', 'a binding owners\' agreement names the lens member that decides it');
    return {
        electorate: 'owners',
        binding: true,
        approvalConfig: approval.normalizeConfig({ schema: approval.CONFIG_SCHEMA, rights, policy: { type: 'unanimous' } }),
        lens: [key]
    };
}

/** The decision rule of a community vote, a poll in the index (never minted): nobody's decision binds the owners; no owner approval rule. */
export function communityRule(lens = []) {
    const keys = [...new Set((Array.isArray(lens) ? lens : [lens]).map(key => String(key || '').trim()).filter(Boolean))];
    return { electorate: 'community', binding: false, approvalConfig: null, lens: keys };
}

/** An ISO deadline `days` after `nowMs`, on a whole second (the agreement program stores unix seconds). */
export function deadlineAfterDays(nowMs, days) {
    if (!finite(nowMs)) throw new Error('deadlineAfterDays needs the current time in ms');
    if (!finite(days) || days <= 0) throw new Error('deadline days must be a positive number');
    return new Date(Math.floor((nowMs + days * 86_400_000) / 1000) * 1000).toISOString();
}

/**
 * The parcels the designs' server bindings take (binding.parcels[].parcelId), sorted and unique.
 * @param bindings design rows' `binding` objects (or the binding of POST /designs/binding)
 */
export function boundParcelIds(bindings) {
    const ids = new Set();
    for (const binding of bindings || []) {
        for (const hit of binding?.parcels || []) {
            if (hit?.parcelId !== undefined && hit?.parcelId !== null && String(hit.parcelId).trim()) ids.add(String(hit.parcelId).trim());
        }
    }
    return [...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/**
 * Outputs of designs that form no pieces (a building on its parcel, a rule): every input parcel
 * stands as it is, role 'parcel', its hash taken over the parcel geometry as the parcel source serves it.
 * @param parcels [{ parcelId, geometry (GeoJSON Polygon | MultiPolygon or a Feature), areaM2 }]
 */
export function parcelOutputs(parcels) {
    return (parcels || []).map(parcel => {
        if (!parcel?.geometry) throw fail('invalid-agreement', `parcel ${parcel?.parcelId} has no geometry to commit its output to`);
        if (!finite(parcel.areaM2) || parcel.areaM2 < 0) throw fail('invalid-agreement', `parcel ${parcel.parcelId} needs its area`);
        const geometry = parcel.geometry.type === 'Feature' ? parcel.geometry.geometry : parcel.geometry;
        return {
            hash: agreementRecord.outputHash(geometry),
            areaM2: parcel.areaM2,
            fromParcelIds: [String(parcel.parcelId)],
            role: 'parcel',
            producedBy: null,
            geometry
        };
    });
}

/**
 * The agreement/v1 object and its CID, built through AgreementRecord.published so it is byte for byte
 * what the app publishes for the same agreement. Refuses (code 'invalid-agreement') what the
 * agreement dialog would refuse, and outputs produced by a design the agreement does not link.
 * @param {object} parts
 *   designs   [{ cid, goal, title }] in authored order
 *   parcels   [{ parcelId, parcelSourceId?, areaM2 (number | null), holders? }] the input parcels
 *   outputs   [{ hash, areaM2, fromParcelIds, role, producedBy (a linked design CID | null), geometry? }]
 *   rule      { electorate, binding, approvalConfig, lens } (ownersRule() for a binding owners' agreement, communityRule() for a poll)
 *   title, author, sponsor (base58 wallet that mints and funds it, or null), city, createdAt (ISO | null),
 *   deadline (ISO | null), openGroundM2 (default 0), allocations ([]), money (noMoney(the city's currency) when none moves)
 * @returns {{ content: object, cid: string }}
 */
export function agreementObject({
    title = null, author = null, sponsor = null, city = null, createdAt = null,
    designs, parcels, openGroundM2 = 0, outputs, allocations = [], money, rule, deadline = null
} = {}) {
    if (!Array.isArray(designs) || !designs.length) throw fail('invalid-agreement', 'an agreement links at least one design');
    const designCids = new Set();
    for (const design of designs) {
        if (!cidApi.isCid(design?.cid)) throw fail('invalid-agreement', `every design is linked by its CID, got ${JSON.stringify(design?.cid)}`);
        designCids.add(design.cid);
    }
    for (const output of outputs || []) {
        if (output?.producedBy != null && !designCids.has(output.producedBy)) {
            throw fail('invalid-agreement', `output ${output.hash} is produced by ${output.producedBy}, a design the agreement does not link`);
        }
    }
    const record = {
        schema: agreementRecord.SCHEMA,
        id: LOCAL_ID,
        title,
        city,
        createdAt,
        updatedAt: null,
        author,
        sponsor,
        // The local record names a design by a local id; here the CID is that id.
        designs: designs.map(design => ({ proposalId: design.cid, title: design.title ?? null, goal: design.goal ?? null, cid: design.cid })),
        inputs: {
            parcels: (parcels || []).map(parcel => ({
                parcelId: parcel.parcelId,
                areaM2: finite(parcel.areaM2) ? parcel.areaM2 : null,
                holders: Array.isArray(parcel.holders) ? parcel.holders : [],
                ...(parcel.parcelSourceId ? { parcelSourceId: parcel.parcelSourceId } : {})
            })),
            openGroundM2
        },
        outputs: (outputs || []).map(output => ({
            hash: output.hash,
            pieceId: output.hash,
            areaM2: output.areaM2,
            fromParcelIds: output.fromParcelIds,
            producedBy: output.producedBy ?? null,
            role: output.role,
            holders: [],
            geometry: output.geometry ?? null
        })),
        allocations,
        money,
        rule,
        deadline
    };
    let checked;
    try {
        checked = agreementRecord.validate(record);
    } catch (error) {
        throw fail('invalid-agreement', error.message);
    }
    if (!checked.valid) {
        throw fail('invalid-agreement', `invalid ${AGREEMENT_SCHEMA}: ${checked.errors.map(error => `${error.section}: ${error.message}`).join('; ')}`, { errors: checked.errors });
    }
    const content = agreementRecord.published(record, cid => cid);
    return { content, cid: cidApi.cidOfObject(content) };
}
