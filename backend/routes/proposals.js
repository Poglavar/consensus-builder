// Proposals API endpoints
// POST /proposals - Store a proposal and get back an id (+ a one-time edit token)
// GET /proposals/:id - Get a proposal by row id (numeric) or proposal_id, row id first

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createJsonBodyValidator, validators } from '../utils/request-validation.js';
import { defaultThumbnailQueue } from '../thumbnails/thumbnail-queue.js';
import { publicApiBaseUrl } from '../utils/public-base-url.js';
import { imageFileExists } from '../utils/image-store.js';
import { canonicalizeLifecycleStatus, resolveIncomingLifecycleStatus } from '../proposals/lifecycle.js';
import {
    findLegacyCadastreDeclaration,
    findNonCadastralParentDeclaration,
    isDerivedParcelDeclaration,
    serializeProposalRow,
    stripLocalProposalState
} from '../proposals/serializer.js';
import { isInvalidRecordError } from '../proposals/serializer.js';
import { recomputeCorridorStats } from './road-corridor.js';
import { validateReparcellizationShares } from './reparcellization.js';

const MAX_PROPOSAL_ID_LENGTH = 255;
const MAX_CITY_LENGTH = 100;
const MAX_TITLE_LENGTH = 500;
const MAX_AUTHOR_LENGTH = 255;
const MAX_TYPE_LENGTH = 50;
const MAX_STATUS_LENGTH = 50;
const MAX_CURRENCY_LENGTH = 10;
const MAX_DISBURSEMENT_MODE_LENGTH = 50;
const MAX_MONEY = 999999999999; // NUMERIC(20, 8) holds 12 integer digits

// List endpoints return whole rows; an uncapped ?limit= is a one-request table dump. The summary cap
// stays above the largest city's proposal count because the share dialog asks for count+50 in one
// call and falls back to per-proposal checks when the list comes back short.
export const MAX_SUMMARY_LIMIT = 1000;
export const MAX_PARCEL_PROPOSALS_LIMIT = 200;

// ---------------------------------------------------------------------------------------------
// Edit tokens. A proposal's mutable labels (name, thumbnail, epoch) may only be changed by whoever
// uploaded it. POST /proposals hands back a random token once and stores only its sha256; every
// PATCH must present the token in this header. Rows created before tokens existed have a NULL hash
// and are therefore immutable through the API.
// ---------------------------------------------------------------------------------------------
export const EDIT_TOKEN_HEADER = 'X-Proposal-Edit-Token';

// First key of the two-key advisory lock on a proposal_id (second key: hashtext(proposal_id)). A
// fixed namespace keeps these locks from colliding with any other advisory-lock user of the database.
// Shared with routes/agent-proposals.js, which takes the exclusive side.
export const PROPOSAL_ID_LOCK_NAMESPACE = 480402;

export function hashEditToken(token) {
    return createHash('sha256').update(String(token)).digest('hex');
}

function newEditToken() {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashEditToken(token) };
}

export function editTokenMatches(token, storedHash) {
    if (typeof token !== 'string' || !token || token.length > 256) return false;
    if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
    const presented = Buffer.from(hashEditToken(token), 'hex');
    const stored = Buffer.from(storedHash, 'hex');
    return presented.length === stored.length && timingSafeEqual(presented, stored);
}

function readEditToken(req) {
    const raw = req.get(EDIT_TOKEN_HEADER);
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

// ---------------------------------------------------------------------------------------------
// Single-row addressing. The frontend's share links, list labels ("#51") and plan ids are the
// database ROW id; proposal_id is the uploader's own identifier (a content fingerprint such as
// "c2-…" from the browser, an operation id from agents). Legacy rows exist whose proposal_id is a
// bare number equal to ANOTHER row's id (prod: row 45 has proposal_id "51"), so "proposal_id = $1
// OR id::text = $1" can match two rows and the database picked one arbitrarily. The row id wins;
// proposal_id is the fallback. New numeric proposal_ids are refused at create, so the two
// namespaces cannot collide again.
// ---------------------------------------------------------------------------------------------
function oneProposalByIdClause(placeholder) {
    return `WHERE (proposal_id = ${placeholder} OR id::text = ${placeholder})
                ORDER BY (id::text = ${placeholder}) DESC
                LIMIT 1`;
}

function isReservedNumericProposalId(value) {
    return typeof value === 'string' && /^\d+$/.test(value);
}

// The frontend sends short city codes (frontend/js/city-config.js CITY_QUERY_MAP) but proposals are
// stored under the full city id. Every code the frontend can produce must map, or that city's
// proposals become invisible: `?city=ny` used to fall through unmapped and never match `new_york`.
const CITY_CODE_TO_ID = {
    zg: 'zagreb',
    zgb: 'zagreb',
    st: 'split',
    si: 'sibenik',
    bg: 'belgrade',
    ba: 'buenos_aires',
    caba: 'buenos_aires',
    'ar-ba': 'buenos_aires',
    lj: 'ljubljana',
    co: 'colorado',
    ny: 'new_york'
};

export function normalizeCityCode(code) {
    const raw = (code || '').toString().trim().toLowerCase();
    if (!raw) return null;
    // Already a full city id (or an unknown value) — pass it through unchanged.
    return CITY_CODE_TO_ID[raw] || raw;
}

// The stored thumbnail URL has to be absolute. In production the API sits behind a proxy on a fixed
// origin (PUBLIC_API_BASE_URL); otherwise the served path alone, never the request's origin.
function resolveThumbnailBaseUrl() {
    // Never the request's Host: unset means the row keeps the served path and the client resolves
    // it against the backend it is talking to (see utils/public-base-url.js).
    return publicApiBaseUrl();
}

// ---------------------------------------------------------------------------------------------
// Thumbnails a client may set. screenshot_url (and onchain_data.imageUrl, which the lists fall back
// to) is rendered as an <img> in every visitor's proposal list, so a free upload must not be able to
// point it anywhere it likes (a tracking pixel, someone else's content, a URL that later changes).
// Accepted: an IMAGE this API itself stored — /uploads/images/<file> or /images/<file> (the same
// directory, see index.js), as a bare path or under the pinned PUBLIC_API_BASE_URL origin — and only
// when that file actually exists. /metadata/ and the rest of /uploads/ (JSON, models) are not
// thumbnails. Anything else is dropped and the server renders its own (thumbnails/thumbnail-queue.js).
// ---------------------------------------------------------------------------------------------
const OWN_STORE_IMAGE_PATH = /^\/(?:uploads\/images|images)\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/;

export function isOwnStoreImageUrl(value, { fileExists = imageFileExists } = {}) {
    if (typeof value !== 'string') return false;
    const raw = value.trim();
    if (!raw) return false;
    let pathname;
    if (raw.startsWith('/')) {
        if (raw.startsWith('//')) return false; // protocol-relative: another host
        pathname = raw;
    } else {
        const base = publicApiBaseUrl();
        if (!base) return false;
        let url;
        let baseUrl;
        try {
            url = new URL(raw);
            baseUrl = new URL(base);
        } catch {
            return false;
        }
        if (url.origin !== baseUrl.origin || url.username || url.password || url.search || url.hash) return false;
        const prefix = baseUrl.pathname.replace(/\/+$/, '');
        if (prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
        pathname = url.pathname.slice(prefix.length);
    }
    const match = OWN_STORE_IMAGE_PATH.exec(pathname);
    return Boolean(match && fileExists(match[1]));
}

// ---------------------------------------------------------------------------------------------
// Authors. There is no login: an author is a free-text display name ("Guest 3780", a chosen
// username — what the frontend sends, see user-management.js getCurrentUsername). Two kinds of
// author string are also IDENTITIES that other parts of the app treat as verified: a wallet address
// (the paid agent route binds author to the settled payer; supporter agents and the actor explorer
// key on it) and a server agent persona (backend/agents/personas.json, by name or wallet). The free
// route cannot prove either, so it does not store them: such an author becomes NULL (row and
// proposal_data) and the drop is logged with the other unprovable claims. Ordinary display names
// pass untouched. A client-supplied onchain.owner is no proof either — the free route never checks
// the chain — so it grants no exception. Only POST /agent/proposals, where x402 settlement proves the
// wallet, stores a wallet as author.
// ---------------------------------------------------------------------------------------------
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function loadPersonaIdentities() {
    try {
        const doc = JSON.parse(readFileSync(new URL('../agents/personas.json', import.meta.url), 'utf8'));
        const personas = Array.isArray(doc?.personas) ? doc.personas : [];
        return new Set(personas
            .flatMap(persona => [persona?.name, persona?.id, persona?.wallet])
            .filter(value => typeof value === 'string' && value.trim())
            .map(value => value.trim().toLowerCase()));
    } catch (err) {
        console.warn(`[proposals] could not read agents/personas.json (${err.message}); persona authors are not reserved`);
        return new Set();
    }
}
const PERSONA_IDENTITIES = loadPersonaIdentities();

export function isReservedAuthorIdentity(author) {
    if (typeof author !== 'string') return false;
    const value = author.trim();
    if (!value) return false;
    return EVM_ADDRESS.test(value)
        || BASE58_ADDRESS.test(value)
        || PERSONA_IDENTITIES.has(value.toLowerCase());
}

function validateIdentifierField(fieldLabel) {
    return validators.custom((value) => {
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                return validators.fail(`${fieldLabel} must be a string or number.`);
            }
            return validators.ok(String(value));
        }

        if (typeof value !== 'string') {
            return validators.fail(`${fieldLabel} must be a string or number.`);
        }

        const normalized = value.trim();
        if (!normalized) {
            return validators.fail(`${fieldLabel} must not be empty.`);
        }
        if (normalized.length > MAX_PROPOSAL_ID_LENGTH) {
            return validators.fail(`${fieldLabel} must be at most ${MAX_PROPOSAL_ID_LENGTH} characters.`);
        }
        if (/\p{C}/u.test(normalized)) {
            return validators.fail(`${fieldLabel} contains invalid control characters.`);
        }

        return validators.ok(normalized);
    });
}

