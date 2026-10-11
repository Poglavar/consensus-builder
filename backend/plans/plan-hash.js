// Content identity of named plans (plans.md): what each member proposal builds is hashed when the plan
// is named, so a member repaired in place later is detectable instead of silently changing a plan
// people bet on. Pure: rows in, hex digests out.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const reparcellizationDeal = require('../../frontend/js/reparcellization-deal.js');

function approvalContextFor(proposal) {
    if (!proposal || typeof proposal !== 'object') return null;
    const hasConfig = Object.prototype.hasOwnProperty.call(proposal, 'approvalConfig')
        && proposal.approvalConfig !== undefined;
    const hasLensEntries = Array.isArray(proposal.lens) && proposal.lens.length > 0;
    if (!hasConfig && !hasLensEntries) return null;
    const approval = require('../../frontend/js/proposals/approval.js');
    const contextSource = Array.isArray(proposal.lens)
        ? { ...proposal, lens: proposal.lens.filter(entry => !(entry && typeof entry === 'object'
            && !entry.address && !entry.key && entry.name)) }
        : proposal;
    if (!hasConfig && !approval.lensKeys(contextSource).length) return null;
    return approval.contextContent(contextSource);
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

// JSON with object keys sorted at every depth, so equal content always hashes equal.
export function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * What a proposal builds — the part of a row a plan commits to. Descriptions, thumbnails, lifecycle
 * state and chain pointers are left out on purpose: they may change without changing the plan.
 * The stored `site` is left out too: it is derived by PostGIS from the geometry below, and two
 * PostGIS versions return the same union with different vertex order (measured 2026-10-10, prod
 * PG16 vs local PG17), which would make one plan hash differently in two databases.
 * @param row { type, goal, cadastre_parcel_ids, road_proposal, building_proposal,
 *              structure_proposal, reparcellization, geometry }
 */
export function memberContent(row) {
    if (reparcellizationDeal.isReadjustment(row)) {
        return reparcellizationDeal.fingerprint(readjustmentProposal(row));
    }
    const proposalData = row.proposal_data && typeof row.proposal_data === 'object' ? row.proposal_data : {};
    const content = {
        type: row.type ?? null,
        goal: row.goal ?? null,
        parcels: Array.isArray(row.cadastre_parcel_ids) ? [...row.cadastre_parcel_ids].map(String).sort() : [],
        road: row.road_proposal?.definition
            ? { segments: row.road_proposal.definition.segments ?? row.road_proposal.definition.points ?? null,
                segmentIds: row.road_proposal.definition.segmentIds ?? null,
                segmentProfiles: row.road_proposal.definition.segmentProfiles ?? null,
                width: row.road_proposal.definition.width ?? null,
                kind: row.road_proposal.definition.kind ?? null }
            : null,
        building: row.building_proposal?.parameters ?? null,
        structure: row.structure_proposal
            ? { kind: row.structure_proposal.kind ?? null, geometry: row.structure_proposal.geometry ?? null }
            : null,
        layout: Array.isArray(row.reparcellization?.polygons)
            ? row.reparcellization.polygons.map(polygon => ({ key: polygon.ownerKey ?? null, geometry: polygon.geometry }))
            : null,
        geometry: row.geometry ?? null
    };
    const context = approvalContextFor({
        ...proposalData,
        approvalConfig: row.approval_config ?? proposalData.approvalConfig,
        lens: row.lens ?? proposalData.lens,
        cadastreParcelIds: row.cadastre_parcel_ids ?? proposalData.cadastreParcelIds
    });
    if (context) content.approvalContext = context;
    return content;
}

export function memberHash(row) {
    const content = memberContent(row);
    // LR content is already committed by the shared versioned canonical fingerprint. Keep this
    // branch out of the legacy projection so old non-LR member hashes remain byte-identical.
    return typeof content === 'string' ? content : sha256(stableStringify(content));
}

const choose = (value, fallback) => value === undefined || value === null ? fallback : value;
const isoDate = value => value === undefined || value === null ? value
    : (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const optionalNumber = value => value === undefined || value === null ? value : Number(value);

// The query provides the same authoritative columns used by serializeProposalRow, plus the raw
// JSONB record for fields without dedicated columns (currency alias and agreement included).
function readjustmentProposal(row) {
    const data = row.proposal_data && typeof row.proposal_data === 'object' ? row.proposal_data : {};
    const numericOffer = choose(row.offer, data.offer);
    return {
        ...data,
        goal: choose(row.goal, choose(data.goal, row.type)),
        reparcellization: choose(row.reparcellization, data.reparcellization),
        cadastreParcelIds: choose(row.cadastre_parcel_ids, data.cadastreParcelIds),
        offer: numericOffer === undefined || numericOffer === null ? numericOffer : Number(numericOffer),
        offerCurrency: choose(row.offer_currency, data.offerCurrency),
        isConditional: choose(row.is_conditional, data.isConditional),
        expiresAt: isoDate(choose(row.expires_at, data.expiresAt)),
        depositEnabled: choose(row.deposit_enabled, data.depositEnabled),
        depositPercent: optionalNumber(choose(row.deposit_percent, data.depositPercent)),
        decayEnabled: choose(row.decay_enabled, data.decayEnabled),
        decayPercent: optionalNumber(choose(row.decay_percent, data.decayPercent)),
        decayDurationMs: optionalNumber(choose(row.decay_duration_ms, data.decayDurationMs)),
        disbursementMode: choose(row.disbursement_mode, data.disbursementMode)
    };
}

// The plan's own identity: its members, in order, each with what it builds. `proposalId` is the
// member's stable proposal_id (not its row id), so a plan replicated to another database hashes equal.
export function planHash(entries) {
    return sha256(stableStringify(entries.map(entry => [String(entry.proposalId), entry.hash])));
}

// The next free version name for a revision: harbor → harbor-v2, harbor-v2 → harbor-v3, skipping
// names already taken. `taken` is a Set of slugs.
export function nextVersionSlug(slug, taken) {
    const match = /^(.*?)-v(\d+)$/.exec(slug);
    const base = match ? match[1] : slug;
    let version = match ? Number(match[2]) + 1 : 2;
    while (taken.has(`${base}-v${version}`)) version += 1;
    return `${base}-v${version}`;
}

// Members whose current content no longer matches what the plan was named with.
export function changedMembers(memberHashes, currentRows) {
    const byId = new Map(currentRows.map(row => [String(row.id), row]));
    return Object.entries(memberHashes || {})
        .filter(([id, hash]) => {
            const row = byId.get(String(id));
            if (!row) return true;
            try {
                return memberHash(row) !== hash;
            } catch (error) {
                // An invalid current LR deal has drifted from every valid named commitment.
                // Other failures (for example a broken SHA implementation) must still surface.
                if (error?.code === 'invalid-readjustment-deal') return true;
                throw error;
            }
        })
        .map(([id]) => id);
}
