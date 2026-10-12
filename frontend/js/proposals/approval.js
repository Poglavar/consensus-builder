// Abstract parcel rights, approval context and owner/area tallies shared by all proposal tools.
// Uploaded declarations are data, not identity proof; authority evidence is supplied separately.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApproval = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const RIGHTS_SCHEMA = 'parcel-rights/v1';
    const CONFIG_SCHEMA = 'proposal-approval/v1';
    const CONTEXT_SCHEMA = 'proposal-approval-context/v1';
    const MAX_RECORDS = 10000;
    const crypto = () => root.__consentSha256
        || (typeof require === 'function' ? require('../../vendor/noble-hashes-1.8.0/sha256.js') : null);
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    function fail(message) {
        const error = new Error(message);
        error.code = 'invalid-proposal-approval';
        throw error;
    }
    function text(value, field) {
        if (typeof value !== 'string' || !value.trim() || value.length > 256) fail(`${field} needs a non-empty reference (maximum 256 characters).`);
        return value.trim();
    }
    function ownerId(value) {
        const id = text(value, 'ownerId');
        if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) fail('ownerId must be an opaque ID using letters, digits, or . _ : @ / - .');
        return id;
    }
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    function fraction(value) {
        if (typeof value !== 'string' || !/^\d{1,12}\/\d{1,12}$/.test(value)) fail('A share must be an exact fraction, such as 1/2.');
        let [n, d] = value.split('/').map(BigInt);
        if (d <= 0n || n <= 0n || n > d) fail('Ownership shares must be positive and at most 1/1.');
        const divisor = gcd(n, d);
        return { n: n / divisor, d: d / divisor };
    }
    function add(a, b) {
        const n = a.n * b.d + b.n * a.d, d = a.d * b.d;
        const divisor = gcd(n, d);
        return { n: n / divisor, d: d / divisor };
    }
    function normalizeRights(raw) {
        if (!raw || raw.schema !== RIGHTS_SCHEMA) fail(`Expected ${RIGHTS_SCHEMA}.`);
        if (!raw.source || typeof raw.source !== 'object') fail('Rights need a source provider.');
        const source = { provider: text(raw.source.provider, 'source.provider') };
        if (raw.source.reference != null && raw.source.reference !== '') source.reference = text(raw.source.reference, 'source.reference');
        if (!Array.isArray(raw.parcels) || raw.parcels.length > MAX_RECORDS) fail('Rights need a bounded parcel list.');
        const seen = new Set();
        let count = 0;
        const parcels = raw.parcels.map(parcel => {
            const parcelId = text(parcel?.parcelId, 'parcelId');
            if (seen.has(parcelId)) fail(`Duplicate parcel ${parcelId}.`);
            seen.add(parcelId);
            if (typeof parcel.complete !== 'boolean') fail(`Parcel ${parcelId} must declare whether its owner list is complete.`);
            if (!Array.isArray(parcel.owners)) fail(`Parcel ${parcelId} needs an owners array.`);
            if ((count += parcel.owners.length) > MAX_RECORDS) fail('Too many ownership interests.');
            let sum = { n: 0n, d: 1n };
            const ownersSeen = new Set();
            const owners = parcel.owners.map(owner => {
                const id = ownerId(owner?.ownerId);
                if (ownersSeen.has(id)) fail(`Duplicate owner ${id} on ${parcelId}.`);
                ownersSeen.add(id);
                if (owner.kind != null && owner.kind !== 'ownership') fail('This schema supports ownership rights only.');
                const share = fraction(owner.share);
                sum = add(sum, share);
                return { ownerId: id, share: `${share.n}/${share.d}` };
            }).sort((a, b) => compare(a.ownerId, b.ownerId));
            if (sum.n > sum.d || (parcel.complete && (!owners.length || sum.n !== sum.d))) {
                fail(`Ownership shares for ${parcelId} must ${parcel.complete ? 'sum to' : 'not exceed'} 1/1.`);
            }
            const areaM2 = parcel.areaM2 ?? null;
            if (areaM2 !== null && (typeof areaM2 !== 'number' || !Number.isFinite(areaM2) || areaM2 <= 0 || areaM2 > 1e15)) {
                fail(`Parcel ${parcelId} needs a positive finite area or null.`);
            }
            return { parcelId, complete: parcel.complete, areaM2, owners };
        }).sort((a, b) => compare(a.parcelId, b.parcelId));
        return { schema: RIGHTS_SCHEMA, source, parcels };
    }
    function threshold(raw) {
        if (!raw || !Number.isSafeInteger(raw.numerator) || !Number.isSafeInteger(raw.denominator)
            || raw.numerator <= 0 || raw.denominator <= 0 || raw.numerator > raw.denominator
            || raw.denominator > 1e12 || typeof raw.strict !== 'boolean'
            || (raw.strict && raw.numerator === raw.denominator)) fail('Invalid owner/area threshold.');
        const divisor = Number(gcd(BigInt(raw.numerator), BigInt(raw.denominator)));
        return { numerator: raw.numerator / divisor, denominator: raw.denominator / divisor, strict: raw.strict };
    }
    function normalizePolicy(raw) {
        if (!raw || raw.type === 'unanimous') return { type: 'unanimous' };
        if (raw.type !== 'threshold') fail('Unknown approval policy.');
        return { type: 'threshold', owners: threshold(raw.owners), area: threshold(raw.area) };
    }
    function normalizeConfig(raw) {
        if (!raw || raw.schema !== CONFIG_SCHEMA) fail(`Expected ${CONFIG_SCHEMA}.`);
        return { schema: CONFIG_SCHEMA, rights: raw.rights == null ? null : normalizeRights(raw.rights), policy: normalizePolicy(raw.policy) };
    }
    function lensKeys(proposal) {
        const rows = proposal?.lens || [];
        if (!Array.isArray(rows)) fail('The proposal lens must be a list.');
        return [...new Set(rows.filter(row => typeof row === 'string' || row?.address || row?.key)
            .map(row => text(typeof row === 'string' ? row : row.address || row.key, 'lens member')))].sort(compare);
    }
    function contextContent(proposal) {
        const config = proposal?.approvalConfig == null
            ? { rights: null, policy: { type: 'unanimous' } } : normalizeConfig(proposal.approvalConfig);
        return {
            schema: CONTEXT_SCHEMA,
            cadastreParcelIds: [...new Set((proposal?.cadastreParcelIds || []).map(id => text(String(id), 'parcelId')))].sort(compare),
            rights: config.rights, policy: config.policy, lens: lensKeys(proposal)
        };
    }
    function stableStringify(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }
    const hash = (prefix, value) => prefix + crypto().sha256Hex(stableStringify(value));
    const contextHash = proposal => hash('approval1-sha256:', contextContent(proposal));
    const consentHash = (proposal, designHash) => {
        if (typeof designHash !== 'string' || !designHash) fail('Consent needs a design commitment.');
        return hash('consent1-sha256:', { designHash, approval: contextContent(proposal) });
    };
    function inspect(proposal) {
        const context = contextContent(proposal);
        const byParcel = new Map((context.rights?.parcels || []).map(parcel => [parcel.parcelId, parcel]));
        const parcels = context.cadastreParcelIds.map(id => byParcel.get(id)).filter(Boolean);
        const missingParcelIds = context.cadastreParcelIds.filter(id => !byParcel.get(id)?.complete);
        const ownerIds = [...new Set(parcels.flatMap(parcel => parcel.owners.map(owner => owner.ownerId)))].sort(compare);
        const reason = !context.rights ? 'missing-rights' : !context.cadastreParcelIds.length ? 'missing-parcels'
            : missingParcelIds.length ? 'incomplete-rights' : !ownerIds.length ? 'missing-owners' : null;
        return { ready: !reason, reason, ownerIds, parcels, missingParcelIds, context };
    }
    function ownerLabel(id, ids) {
        let number = ids.indexOf(id) + 1, label = '';
        if (!number) return 'Owner';
        while (number) { number -= 1; label = String.fromCharCode(65 + number % 26) + label; number = Math.floor(number / 26); }
        return `Owner ${label}`;
    }
    function createTemplate(parcelIds = []) {
        return {
            schema: RIGHTS_SCHEMA, source: { provider: 'upload', reference: 'rights-snapshot-1' },
            parcels: [...new Set(parcelIds.map(String))].map(parcelId => ({ parcelId, complete: false, areaM2: null, owners: [] }))
        };
    }
    // Numbers are converted to their exact decimal representation for threshold comparisons.
    // This avoids an arbitrary epsilon allowing an exactly-50% strict-majority vote to pass.
    function decimal(value) {
        const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
        const [whole, fractional = ''] = mantissa.split('.');
        const shift = Number(exponent) - fractional.length;
        const n = BigInt(whole + fractional);
        return shift >= 0 ? { n: n * 10n ** BigInt(shift), d: 1n } : { n, d: 10n ** BigInt(-shift) };
    }
    function passes(yes, total, rule) {
        if (total.n <= 0n) return false;
        const left = yes.n * total.d * BigInt(rule.denominator);
        const right = total.n * yes.d * BigInt(rule.numerator);
        return rule.strict ? left > right : left >= right;
    }
    function tally(proposal, approvedOwnerIds = []) {
        const state = inspect(proposal);
        const yes = new Set(approvedOwnerIds.filter(id => state.ownerIds.includes(id)));
        const acceptedParcelIds = state.ready ? state.parcels.filter(parcel => parcel.owners.every(owner => yes.has(owner.ownerId))).map(parcel => parcel.parcelId) : [];
        const areaKnown = state.ready && state.parcels.every(parcel => parcel.areaM2 !== null);
        let totalArea = { n: 0n, d: 1n }, yesArea = { n: 0n, d: 1n };
        if (areaKnown) for (const parcel of state.parcels) {
            const area = decimal(parcel.areaM2);
            totalArea = add(totalArea, area);
            if (acceptedParcelIds.includes(parcel.parcelId)) yesArea = add(yesArea, area);
        }
        const policy = state.context.policy;
        const ownerThresholdMet = state.ready && (policy.type === 'unanimous' ? yes.size === state.ownerIds.length
            : passes({ n: BigInt(yes.size), d: 1n }, { n: BigInt(state.ownerIds.length), d: 1n }, policy.owners));
        const areaThresholdMet = state.ready && (policy.type === 'unanimous' ? acceptedParcelIds.length === state.parcels.length
            : areaKnown && passes(yesArea, totalArea, policy.area));
        return {
            ready: state.ready, reason: state.reason, totalOwners: state.ready ? state.ownerIds.length : null,
            acceptedOwners: state.ready ? yes.size : 0, acceptedParcelIds,
            totalAreaM2: areaKnown ? Number(totalArea.n) / Number(totalArea.d) : null,
            acceptedAreaM2: areaKnown ? Number(yesArea.n) / Number(yesArea.d) : null,
            ownerThresholdMet, areaThresholdMet, passed: ownerThresholdMet && areaThresholdMet
        };
    }
    function evidenceAllows(proposal, owner, actorId, evidence) {
        const state = inspect(proposal);
        if (!state.ready || !state.ownerIds.includes(owner) || !actorId || !evidence) return false;
        const expected = contextHash(proposal);
        return ['rights', 'authority'].every(kind => {
            const fact = evidence[kind];
            return fact && fact.contextHash === expected && state.context.lens.includes(fact.member)
                && typeof fact.evidenceRef === 'string' && !!fact.evidenceRef
                && (kind === 'rights' || (fact.ownerId === owner && fact.actorId === actorId));
        });
    }
    // The identity an owner decision signs. A minted proposal is its chain account, so the server
    // copy, a chain mirror and the minting browser all name it alike; otherwise its proposalId.
    function subjectOf(proposal) {
        const onchain = proposal?.onchain || {};
        if (onchain.proposalId != null && String(onchain.proposalId)) {
            const chainId = String(onchain.chainId || '');
            if (!/^solana-[a-z-]+$/.test(chainId)) fail('Owner decisions are supported only for proposals minted on Solana.');
            return `solana:${chainId.slice('solana-'.length)}:${onchain.proposalId}`;
        }
        if (proposal?.proposalId == null || !String(proposal.proposalId).trim()) fail('An owner decision needs a published proposal identity.');
        return String(proposal.proposalId);
    }
    function decisionContent(proposal, receipt) {
        return { schema: 'owner-decision/v1', proposalId: subjectOf(proposal),
            ownerId: receipt.ownerId, actorId: receipt.actorId, effectHash: receipt.effectHash,
            decision: receipt.decision, acceptedAt: receipt.acceptedAt, contextHash: contextHash(proposal) };
    }
    function validOwnerIds(proposal, designCommitment, verifyReceipt) {
        const state = inspect(proposal);
        if (!state.ready || !designCommitment || typeof verifyReceipt !== 'function') return [];
        return state.ownerIds.filter(id => {
            const receipt = proposal.ownerApprovals?.[id];
            return receipt?.effectHash === designCommitment && receipt?.ownerId === id
                && receipt.decision === 'approve' && evidenceAllows(proposal, id, receipt.actorId, receipt.evidence)
                && verifyReceipt(proposal, receipt) === true;
        });
    }
    function recordDecision(proposal, { ownerId: id, actorId, effectHash, evidence, acceptedAt, withdraw = false, decisionProof, providerId, verifyReceipt }) {
        if (!evidenceAllows(proposal, id, actorId, evidence) || !effectHash) fail('The selected lens has not established these rights and this actor’s authority.');
        const receipt = { ownerId: id, actorId, effectHash, evidence: JSON.parse(JSON.stringify(evidence)), acceptedAt,
            decision: withdraw ? 'withdraw' : 'approve', decisionProof, providerId };
        if (typeof acceptedAt !== 'string' || !Number.isFinite(Date.parse(acceptedAt))
            || typeof verifyReceipt !== 'function' || verifyReceipt(proposal, receipt) !== true) fail('The owner decision has not been verified.');
        const next = JSON.parse(JSON.stringify(proposal));
        const previous = next.ownerApprovals?.[id];
        if (withdraw && (!previous || previous.actorId !== actorId)) fail('Only the actor who recorded an approval may withdraw it.');
        if (!withdraw && validOwnerIds(next, effectHash, verifyReceipt).includes(id)) fail('This owner has already approved these terms.');
        next.ownerApprovals = next.ownerApprovals || {};
        if (previous) next.ownerApprovalHistory = [...(next.ownerApprovalHistory || []), previous];
        if (withdraw) {
            delete next.ownerApprovals[id];
            next.ownerApprovalHistory = [...(next.ownerApprovalHistory || []), receipt];
        } else next.ownerApprovals[id] = receipt;
        const result = tally(next, validOwnerIds(next, effectHash, verifyReceipt));
        next.acceptedParcelIds = result.acceptedParcelIds;
        return { proposal: next, tally: result };
    }
    return { RIGHTS_SCHEMA, CONFIG_SCHEMA, CONTEXT_SCHEMA, normalizeRights, normalizeConfig, normalizePolicy,
        lensKeys, contextContent, contextHash, consentHash, stableStringify, inspect, ownerLabel, createTemplate,
        tally, evidenceAllows, subjectOf, decisionContent, validOwnerIds, recordDecision };
});