function stringArrayValidator(fieldLabel) {
    return validators.arrayOf(
        validators.string({
            label: fieldLabel,
            minLength: 1,
            disallowControlChars: true,
            minLengthMessage: `${fieldLabel} must not contain empty values.`,
            controlCharsMessage: `${fieldLabel} contains invalid control characters.`
        }),
        { label: fieldLabel }
    );
}

// Ownership flow entries: [{ parcelId, cededM2, destination }] — the publish-time stamp of what a
// formation takes from each base parcel and where the ownership goes (rethink-proposals.md §9).
const OWNERSHIP_FLOW_DESTINATIONS = new Set(['public', 'proposer', 'mapping', 'undecided']);
function ownershipFlowValidator(value) {
    if (!Array.isArray(value)) return { ok: false, error: 'ownershipFlow must be an array.' };
    if (value.length > 2000) return { ok: false, error: 'ownershipFlow has too many entries.' };
    const normalized = [];
    for (let i = 0; i < value.length; i++) {
        const entry = value[i];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, error: `ownershipFlow[${i}] must be an object.` };
        }
        const parcelId = typeof entry.parcelId === 'string' ? entry.parcelId.trim() : '';
        if (!parcelId || /\p{C}/u.test(parcelId)) {
            return { ok: false, error: `ownershipFlow[${i}].parcelId must be a non-empty string.` };
        }
        const cededM2 = Number(entry.cededM2);
        if (!Number.isFinite(cededM2) || cededM2 < 0) {
            return { ok: false, error: `ownershipFlow[${i}].cededM2 must be a non-negative number.` };
        }
        const destination = typeof entry.destination === 'string' ? entry.destination.trim() : '';
        if (!OWNERSHIP_FLOW_DESTINATIONS.has(destination)) {
            return { ok: false, error: `ownershipFlow[${i}].destination must be one of: ${[...OWNERSHIP_FLOW_DESTINATIONS].join(', ')}.` };
        }
        normalized.push({ parcelId, cededM2: Math.round(cededM2), destination });
    }
    return { ok: true, value: normalized };
}

// The frontend stores bounds as either an `[minX, minY, maxX, maxY]` array (legacy / direct
// lat-lng) or a `{north, south, east, west, ...}` object (current `calculateProposalBounds`).
// The DB column is JSONB so we accept and pass through either shape after a sanity check.
function boundsValidator(value) {
    if (value === null || value === undefined) return { ok: true, value: null };

    if (Array.isArray(value)) {
        if (value.length !== 4) return { ok: false, error: 'bounds array must have 4 numbers.' };
        for (let i = 0; i < 4; i++) {
            if (!Number.isFinite(value[i])) return { ok: false, error: `bounds[${i}] must be a finite number.` };
        }
        return { ok: true, value };
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const numericKeys = ['north', 'south', 'east', 'west', 'minX', 'minY', 'maxX', 'maxY', 'minLng', 'minLat', 'maxLng', 'maxLat'];
        for (const key of numericKeys) {
            if (key in value && !Number.isFinite(Number(value[key]))) {
                return { ok: false, error: `bounds.${key} must be a finite number.` };
            }
        }
        return { ok: true, value };
    }

    return { ok: false, error: 'bounds must be an array or an object.' };
}

// The frontend stores lens as `[{address, name}, ...]`, but older callers and on-chain reads
// produce plain string arrays. Accept both shapes; preserve the input value as-is for JSONB storage.
function lensArrayValidator(value) {
    if (value === null || value === undefined) return { ok: true, value: null };
    if (!Array.isArray(value)) return { ok: false, error: 'lens must be an array.' };
    for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === 'string') {
            if (!item.trim()) {
                return { ok: false, error: 'lens must not contain empty values.' };
            }
            continue;
        }
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            const address = typeof item.address === 'string' ? item.address.trim() : '';
            const name = typeof item.name === 'string' ? item.name.trim() : '';
            if (!address && !name) {
                return { ok: false, error: `lens entry at index ${i} must have an address or name.` };
            }
            continue;
        }
        return { ok: false, error: `lens entry at index ${i} must be a string or an object with an address.` };
    }
    return { ok: true, value };
}

export const proposalCreateBodyValidator = createJsonBodyValidator({
    allowUnknownFields: true,
    schema: {
        proposalId: { required: false, validate: validateIdentifierField('proposalId') },
        id: { required: false, validate: validateIdentifierField('id') },
        proposal_id: { required: false, validate: validateIdentifierField('proposal_id') },
        city: { required: false, validate: validators.string({ maxLength: MAX_CITY_LENGTH, label: 'city', disallowControlChars: true }) },
        name: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_TITLE_LENGTH, label: 'name', disallowControlChars: true })) },
        title: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_TITLE_LENGTH, label: 'title', disallowControlChars: true })) },
        description: { required: false, validate: validators.optional(validators.string({ label: 'description', disallowControlChars: true })) },
        author: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_AUTHOR_LENGTH, label: 'author', disallowControlChars: true })) },
        type: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_TYPE_LENGTH, label: 'type', disallowControlChars: true })) },
        status: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_STATUS_LENGTH, label: 'status', disallowControlChars: true })) },
        lifecycleStatus: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_STATUS_LENGTH, label: 'lifecycleStatus', disallowControlChars: true })) },
        // Bounds match the columns (NUMERIC(20,8), INTEGER): an out-of-range value must be a 400 here,
        // not a DB error after a paid submission has already settled.
        offer: { required: false, validate: validators.optional(validators.finiteNumber({ label: 'offer', min: -MAX_MONEY, max: MAX_MONEY })) },
        offerCurrency: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_CURRENCY_LENGTH, label: 'offerCurrency', disallowControlChars: true })) },
        offer_currency: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_CURRENCY_LENGTH, label: 'offer_currency', disallowControlChars: true })) },
        budget: { required: false, validate: validators.optional(validators.finiteNumber({ label: 'budget', min: -MAX_MONEY, max: MAX_MONEY })) },
        budgetCurrency: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_CURRENCY_LENGTH, label: 'budgetCurrency', disallowControlChars: true })) },
        budget_currency: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_CURRENCY_LENGTH, label: 'budget_currency', disallowControlChars: true })) },
        createdAt: { required: false, validate: validators.optional(validators.date({ label: 'createdAt' })) },
        expiresAt: { required: false, validate: validators.optional(validators.date({ label: 'expiresAt' })) },
        decayEnabled: { required: false, validate: validators.optional(validators.boolean({ label: 'decayEnabled' }), { nullValue: false }) },
        decayPercent: { required: false, validate: validators.optional(validators.finiteNumber({ label: 'decayPercent', integer: true, min: 0, max: 1000 })) },
        decayDurationMs: { required: false, validate: validators.optional(validators.finiteNumber({ label: 'decayDurationMs', integer: true, min: 0, max: Number.MAX_SAFE_INTEGER })) },
        depositEnabled: { required: false, validate: validators.optional(validators.boolean({ label: 'depositEnabled' }), { nullValue: false }) },
        depositPercent: { required: false, validate: validators.optional(validators.finiteNumber({ label: 'depositPercent', integer: true, min: 0, max: 1000 })) },
        isConditional: { required: false, validate: validators.optional(validators.boolean({ label: 'isConditional' }), { nullValue: false }) },
        disbursementMode: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_DISBURSEMENT_MODE_LENGTH, label: 'disbursementMode', disallowControlChars: true })) },
        // The proposal's one and only durable land declaration.
        cadastreParcelIds: { required: false, validate: validators.optional(stringArrayValidator('cadastreParcelIds'), { nullValue: [] }) },
        // Per crossed base parcel: ceded area + ownership destination, stamped at publish (§9/§12).
        ownershipFlow: { required: false, validate: validators.optional(ownershipFlowValidator, { nullValue: [] }) },
        // Which cadastre frame the stamps were measured against ({ capturedAt }) — D5/§11.
        cadastreFrame: { required: false, validate: validators.optional(validators.plainObject({ label: 'cadastreFrame' })) },
        // Hash of the published EFFECT (footprint + per-parcel cession); acceptances bind to it.
        effectHash: { required: false, validate: validators.optional(validators.string({ maxLength: 64, label: 'effectHash', disallowControlChars: true })) },
        acceptedParcelIds: { required: false, validate: validators.optional(stringArrayValidator('acceptedParcelIds'), { nullValue: [] }) },
        ownerAcceptances: { required: false, validate: validators.optional(validators.plainObject({ label: 'ownerAcceptances' }), { nullValue: {} }) },
        roadProposal: { required: false, validate: validators.optional(validators.plainObject({ label: 'roadProposal' })) },
        buildingProposal: { required: false, validate: validators.optional(validators.plainObject({ label: 'buildingProposal' })) },
        structureProposal: { required: false, validate: validators.optional(validators.plainObject({ label: 'structureProposal' })) },
        reparcellization: { required: false, validate: validators.optional(validators.plainObject({ label: 'reparcellization' })) },
        lens: { required: false, validate: lensArrayValidator },
        bounds: { required: false, validate: boundsValidator },
        onchain: { required: false, validate: validators.optional(validators.plainObject({ label: 'onchain' })) },
        onchainData: { required: false, validate: validators.optional(validators.plainObject({ label: 'onchainData' })) },
        screenshotUrl: { required: false, validate: validators.optional(validators.string({ maxLength: 2000, label: 'screenshotUrl', disallowControlChars: true })) },
        screenshot_url: { required: false, validate: validators.optional(validators.string({ maxLength: 2000, label: 'screenshot_url', disallowControlChars: true })) },
        // Epoch bucket for the plan timeline (presentation metadata; see proposals-ddl.sql).
        epochYear: { required: false, validate: validators.optional(validators.finiteNumber({ integer: true, min: 2026, max: 2966, label: 'epochYear' })) }
    }
});

