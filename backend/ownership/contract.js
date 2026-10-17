// The one parcel-ownership contract every ownership adapter answers in, and the validator that
// enforces it (docs/ownership-adapters.md). This is display data only, never a trusted ownership claim.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Same classifier the map uses, loaded from the frontend copy so the two cannot drift.
const { classifyOwnershipLabel } = require('../../frontend/js/parcels/ownership-type.js');

export const OWNERSHIP_CONTRACT = 'parcel-ownership/1';
export const OWNER_TYPES = Object.freeze(['private individual', 'company', 'government', 'institution']);

// What an adapter (or a linked HTTP endpoint) returns for one parcel. The registry adds the rest.
const ADAPTER_KEYS = ['parcelId', 'owners', 'observedAt', 'retrievedAt'];
const OWNER_KEYS = ['name', 'shareText', 'sharePercent', 'ownerType'];
const RECORD_KEYS = ['contract', 'sourceId', 'parcelId', 'owners', 'ownershipType', 'observedAt', 'retrievedAt', 'attribution', 'licence'];
// ISO 8601: a year, a month, a day, or a full timestamp with a zone. A source that only states its
// assessment roll year says "2024", not a made-up 2024-01-01.
const ISO_INSTANT = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?)?)?$/;

export class OwnershipContractError extends Error {
    constructor(problems, sourceId) {
        super(`Ownership response for ${sourceId || 'an unknown source'} breaks ${OWNERSHIP_CONTRACT}: ${problems.join('; ')}`);
        this.name = 'OwnershipContractError';
        this.code = 'ownership-contract-violation';
        this.problems = problems;
    }
}

function isIsoInstantOrNull(value) {
    return value === null || (typeof value === 'string' && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value.length === 4 ? `${value}-01-01` : value)));
}

function unknownKeys(object, allowed) {
    return Object.keys(object).filter(key => !allowed.includes(key));
}

// Problems with one adapter answer; [] when it fits. `owners: []` means the source knows the
// parcel and publishes no owner for it.
export function adapterAnswerProblems(answer, expectedParcelId) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return ['the answer is not a JSON object'];
    const problems = unknownKeys(answer, ADAPTER_KEYS).map(key => `unknown field "${key}"`);
    if (answer.parcelId !== expectedParcelId) problems.push(`parcelId must be "${expectedParcelId}"`);
    if (!('observedAt' in answer)) problems.push('observedAt is required (the source\'s own time, or null when it states none)');
    else if (!isIsoInstantOrNull(answer.observedAt)) problems.push('observedAt must be an ISO 8601 date/time or null');
    if ('retrievedAt' in answer && !isIsoInstantOrNull(answer.retrievedAt)) problems.push('retrievedAt must be an ISO 8601 date/time or null');
    if (!Array.isArray(answer.owners)) return [...problems, 'owners must be an array'];
    answer.owners.forEach((owner, index) => {
        const at = `owners[${index}]`;
        if (!owner || typeof owner !== 'object' || Array.isArray(owner)) { problems.push(`${at} is not an object`); return; }
        unknownKeys(owner, OWNER_KEYS).forEach(key => problems.push(`${at} has unknown field "${key}"`));
        if (typeof owner.name !== 'string' || !owner.name.trim()) problems.push(`${at}.name must be a non-empty string`);
        if (owner.shareText !== undefined && owner.shareText !== null && typeof owner.shareText !== 'string') problems.push(`${at}.shareText must be a string or null`);
        if (owner.sharePercent !== undefined && owner.sharePercent !== null
            && !(typeof owner.sharePercent === 'number' && Number.isFinite(owner.sharePercent) && owner.sharePercent >= 0 && owner.sharePercent <= 100)) {
            problems.push(`${at}.sharePercent must be a number from 0 to 100 or null`);
        }
        if (owner.ownerType !== undefined && owner.ownerType !== null && !OWNER_TYPES.includes(owner.ownerType)) {
            problems.push(`${at}.ownerType must be one of ${OWNER_TYPES.join(', ')}`);
        }
    });
    return problems;
}

export function ownershipTypeOf(owners) {
    const types = [...new Set(owners.map(owner => owner.ownerType))];
    if (!types.length) return null;
    return types.length === 1 ? types[0] : 'mixed';
}

// Validates an adapter answer and wraps it in the full contract record the route returns.
// Throws OwnershipContractError on any mismatch: a wrong shape is never passed on to the UI.
export function buildOwnershipRecord(answer, { sourceId, parcelId, attribution, licence = null }) {
    const problems = adapterAnswerProblems(answer, parcelId);
    if (problems.length) throw new OwnershipContractError(problems, sourceId);
    const owners = answer.owners.map(owner => ({
        name: owner.name.trim(),
        shareText: typeof owner.shareText === 'string' && owner.shareText.trim() ? owner.shareText.trim() : null,
        sharePercent: typeof owner.sharePercent === 'number' ? Number(owner.sharePercent.toFixed(4)) : null,
        ownerType: owner.ownerType || classifyOwnershipLabel(owner.name)
    }));
    return {
        contract: OWNERSHIP_CONTRACT,
        sourceId,
        parcelId,
        owners,
        ownershipType: ownershipTypeOf(owners),
        observedAt: answer.observedAt,
        retrievedAt: answer.retrievedAt ?? null,
        attribution,
        licence
    };
}

// Problems with a full record (what the route sends); used by tests and by anyone checking a link.
export function ownershipRecordProblems(record) {
    if (!record || typeof record !== 'object') return ['the record is not an object'];
    const problems = unknownKeys(record, RECORD_KEYS).map(key => `unknown field "${key}"`);
    if (record.contract !== OWNERSHIP_CONTRACT) problems.push(`contract must be "${OWNERSHIP_CONTRACT}"`);
    if (typeof record.sourceId !== 'string' || !record.sourceId) problems.push('sourceId must be a string');
    if (typeof record.attribution !== 'string' || !record.attribution) problems.push('attribution must be a string');
    const { contract, sourceId, ownershipType, attribution, licence, ...answer } = record;
    return [...problems, ...adapterAnswerProblems(answer, record.parcelId)];
}

// "1/2", "50%", "0.5" -> percent; null when the text states no share.
export function sharePercentFromText(text) {
    const value = typeof text === 'string' ? text.trim().replace(',', '.') : '';
    if (!value) return null;
    const percent = value.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (percent) return Number(percent[1]);
    const fraction = value.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (fraction && Number(fraction[2]) > 0) return (Number(fraction[1]) / Number(fraction[2])) * 100;
    return null;
}

export function isoOrNull(value) {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