// A shared plan can carry hundreds of proposal ids. Fetching each record through
// GET /proposals/:id turns one plan open into hundreds of HTTP requests, even though Postgres can
// answer the same set in one query. Keep this endpoint additive: an older backend simply makes the
// frontend fall back to the individual route.
const proposalBatchBodyValidator = createJsonBodyValidator({
    schema: {
        ids: {
            required: true,
            validate: validators.arrayOf(validateIdentifierField('ids'), {
                label: 'ids',
                minItems: 1,
                maxItems: 1000
            })
        }
    }
});

// PATCH /proposals/:id/epoch — epochYear: 2026–2966 postavlja bucket, null ga briše.
const proposalEpochPatchValidator = createJsonBodyValidator({
    schema: {
        epochYear: {
            required: true,
            missingMessage: 'epochYear is required (integer year or null to clear).',
            validate: (value, fieldName) => value === null
                ? { ok: true, value: null }
                : validators.finiteNumber({ integer: true, min: 2026, max: 2966, label: 'epochYear' })(value, fieldName)
        }
    }
});

// PATCH /proposals/:id/name — rename a proposal in place. Nothing else on the record moves: a name
// is a label, and re-uploading a whole proposal to change one would rewrite geometry and stamps that
// have already been consented to.
const proposalNamePatchValidator = createJsonBodyValidator({
    schema: {
        name: {
            required: true,
            missingMessage: 'name is required.',
            validate: validators.string({
                maxLength: MAX_TITLE_LENGTH,
                label: 'name',
                disallowControlChars: true,
                minLength: 1,
                minLengthMessage: 'name is required.'
            })
        }
    }
});

const proposalScreenshotPatchValidator = createJsonBodyValidator({
    schema: {
        screenshotUrl: {
            required: true,
            missingMessage: 'screenshotUrl is required.',
            validate: validators.string({ maxLength: 2000, label: 'screenshotUrl', disallowControlChars: true, minLength: 1, minLengthMessage: 'screenshotUrl is required.' })
        }
    }
});

// The create handler is shared by the free POST /proposals and the paid POST /agent/proposals
// (routes/agent-proposals.js): one persistence path, two front doors. It closes over nothing but
// the pool, so a caller that has already bound the author (the x402 payer) gets identical behaviour.
// Everything a create request can be refused for without touching the database, as one pure
// function. The free route runs it inside the handler; the paid route ALSO runs it as middleware in
// front of the x402 gate, so a body the handler would 400 is refused before any USDC settles —
// otherwise the payer is charged and no row is written (and a retry cannot recover the payment).
// Returns { ok: true, value } or { ok: false, status, error }.
export function precheckProposalCreate(req) {
    const fail = error => ({ ok: false, status: 400, error });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !req.validatedBody) {
        return fail('Proposal body must be a JSON object.');
    }
    const legacyDeclaration = findLegacyCadastreDeclaration(body);
    if (legacyDeclaration) {
        return fail(`${legacyDeclaration.path} is retired. Send the proposal's land once in cadastreParcelIds.`);
    }
    const nonCadastralParent = findNonCadastralParentDeclaration(body);
    if (nonCadastralParent) {
        return fail(`${nonCadastralParent.path} names land outside cadastreParcelIds: ${nonCadastralParent.id}.`);
    }
    // The server enforces the flat transport contract even if an older client sends
    // cached children, formation data, demolition scans or proposal ancestry.
    const validated = stripLocalProposalState(req.validatedBody);

    const explicitProposalId = validated.proposalId ?? validated.id ?? validated.proposal_id ?? null;
    if (isReservedNumericProposalId(explicitProposalId)) {
        return fail('proposalId must not be purely numeric: numeric ids are the server\'s row ids.');
    }
    const type = validated.type ?? null;
    if (!type) return fail('type is required.');

    const lifecycleResult = resolveIncomingLifecycleStatus(validated);
    if (!lifecycleResult.ok) return fail(lifecycleResult.error);

    const cadastreParcelIds = validated.cadastreParcelIds ?? [];
    if (!cadastreParcelIds.length) {
        return fail('cadastreParcelIds must contain the proposal\'s cadastral land.');
    }
    const rawCadastreParcelIds = body.cadastreParcelIds;
    if (!Array.isArray(rawCadastreParcelIds)
        || rawCadastreParcelIds.some((id, index) => id !== cadastreParcelIds[index])) {
        return fail('cadastreParcelIds must contain exact, unpadded strings.');
    }
    if (new Set(cadastreParcelIds).size !== cadastreParcelIds.length) {
        return fail('cadastreParcelIds must not contain duplicates.');
    }
    const generatedAnchor = cadastreParcelIds.find(isDerivedParcelDeclaration);
    if (generatedAnchor) {
        return fail(`cadastreParcelIds must contain original cadastral ids; found generated parcel ${generatedAnchor}.`);
    }
    const ownershipFlow = validated.ownershipFlow ?? [];
    const cadastreSet = new Set(cadastreParcelIds.map(String));
    const flowOutsideScope = ownershipFlow.find(entry => !cadastreSet.has(String(entry.parcelId)));
    if (flowOutsideScope) {
        return fail(`ownershipFlow parcel ${flowOutsideScope.parcelId} is outside cadastreParcelIds.`);
    }
    return {
        ok: true,
        value: {
            validated,
            proposalId: explicitProposalId,
            type,
            lifecycleStatus: lifecycleResult.value,
            cadastreParcelIds,
            ownershipFlow
        }
    };
}

export function proposalCreatePrecheck(req, res, next) {
    const result = precheckProposalCreate(req);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return next();
}

// Claims a free upload cannot prove, removed before storage (the record is otherwise stored as
// sent). `agent` is the paid-agent stamp — only the x402 route may write it. Owner acceptances and
// an Executed lifecycle assert that OTHER people consented / land changed hands; the browser's
// values are a local simulation, and on-chain proposals get their real lifecycle from the oracle
// (oracle/proposal-lifecycle.js), which keys on onchain.proposalId. Returns what was dropped.
//
// Also dropped on the free route: an author that is a wallet address or agent persona (see
// isReservedAuthorIdentity) and any client thumbnail that is not an image in our own store (see
// isOwnStoreImageUrl) — screenshotUrl/screenshot_url and onchain(Data).imageUrl alike, since the
// lists and the serializer fall back from one to the other. The paid route gets the same
// thumbnail rule (a payment buys a row, not the right to hotlink into everyone's list).
function dropUnprovableClaims(proposal, { paid }) {
    const dropped = [];
    if (!paid && proposal.agent !== undefined) {
        delete proposal.agent;
        dropped.push('agent');
    }
    if (!paid && isReservedAuthorIdentity(proposal.author)) {
        delete proposal.author;
        dropped.push('author');
    }
    for (const key of ['screenshotUrl', 'screenshot_url']) {
        if (proposal[key] !== undefined && proposal[key] !== null && !isOwnStoreImageUrl(proposal[key])) {
            delete proposal[key];
            dropped.push(key);
        }
    }
    for (const key of ['onchain', 'onchainData']) {
        const onchain = proposal[key];
        if (onchain && typeof onchain === 'object' && onchain.imageUrl !== undefined && onchain.imageUrl !== null
            && !isOwnStoreImageUrl(onchain.imageUrl)) {
            delete onchain.imageUrl;
            dropped.push(`${key}.imageUrl`);
        }
    }
    if (Array.isArray(proposal.acceptedParcelIds) && proposal.acceptedParcelIds.length) dropped.push('acceptedParcelIds');
    if (proposal.ownerAcceptances && typeof proposal.ownerAcceptances === 'object'
        && Object.keys(proposal.ownerAcceptances).length) dropped.push('ownerAcceptances');
    delete proposal.acceptedParcelIds;
    delete proposal.ownerAcceptances;
    return dropped;
}

export function createProposalCreateHandler(pool) {
    return async (req, res) => {
        try {
            const precheck = precheckProposalCreate(req);
            if (!precheck.ok) return res.status(precheck.status).json({ error: precheck.error });
            const { validated, type, cadastreParcelIds, ownershipFlow } = precheck.value;
            const proposal = stripLocalProposalState(req.body);
            const paid = Boolean(req.x402Payment);
            const droppedClaims = dropUnprovableClaims(proposal, { paid });

            const city = normalizeCityCode(validated.city) || null;
            // Random suffix: two id-less uploads in the same millisecond must not collide.
            const proposalId = precheck.value.proposalId ?? `local-${Date.now()}-${randomBytes(4).toString('hex')}`;
            const name = validated.name ?? null;
            const title = validated.title ?? validated.name ?? null;
            const description = validated.description ?? null;
            // Read from the sanitized copy: dropUnprovableClaims has removed a reserved author.
            const author = typeof proposal.author === 'string' ? proposal.author : null;
            let lifecycleStatus = precheck.value.lifecycleStatus;
            if (lifecycleStatus === 'Executed') {
                lifecycleStatus = 'Active';
                delete proposal.executedAt;
                droppedClaims.push('lifecycleStatus:Executed');
            }
            const offer = validated.offer ?? null;
            const offerCurrency = validated.offerCurrency ?? validated.offer_currency ?? null;
            const budget = validated.budget ?? null;
            const budgetCurrency = validated.budgetCurrency ?? validated.budget_currency ?? null;
            // The server's clock is the record's creation time: a client value let any upload
            // backdate itself in lists, "created" dates and the created-desc sort.
            //
            // The browser's own time is still needed, and is kept as authoredAt: plan replay orders
            // formations by when they were AUTHORED (plan-order.js reads authoredAt before
            // createdAt), a plan is usually uploaded long after and in list order, and an edited
            // road deliberately inherits its source's time to keep its replay slot (road-drawing.js).
            // It is the author's claim about their own record, never later than receipt.
            const createdAt = new Date();
            const claimedAuthoredAt = [req.body.authoredAt, validated.createdAt]
                .map(value => (value === undefined || value === null || value === '' ? null : new Date(value)))
                .find(value => value && Number.isFinite(value.getTime())) || null;
            const authoredAt = claimedAuthoredAt && claimedAuthoredAt.getTime() <= createdAt.getTime()
                ? claimedAuthoredAt.toISOString()
                : null;
            const expiresAt = validated.expiresAt ?? null;
            const decayEnabled = validated.decayEnabled ?? false;
            const decayPercent = validated.decayPercent ?? null;
            const decayDurationMs = validated.decayDurationMs ?? null;
            const depositEnabled = validated.depositEnabled ?? false;
            const depositPercent = validated.depositPercent ?? null;
            const isConditional = validated.isConditional ?? false;
            const disbursementMode = validated.disbursementMode ?? null;

            const cadastreFrame = validated.cadastreFrame ?? null;

            const roadProposal = validated.roadProposal ?? null;
            const buildingProposal = validated.buildingProposal ?? null;
            const structureProposal = validated.structureProposal ?? null;
            let reparcellization = validated.reparcellization ?? null;

            const lens = validated.lens ?? null;
            const bounds = validated.bounds ?? null;
            // Sanitized copies (dropUnprovableClaims): a foreign thumbnail is already gone from these.
            const onchainData = proposal.onchain ?? proposal.onchainData ?? null;
            const clientScreenshot = proposal.screenshotUrl ?? proposal.screenshot_url ?? null;
            const screenshotUrl = typeof clientScreenshot === 'string' ? clientScreenshot.trim() : null;
            const epochYear = validated.epochYear ?? null;
            const agentPaymentId = req.x402Payment?.id ?? null;
            const agentRequestHash = req.x402Payment?.requestHash ?? null;

            // Corridor acquisition stats were scraped from the client's DOM and trusted. Recompute
            // them from PostGIS and overwrite the client copy (best-effort + Zagreb-only inside;
            // returns null on any failure, so a bad recompute never blocks proposal creation).
            if (roadProposal) {
                const serverStats = await recomputeCorridorStats(pool, proposal);
                if (serverStats) {
                    proposal.ownershipAndAcquisitionStats = serverStats;
                    if (roadProposal.definition && typeof roadProposal.definition === 'object') {
                        roadProposal.definition.metadata = roadProposal.definition.metadata || {};
                        roadProposal.definition.metadata.ownershipAndAcquisitionStats = serverStats;
                    }
                }
            }

            // Reparcellization land shares are recomputed from the stored child geometry (percents
            // must match the polygons, sum to ~100). The geometry-truth overwrites the client numbers
            // and validated:false flags a mismatch. Soft: a bad plan is still stored, just marked.
            if (reparcellization) {
                const validatedReparcellization = validateReparcellizationShares(reparcellization);
                if (validatedReparcellization) {
                    reparcellization = validatedReparcellization;
                    proposal.reparcellization = validatedReparcellization;
                }
            }

            const proposalData = stripLocalProposalState({
                ...proposal,
                lifecycleStatus,
                reparcellization,
                createdAt: createdAt.toISOString(),
                ...(authoredAt ? { authoredAt } : {})
            });
            if (!authoredAt) delete proposalData.authoredAt;
            if (droppedClaims.length) {
                console.warn(`[POST proposals ${proposalId}] dropped unprovable client claims: ${droppedClaims.join(', ')}`);
            }
            const editToken = newEditToken();
            const storedRoadProposal = proposalData.roadProposal ?? null;
            const storedBuildingProposal = proposalData.buildingProposal ?? null;
            const storedStructureProposal = proposalData.structureProposal ?? null;
            const storedReparcellization = proposalData.reparcellization ?? null;

            // INSERT … SELECT … WHERE lock: the row is written only if no PAID request is between
            // its proposal_id check and its insert for the same id. The paid route holds an
            // exclusive session advisory lock on that id from before settlement until its response
            // (agent-proposals.js reserveProposalId) and runs this statement on that same session,
            // where its own lock never conflicts. Any other writer's shared try-lock fails, the
            // statement inserts nothing, and it answers 409 — so a free upload (or a second paid
            // request) can never take an id a payer has already been charged for.
            const sql = `
                INSERT INTO proposal (
                    proposal_id, city, name, title, description, author, type,
                    lifecycle_status,
                    offer, offer_currency, budget, budget_currency,
                    created_at, expires_at,
                    decay_enabled, decay_percent, decay_duration_ms,
                    deposit_enabled, deposit_percent,
                    is_conditional, disbursement_mode,
                    cadastre_parcel_ids, accepted_parcel_ids, owner_acceptances,
                    road_proposal, building_proposal, structure_proposal, reparcellization,
                    lens, bounds, onchain_data, screenshot_url, proposal_data,
                    ownership_flow, cadastre_frame, epoch_year,
                    agent_payment_id, agent_request_hash, edit_token_hash
                )
                SELECT
                    $1, $2, $3, $4, $5, $6, $7,
                    $8,
                    $9, $10, $11, $12,
                    $13, $14,
                    $15, $16, $17,
                    $18, $19,
                    $20, $21,
                    $22, $23, $24,
                    $25, $26, $27, $28,
                    $29, $30, $31, $32, $33,
                    $34, $35, $36,
                    $37, $38, $39
                WHERE pg_try_advisory_xact_lock_shared(${PROPOSAL_ID_LOCK_NAMESPACE}, hashtext($1::varchar))
                RETURNING id, proposal_id, created_at
            `;

            const params = [
                proposalId, city, name, title, description, author, type,
                lifecycleStatus,
                offer, offerCurrency, budget, budgetCurrency,
                createdAt, expiresAt,
                decayEnabled, decayPercent, decayDurationMs,
                depositEnabled, depositPercent,
                isConditional, disbursementMode,
                cadastreParcelIds.length ? JSON.stringify(cadastreParcelIds) : null,
                null, // accepted_parcel_ids: consent is never taken from the uploader (dropUnprovableClaims)
                null, // owner_acceptances: likewise
                storedRoadProposal ? JSON.stringify(storedRoadProposal) : null,
                storedBuildingProposal ? JSON.stringify(storedBuildingProposal) : null,
                storedStructureProposal ? JSON.stringify(storedStructureProposal) : null,
                storedReparcellization ? JSON.stringify(storedReparcellization) : null,
                lens ? JSON.stringify(lens) : null,
                bounds ? JSON.stringify(bounds) : null,
                onchainData ? JSON.stringify(onchainData) : null,
                screenshotUrl,
                JSON.stringify(proposalData),
                ownershipFlow.length ? JSON.stringify(ownershipFlow) : null,
                cadastreFrame ? JSON.stringify(cadastreFrame) : null,
                epochYear,
                agentPaymentId,
                agentRequestHash,
                editToken.hash
            ];

            // The paid route passes the session that holds the proposal_id lock.
            const db = req.proposalWriteClient ?? pool;
            const result = await db.query(sql, params);
            const inserted = result.rows[0];
            if (!inserted) {
                console.warn(`[POST proposals ${proposalId}] refused: a paid submission for this proposal_id is in flight`);
                return res.status(409).json({
                    error: 'Proposal with this ID is being created by another request',
                    proposalId
                });
            }
            const dbId = inserted.id;

            const updateSql = `
                UPDATE proposal
                SET proposal_data = jsonb_set(
                        proposal_data,
                        '{proposalId}',
                        to_jsonb(proposal_id)
                    ) || jsonb_set(
                        proposal_data,
                        '{proposal_id}',
                        to_jsonb(proposal_id)
                    ) || jsonb_set(
                        proposal_data,
                        '{id}',
                        to_jsonb(id::text)
                    )
                WHERE id = $1
            `;
            await db.query(updateSql, [dbId]);

            // Thumbnails are rendered on the server, so that every uploaded proposal has one — the
            // old client-side capture only ran for whoever happened to have the proposal open in the
            // right city with tiles loaded, which is why almost nothing had a thumbnail.
            //
            // The render is QUEUED, not awaited: the response goes out now and screenshot_url is
            // filled in when the picture is ready (lists re-read it). It never fails the upload; a
            // render that fails, is shed by a full queue or dies with the process leaves
            // screenshot_url NULL for scripts/backfill-proposal-thumbnails.mjs. A client screenshot
            // that survived dropUnprovableClaims is already one of our own images: nothing to render.
            if (!screenshotUrl) {
                defaultThumbnailQueue().enqueue({
                    pool,
                    proposal: proposalData,
                    city,
                    proposalId: dbId,
                    baseUrl: resolveThumbnailBaseUrl()
                });
            }

            res.status(201).json({
                id: dbId,
                proposalId: inserted.proposal_id,
                createdAt: inserted.created_at,
                // null while the server thumbnail renders; GET /proposals/:id serves it once ready.
                screenshotUrl: screenshotUrl || null,
                // Returned exactly once; only its hash is stored. Send it back in the
                // X-Proposal-Edit-Token header to rename, re-thumbnail or re-bucket this proposal.
                editToken: editToken.token
            });
        } catch (err) {
            console.error('Error in POST /proposals:', err);

            if (err.code === '23505') {
                const requestBody = req.validatedBody || req.body || {};
                let conflictingProposalId = requestBody.proposalId ?? requestBody.id ?? requestBody.proposal_id;

                if (!conflictingProposalId && err.detail) {
                    const match = err.detail.match(/\(proposal_id\)=\(([^)]+)\)/);
                    if (match && match[1]) conflictingProposalId = match[1];
                }

                if (conflictingProposalId) {
                    try {
                        const existingSql = `
                            SELECT id, proposal_id
                            FROM proposal
                            WHERE proposal_id = $1
                            LIMIT 1
                        `;
                        const existingResult = await pool.query(existingSql, [conflictingProposalId]);
                        if (existingResult.rows.length > 0) {
                            return res.status(409).json({
                                error: 'Proposal with this ID already exists',
                                id: existingResult.rows[0].id,
                                proposalId: existingResult.rows[0].proposal_id
                            });
                        }
                    } catch (lookupErr) {
                        console.error('Error looking up existing proposal:', lookupErr);
                    }
                }

                return res.status(409).json({ error: 'Proposal with this ID already exists' });
            }

            res.status(500).json({ error: 'Internal server error' });
        }
    };
}

export function setupProposalsRoute(app, pool) {
    // The marketplace/on-chain LIFECYCLE status, past-expiry-aware. A proposal past expires_at reads
    // as 'Expired' even if the stored value is stale. This one expression is used both for the
    // returned lifecycleStatus and for the ?lifecycle= FILTER, so filtering and display agree
    // (case-insensitive — the DB may carry both 'Executed' and 'executed').
    const EFFECTIVE_STATUS_SQL = `
        CASE
            WHEN LOWER(COALESCE(lifecycle_status, '')) NOT IN ('executed', 'cancelled', 'expired')
                AND expires_at IS NOT NULL AND expires_at <= now()
            THEN 'Expired'
            WHEN LOWER(COALESCE(lifecycle_status, '')) = 'executed' THEN 'Executed'
            WHEN LOWER(COALESCE(lifecycle_status, '')) = 'cancelled' THEN 'Cancelled'
            WHEN LOWER(COALESCE(lifecycle_status, '')) = 'expired' THEN 'Expired'
            WHEN LOWER(COALESCE(lifecycle_status, '')) = 'draft' THEN 'draft'
            ELSE 'Active'
        END`;

    // The complete public proposal representation. The single and batch endpoints deliberately
    // share this list and serializeProposalRow so a plan does not receive a thinner record than a
    // direct proposal link.
    const FULL_PROPOSAL_COLUMNS = `
        id, proposal_id, city, name, title, description, author, type,
        lifecycle_status, ${EFFECTIVE_STATUS_SQL} AS effective_status,
        offer, offer_currency, budget, budget_currency,
        created_at, expires_at, updated_at,
        decay_enabled, decay_percent, decay_duration_ms,
        deposit_enabled, deposit_percent,
        is_conditional, disbursement_mode,
        cadastre_parcel_ids, ownership_flow, cadastre_frame,
        accepted_parcel_ids, owner_acceptances,
        road_proposal, building_proposal, structure_proposal, reparcellization,
        lens, bounds, onchain_data, screenshot_url, epoch_year, agent_payment_id, proposal_data`;

    // ORDER BY only over columns the summary actually carries. Computed sorts the client offers
    // (area, parcel count, acceptance ratio) need per-row geometry/JSONB work the list endpoint
    // does not do, so they stay client-side; these are the DB-derivable ones.
    const SORT_ORDER_BY = {
        'created-desc': 'created_at DESC',
        'created-asc': 'created_at ASC',
        'author-asc': "COALESCE(author, proposal_data->>'author', '') ASC",
        'author-desc': "COALESCE(author, proposal_data->>'author', '') DESC",
        'value-desc': "NULLIF(proposal_data->>'offer', '')::numeric DESC NULLS LAST",
        'value-asc': "NULLIF(proposal_data->>'offer', '')::numeric ASC NULLS LAST"
    };

    const parseFilters = (req) => {
        const city = normalizeCityCode(req.query.city);
        // The lifecycle-phase filter (Active/Executed/Cancelled/Expired). Named `?lifecycle=`.
        const lifecycleRaw = typeof req.query.lifecycle === 'string' && req.query.lifecycle.trim()
            ? req.query.lifecycle.trim()
            : null;
        const lifecycle = lifecycleRaw ? canonicalizeLifecycleStatus(lifecycleRaw) : null;
        const type = req.query.type;
        const author = req.query.author;
        const goal = typeof req.query.goal === 'string' && req.query.goal.trim() ? req.query.goal.trim() : null;
        const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
        const sort = Object.prototype.hasOwnProperty.call(SORT_ORDER_BY, req.query.sort) ? req.query.sort : null;
        const limit = parseInt(req.query.limit, 10);
        const offset = parseInt(req.query.offset, 10);

        return {
            city,
            lifecycle,
            lifecycleError: lifecycleRaw && !lifecycle
                ? 'lifecycle must be one of: Active, Executed, Cancelled, Expired, draft.'
                : null,
            type,
            author,
            goal,
            q,
            sort,
            limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_SUMMARY_LIMIT) : 100,
            offset: Number.isFinite(offset) && offset >= 0 ? offset : 0
        };
    };

    const buildFilterQuery = ({
        city,
        lifecycle,
        type,
        author,
        goal,
        q,
        sort,
        baseSelect,
        includePagination = true,
        limit,
        offset
    }) => {
        let sql = baseSelect || '';
        const params = [];
        const clauses = [];

        if (city) {
            clauses.push(`city = $${params.length + 1}`);
            params.push(city);
        }

        if (lifecycle) {
            // Filter on the EFFECTIVE lifecycle so ?lifecycle=Active excludes expired-but-stale rows
            // and ?lifecycle=Expired finds them — matching what the summary returns.
            clauses.push(`LOWER(${EFFECTIVE_STATUS_SQL}) = LOWER($${params.length + 1})`);
            params.push(lifecycle);
        }

        if (type) {
            clauses.push(`type = $${params.length + 1}`);
            params.push(type);
        }

        if (author) {
            clauses.push(`author = $${params.length + 1}`);
            params.push(author);
        }

        if (goal) {
            clauses.push(`COALESCE(proposal_data->>'goal', type) = $${params.length + 1}`);
            params.push(goal);
        }

        if (q) {
            // Free-text over the display name/title and author — the same fields the client search
            // box matches, but across ALL rows instead of only the fetched page.
            const p = params.length + 1;
            clauses.push(
                `(COALESCE(name, title, proposal_data->>'name', proposal_data->>'title', '') ILIKE $${p}`
                + ` OR COALESCE(author, proposal_data->>'author', '') ILIKE $${p})`
            );
            params.push(`%${q}%`);
        }

        if (clauses.length) {
            sql += `\n            WHERE ${clauses.join(' AND ')}`;
        }

        if (includePagination) {
            const orderBy = SORT_ORDER_BY[sort] || SORT_ORDER_BY['created-desc'];
            sql += `\n            ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            params.push(limit, offset);
        }

        return { sql, params };
    };

    app.post('/proposals', proposalCreateBodyValidator, createProposalCreateHandler(pool));

    app.get('/proposals/count', async (req, res) => {
        try {
            const filters = parseFilters(req);
            if (filters.lifecycleError) return res.status(400).json({ error: filters.lifecycleError });
            const { sql, params } = buildFilterQuery({
                ...filters,
                baseSelect: '\n            SELECT COUNT(*) AS count FROM proposal',
                includePagination: false
            });

            const result = await pool.query(sql, params);
            const count = result.rows.length > 0 ? parseInt(result.rows[0].count, 10) : 0;

            res.json({
                count,
                city: filters.city || null,
                lifecycle: filters.lifecycle || null,
                type: filters.type || null,
                author: filters.author || null
            });
        } catch (err) {
            console.error('Error in GET /proposals/count:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Per-parcel proposal counts for the map badges. The client passes the parcel ids it can see
    // (?parcel_ids=a,b,c) and gets { counts: { a: 2, c: 1 } } back from flat cadastral declarations.
    // Ids with no proposals are simply absent (treat as 0).
    app.get('/proposals/counts', async (req, res) => {
        try {
            const raw = typeof req.query.parcel_ids === 'string' ? req.query.parcel_ids : '';
            const parcelIds = Array.from(new Set(
                raw.split(',').map(s => s.trim()).filter(Boolean)
            )).slice(0, 5000); // cap the array so a huge querystring can't blow up the query
            if (!parcelIds.length) {
                return res.status(400).json({ error: 'parcel_ids query parameter is required' });
            }
            const city = normalizeCityCode(req.query.city);

            const params = [parcelIds];
            const cityClause = city ? `AND p.city = $${params.push(city)}` : '';

            // The canonical root declaration is the only proposal-to-land relationship.
            const sql = `
                SELECT ids.pid AS parcel_id, COUNT(DISTINCT p.id)::int AS n
                FROM proposal p
                CROSS JOIN LATERAL (
                    SELECT DISTINCT e AS pid
                    FROM jsonb_array_elements_text(
                        COALESCE(p.cadastre_parcel_ids, '[]'::jsonb)
                    ) AS e
                ) ids
                WHERE p.cadastre_parcel_ids ?| $1::text[]
                  AND ids.pid = ANY($1::text[])
                  ${cityClause}
                GROUP BY ids.pid
            `;

            const result = await pool.query(sql, params);
            const counts = {};
            result.rows.forEach(row => { counts[row.parcel_id] = row.n; });
            res.json({ counts });
        } catch (err) {
            console.error('Error in GET /proposals/counts:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/proposals/summary', async (req, res) => {
        try {
            const filters = parseFilters(req);
            if (filters.lifecycleError) return res.status(400).json({ error: filters.lifecycleError });

            const { sql, params } = buildFilterQuery({
                ...filters,
                baseSelect: `
            SELECT
                id,
                proposal_id,
                city,
                COALESCE(name, title, proposal_data->>'name', proposal_data->>'title') AS display_name,
                COALESCE(title, name, proposal_data->>'title', proposal_data->>'name') AS display_title,
                COALESCE(author, proposal_data->>'author') AS author,
                COALESCE(type, proposal_data->>'type') AS type,
                -- The goal is the specific proposal kind (building / structure / reparcellization /
                -- road / ...); type is the lossy backend column. Serving goal here stops the client
                -- re-deriving it from type and mis-badging building/structure/parcel rows.
                COALESCE(proposal_data->>'goal', type) AS goal,
                ${EFFECTIVE_STATUS_SQL} AS effective_status,
                created_at,
                -- Base ancestry rides along so the claims/dossier surfaces can answer "does this
                -- server proposal touch my parcel" without fetching every proposal in full.
                cadastre_parcel_ids,
                COALESCE(screenshot_url, onchain_data->>'imageUrl') AS screenshot_url,
                onchain_data,
                -- Paid-ness is a fact about the row (a settled x402 payment), not about what the body
                -- said: an agent stamp on a row without a payment id is never served.
                CASE WHEN agent_payment_id IS NOT NULL THEN proposal_data->'agent' END AS agent,
                epoch_year,
                COUNT(*) OVER() AS total_count
            FROM proposal`,
                includePagination: true
            });

            const result = await pool.query(sql, params);
            const invalid = [];
            const proposals = result.rows.map(row => {
                let proposal;
                try {
                    proposal = serializeProposalRow({
                        ...row,
                        name: row.display_name || row.display_title || null,
                        title: row.display_title || row.display_name || null
                    });
                } catch (err) {
                    if (!isInvalidRecordError(err)) throw err;
                    invalid.push({ id: row.id, proposalId: row.proposal_id, error: err.message, detail: err.detail });
                    return null;
                }
                return {
                    id: proposal.id,
                    proposalId: proposal.proposalId,
                    city: proposal.city || null,
                    name: proposal.name || null,
                    title: proposal.title || null,
                    author: proposal.author || null,
                    type: proposal.type || null,
                    goal: row.goal || null,
                    lifecycleStatus: proposal.lifecycleStatus,
                    createdAt: proposal.createdAt || null,
                    cadastreParcelIds: Array.isArray(row.cadastre_parcel_ids) ? row.cadastre_parcel_ids : null,
                    parcelSet: proposal.parcelSet,
                    screenshotUrl: proposal.screenshotUrl || null,
                    onchain: row.onchain_data && typeof row.onchain_data === 'object' && !Array.isArray(row.onchain_data)
                        ? row.onchain_data
                        : null,
                    agent: row.agent && typeof row.agent === 'object' && !Array.isArray(row.agent)
                        ? row.agent
                        : null,
                    epochYear: proposal.epochYear ?? null
                };
            }).filter(Boolean);
            if (invalid.length) console.warn(`GET /proposals/summary: skipped ${invalid.length} non-canonical record(s)`, invalid.map(entry => `${entry.id}: ${entry.detail || entry.error}`));

            const totalCount = result.rows.length > 0 && result.rows[0].total_count !== undefined
                ? parseInt(result.rows[0].total_count, 10)
                : proposals.length;

            res.json({
                proposals,
                count: totalCount,
                limit: filters.limit,
                offset: filters.offset,
                ...(invalid.length ? { invalid } : {})
            });
        } catch (err) {
            console.error('Error in GET /proposals/summary:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.head('/proposals/:id', async (req, res) => {
        try {
            const idParam = req.params.id;
            if (!idParam) return res.status(400).end();

            const sql = `
                SELECT id, proposal_id, updated_at, created_at
                FROM proposal
                ${oneProposalByIdClause('$1')}
            `;

            const result = await pool.query(sql, [idParam]);
            if (result.rows.length === 0) return res.status(404).end();

            const row = result.rows[0];
            const lastModified = row.updated_at || row.created_at;
            if (lastModified) {
                res.setHeader('Last-Modified', new Date(lastModified).toUTCString());
                const weakEtag = `W/"proposal-${row.proposal_id}-${new Date(lastModified).getTime()}"`;
                res.setHeader('ETag', weakEtag);
            }
            res.setHeader('X-Proposal-Id', row.id);
            res.setHeader('X-Proposal-ProposalId', row.proposal_id);

            return res.status(200).end();
        } catch (err) {
            console.error('Error in HEAD /proposals/:id:', err);
            return res.status(500).end();
        }
    });

    // Plan po epohama: bucketi s prijedlozima, poredani po godini pa po
    // created_at (redoslijed primjene UNUTAR godine i dalje diktira
    // plan-order.js — ovo je izvještajni artefakt za report i hr-reljef,
    // ne mehanizam ovisnosti).
    app.get('/proposals/epoch-plan', async (req, res) => {
        try {
            const city = normalizeCityCode(req.query.city);
            const params = [];
            const clauses = ['epoch_year IS NOT NULL'];
            if (city) {
                params.push(city);
                clauses.push(`city = $${params.length}`);
            }
            const sql = `
                SELECT id, proposal_id, city,
                       COALESCE(name, title, proposal_data->>'name', proposal_data->>'title') AS display_name,
                       COALESCE(type, proposal_data->>'type') AS type,
                       COALESCE(proposal_data->>'goal', type) AS goal,
                       epoch_year, bounds, created_at,
                       COALESCE(screenshot_url, onchain_data->>'imageUrl') AS screenshot_url
                FROM proposal
                WHERE ${clauses.join(' AND ')}
                ORDER BY epoch_year, created_at
            `;
            const result = await pool.query(sql, params);

            const epochs = [];
            const byYear = new Map();
            for (const row of result.rows) {
                const year = Number(row.epoch_year);
                if (!byYear.has(year)) {
                    byYear.set(year, { year, proposals: [] });
                    epochs.push(byYear.get(year));
                }
                byYear.get(year).proposals.push({
                    id: row.id,
                    proposalId: row.proposal_id,
                    city: row.city,
                    name: row.display_name,
                    type: row.type,
                    goal: row.goal,
                    epochYear: year,
                    bounds: row.bounds,
                    createdAt: row.created_at,
                    screenshotUrl: row.screenshot_url
                });
            }

            res.json({ city: city || null, epochs, count: result.rows.length });
        } catch (err) {
            console.error('Error in GET /proposals/epoch-plan:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.post('/proposals/batch', proposalBatchBodyValidator, async (req, res) => {
        try {
            const ids = Array.from(new Set(req.validatedBody.ids.map(String)));
            const result = await pool.query(`
                SELECT ${FULL_PROPOSAL_COLUMNS}
                FROM proposal
                WHERE proposal_id = ANY($1::text[]) OR id::text = ANY($1::text[])
            `, [ids]);

            // The row id wins if a requested numeric string also equals another row's proposal_id —
            // plans and share links carry row ids. Same precedence as the single-row endpoints
            // (oneProposalByIdClause), made deterministic for a set response.
            const byProposalId = new Map();
            const byDatabaseId = new Map();
            for (const row of result.rows) {
                if (row.proposal_id !== undefined && row.proposal_id !== null) {
                    byProposalId.set(String(row.proposal_id), row);
                }
                if (row.id !== undefined && row.id !== null) byDatabaseId.set(String(row.id), row);
            }
            const items = ids.map(id => {
                const row = byDatabaseId.get(id) || byProposalId.get(id) || null;
                if (!row) return { id, proposal: null };
                try {
                    return { id, proposal: serializeProposalRow(row) };
                } catch (err) {
                    if (!isInvalidRecordError(err)) throw err;
                    console.warn(`POST /proposals/batch: ${id}: ${err.detail || err.message}`);
                    return { id, proposal: null, error: err.message, code: err.code, detail: err.detail };
                }
            });
            res.json({ items, count: items.filter(item => item.proposal).length });
        } catch (err) {
            console.error('Error in POST /proposals/batch:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/proposals/:id', async (req, res) => {
        try {
            const idParam = req.params.id;
            if (!idParam) {
                return res.status(400).json({ error: 'Invalid proposal id. Must be provided.' });
            }

            const sql = `
                SELECT ${FULL_PROPOSAL_COLUMNS}
                FROM proposal
                ${oneProposalByIdClause('$1')}
            `;

            const result = await pool.query(sql, [idParam]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }

            res.json(serializeProposalRow(result.rows[0]));
        } catch (err) {
            if (isInvalidRecordError(err)) {
                console.warn(`GET /proposals/${req.params.id}: ${err.detail || err.message}`);
                return res.status(422).json({ error: err.message, code: err.code, detail: err.detail });
            }
            console.error('Error in GET /proposals/:id:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/proposals', async (req, res) => {
        try {
            const parcelId = req.query.parcel_id;
            const filters = parseFilters(req);
            if (filters.lifecycleError) return res.status(400).json({ error: filters.lifecycleError });
            const city = filters.city;
            const limit = Math.min(filters.limit, MAX_PARCEL_PROPOSALS_LIMIT);
            const offset = filters.offset;

            if (!parcelId) {
                return res.status(400).json({ error: 'parcel_id query parameter is required' });
            }

            const clauses = [];
            const params = [];

            if (city) {
                clauses.push(`city = $${params.length + 1}`);
                params.push(city);
            }

            if (filters.lifecycle) {
                clauses.push(`LOWER(${EFFECTIVE_STATUS_SQL}) = LOWER($${params.length + 1})`);
                params.push(filters.lifecycle);
            }

            clauses.push(`cadastre_parcel_ids @> $${params.length + 1}::jsonb`);
            params.push(JSON.stringify([String(parcelId)]));

            const sql = `
                SELECT
                    id, proposal_id, city, name, title, description, author, type,
                    lifecycle_status, ${EFFECTIVE_STATUS_SQL} AS effective_status,
                    offer, offer_currency, budget, budget_currency,
                    created_at, expires_at, updated_at,
                    cadastre_parcel_ids, ownership_flow,
                    onchain_data, screenshot_url, epoch_year, agent_payment_id, proposal_data
                FROM proposal
                WHERE ${clauses.join(' AND ')}
                ORDER BY created_at DESC
                LIMIT $${params.length + 1} OFFSET $${params.length + 2}
            `;

            params.push(limit, offset);
            const result = await pool.query(sql, params);

            const invalid = [];
            const proposals = result.rows.map(row => {
                try {
                    return serializeProposalRow(row);
                } catch (err) {
                    if (!isInvalidRecordError(err)) throw err;
                    invalid.push({ id: row.id, proposalId: row.proposal_id, error: err.message, detail: err.detail });
                    return null;
                }
            }).filter(Boolean);
            if (invalid.length) console.warn(`GET /proposals?parcel_id: skipped ${invalid.length} non-canonical record(s)`, invalid.map(entry => `${entry.id}: ${entry.detail || entry.error}`));

            res.json({ proposals, count: proposals.length, limit, offset, parcelId, ...(invalid.length ? { invalid } : {}) });
        } catch (err) {
            console.error('Error in GET /proposals?parcel_id:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Every PATCH below changes a shared record, so it must come from whoever uploaded it: the
    // X-Proposal-Edit-Token issued by POST /proposals. The Origin check in front of the API is
    // not authorization — a non-browser client sets any Origin it likes.
    //
    // Resolves the ONE row :id addresses (row id first, see oneProposalByIdClause) and checks the
    // token against it. Returns the row, or answers 403/404 itself and returns null.
    async function authorizeProposalEdit(req, res) {
        const token = readEditToken(req);
        if (!token) {
            res.status(403).json({ error: `${EDIT_TOKEN_HEADER} header is required to change a proposal.` });
            return null;
        }
        const result = await pool.query(`
                SELECT id, edit_token_hash
                FROM proposal
                ${oneProposalByIdClause('$1')}
            `, [req.params.id]);
        const row = result.rows[0];
        if (!row) {
            res.status(404).json({ error: 'Proposal not found' });
            return null;
        }
        if (!editTokenMatches(token, row.edit_token_hash)) {
            res.status(403).json({ error: 'The edit token does not match this proposal.' });
            return null;
        }
        return row;
    }

    app.patch('/proposals/:id/screenshot', proposalScreenshotPatchValidator, async (req, res) => {
        try {
            const screenshotUrl = req.validatedBody.screenshotUrl.trim();
            // Same rule as POST: the edit token proves who uploaded the row, not that the picture
            // every visitor's list will load is ours.
            if (!isOwnStoreImageUrl(screenshotUrl)) {
                return res.status(400).json({
                    error: 'screenshotUrl must be an image stored by this API (/uploads/images/<file>); upload it via /assets/upload first.'
                });
            }
            const target = await authorizeProposalEdit(req, res);
            if (!target) return;

            // Keyed by the primary key AND the hash just checked, so the write lands on exactly the
            // row that was authorized.
            const sql = `
                UPDATE proposal
                SET screenshot_url = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2 AND edit_token_hash = $3
                RETURNING id, proposal_id, screenshot_url
            `;
            const result = await pool.query(sql, [screenshotUrl, target.id, target.edit_token_hash]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }
            const row = result.rows[0];
            res.json({
                id: row.id,
                proposalId: row.proposal_id,
                screenshotUrl: row.screenshot_url
            });
        } catch (err) {
            console.error('Error in PATCH /proposals/:id/screenshot:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Rename a proposal in place (same addressing and authorization as the screenshot patch).
    app.patch('/proposals/:id/name', proposalNamePatchValidator, async (req, res) => {
        try {
            const name = req.validatedBody.name.trim();
            if (!name) {
                return res.status(400).json({ error: 'name is required.' });
            }
            const target = await authorizeProposalEdit(req, res);
            if (!target) return;

            // name and title are kept in step because the UI reads `title || name` — leaving one
            // behind would rename the proposal in some lists and not in others.
            const sql = `
                UPDATE proposal
                SET name = $1,
                    title = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2 AND edit_token_hash = $3
                RETURNING id, proposal_id, name, title
            `;
            const result = await pool.query(sql, [name, target.id, target.edit_token_hash]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }
            const row = result.rows[0];
            res.json({
                id: row.id,
                proposalId: row.proposal_id,
                name: row.name,
                title: row.title
            });
        } catch (err) {
            console.error('Error in PATCH /proposals/:id/name:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // PATCH /proposals/epochs — many epochs in ONE request.
    //
    // Assigning epochs across a plan is a write per proposal, and a plan is hundreds of proposals.
    // Sent one at a time that is hundreds of round trips, and it walks straight into the write rate
    // limiter: a distribution over 300 proposals died on 429 after the first hundred, leaving the
    // plan half-assigned with no indication of where it stopped.
    //
    // Body: { epochs: [{ id, epochYear, editToken }] } — id is a row id or proposal_id (row id
    // first), editToken the one POST /proposals returned for that proposal. Only entries whose token
    // matches are written, in one statement; the rest are named back as `forbidden` or `missing`
    // rather than failing the whole plan, because a plan routinely mixes your uploads with other
    // people's. Nothing authorized at all → 403.
    app.patch('/proposals/epochs', async (req, res) => {
        try {
            const entries = Array.isArray(req.body && req.body.epochs) ? req.body.epochs : null;
            if (!entries || !entries.length) {
                return res.status(400).json({ error: 'epochs must be a non-empty array of { id, epochYear, editToken }.' });
            }
            if (entries.length > 2000) {
                return res.status(400).json({ error: 'epochs is capped at 2000 entries per request.' });
            }

            const requests = [];
            for (const entry of entries) {
                const id = entry && entry.id !== undefined && entry.id !== null ? String(entry.id).trim() : '';
                if (!id) return res.status(400).json({ error: 'Every entry needs an id.' });
                const raw = entry.epochYear;
                // null clears the bucket; anything else must be a year in range. Validated per entry
                // rather than trusted, because one bad value would otherwise ride in with 299 good ones.
                let year = null;
                if (raw !== null && raw !== undefined) {
                    year = Number(raw);
                    if (!Number.isInteger(year) || year < 2026 || year > 2966) {
                        return res.status(400).json({ error: `epochYear for ${id} must be an integer 2026-2966, or null.` });
                    }
                }
                const editToken = typeof entry.editToken === 'string' ? entry.editToken.trim() : '';
                requests.push({ id, year, editToken });
            }

            const ids = Array.from(new Set(requests.map(request => request.id)));
            const found = await pool.query(`
                SELECT id, proposal_id, edit_token_hash
                FROM proposal
                WHERE proposal_id = ANY($1::text[]) OR id::text = ANY($1::text[])
            `, [ids]);
            const byDatabaseId = new Map();
            const byProposalId = new Map();
            for (const row of found.rows) {
                byDatabaseId.set(String(row.id), row);
                if (row.proposal_id !== null && row.proposal_id !== undefined) byProposalId.set(String(row.proposal_id), row);
            }

            // Which ids matched nothing / were not authorized, named rather than counted: a silent
            // shortfall is how an epoch plan comes to be missing exactly the proposals nobody checked.
            const missing = [];
            const forbidden = [];
            const yearByRowId = new Map();
            for (const request of requests) {
                const row = byDatabaseId.get(request.id) || byProposalId.get(request.id) || null;
                if (!row) { missing.push(request.id); continue; }
                if (!editTokenMatches(request.editToken, row.edit_token_hash)) { forbidden.push(request.id); continue; }
                yearByRowId.set(Number(row.id), { year: request.year, hash: row.edit_token_hash });
            }
            if (!yearByRowId.size) {
                const status = forbidden.length ? 403 : 200;
                return res.status(status).json({
                    ...(forbidden.length ? { error: 'No entry carried a matching edit token.' } : {}),
                    requested: requests.length, updated: 0, missing, forbidden, proposals: []
                });
            }

            const rowIds = [];
            const years = [];
            const hashes = [];
            for (const [rowId, { year, hash }] of yearByRowId) {
                rowIds.push(rowId);
                years.push(year);
                hashes.push(hash);
            }
            const sql = `
                UPDATE proposal p
                SET epoch_year = v.epoch_year,
                    updated_at = CURRENT_TIMESTAMP
                FROM (
                    SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS epoch_year, unnest($3::text[]) AS token_hash
                ) AS v
                WHERE p.id = v.id AND p.edit_token_hash = v.token_hash
                RETURNING p.id, p.proposal_id, p.epoch_year
            `;
            const result = await pool.query(sql, [rowIds, years, hashes]);
            const updated = result.rows.map(row => ({ id: row.id, proposalId: row.proposal_id, epochYear: row.epoch_year }));
            res.json({ requested: requests.length, updated: updated.length, missing, forbidden, proposals: updated });
        } catch (err) {
            console.error('Error in PATCH /proposals/epochs:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.patch('/proposals/:id/epoch', proposalEpochPatchValidator, async (req, res) => {
        try {
            const { epochYear } = req.validatedBody;
            const target = await authorizeProposalEdit(req, res);
            if (!target) return;

            const sql = `
                UPDATE proposal
                SET epoch_year = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2 AND edit_token_hash = $3
                RETURNING id, proposal_id, epoch_year
            `;
            const result = await pool.query(sql, [epochYear, target.id, target.edit_token_hash]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }
            const row = result.rows[0];
            res.json({
                id: row.id,
                proposalId: row.proposal_id,
                epochYear: row.epoch_year
            });
        } catch (err) {
            console.error('Error in PATCH /proposals/:id/epoch:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

}
