// The portable, immutable proposal in NFT metadata. Chain readers and server mirrors use this
// exact record; browser application state and server preparation signatures never enter it.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__chainRecord = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const PROTOCOL = 'proposal-chain/1';
    const FIELDS = Object.freeze([
        'proposalId', 'city', 'type', 'goal', 'proposalRole', 'name', 'title', 'description', 'author',
        'createdAt', 'authoredAt', 'expiresAt', 'epochYear', 'offer', 'offerCurrency', 'budget',
        'budgetCurrency', 'decayEnabled', 'decayPercent', 'decayDurationMs', 'depositEnabled',
        'depositPercent', 'disbursementMode', 'isConditional', 'isVote', 'voteExpiryDays',
        'cadastreParcelIds', 'site', 'binding', 'toleranceM', 'cadastreSnapshot', 'ownershipFlow',
        'cadastreFrame', 'lens', 'bounds', 'geometry', 'roadProposal', 'buildingProposal',
        'structureProposal', 'reparcellization', 'decideLaterProposal', 'ownershipTransfer',
        'ownershipTransferDirection', 'ownershipTransferRecipient', 'ownershipTransferProposal',
        'acquisitionMode', 'boundaryAdjustment', 'primaryType', 'typologyType', 'tags', 'facets',
        'isCorridor', 'copiedFromProposalId', 'copiedFromName', 'sourceProposalId',
        'replacementOfProposalId', 'landFork', 'freePlacement', 'agent',
        // The approval setup (rights snapshot and policy): with the parcels and lens it is the
        // approval context every owner decision signs, so chain + IPFS alone can verify decisions.
        'approvalConfig'
    ]);
    const clone = value => JSON.parse(JSON.stringify(value));
    const dependency = (name, path) => global[name] || (typeof require === 'function' ? require(path) : null);
    const fail = message => { throw Object.assign(new Error(message), { code: 'chain-record-invalid', status: 422 }); };

    function parcelIds(values) {
        const authored = dependency('ProposalAuthoredRecord', './authored-record.js');
        if (!Array.isArray(values) || values.some(id => typeof id !== 'string' || !id || id.trim() !== id
            || authored.isDerivedParcelId(id)) || new Set(values).size !== values.length) {
            fail('The minted consent list must contain unique, original cadastral parcel IDs.');
        }
        return values.slice();
    }

    function authoredRecord(proposal) {
        const boundary = dependency('__formationDepth', './formation-depth.js');
        const gate = boundary.preparePublishRecord(proposal);
        if (!gate.verdict.flat) fail('The minted proposal must contain only authored geometry and original cadastral parcel IDs.');
        const record = {};
        for (const key of FIELDS) if (gate.proposal[key] !== undefined) record[key] = clone(gate.proposal[key]);
        record.cadastreParcelIds = parcelIds(record.cadastreParcelIds);
        record.isConditional = proposal.isConditional === true || proposal.conditional === true;
        if (record.lens) record.lens = record.lens.map(entry => typeof entry === 'string' ? entry : entry.address);
        if (record.ownershipTransferProposal) delete record.ownershipTransferProposal.status;
        if (record.approvalConfig != null) record.approvalConfig = approvalConfig(record.approvalConfig);
        return record;
    }

    function approvalConfig(value) {
        try {
            return dependency('ProposalApproval', './approval.js').normalizeConfig(value);
        } catch (error) {
            return fail(`The approval setup is invalid: ${error.message}`);
        }
    }

    function metadataProperties(proposal) {
        return { proposalProtocol: PROTOCOL, proposal: authoredRecord(proposal) };
    }

    function fromMetadata(metadata) {
        const properties = metadata?.properties;
        if (properties?.proposalProtocol !== PROTOCOL || !properties.proposal
            || typeof properties.proposal !== 'object' || Array.isArray(properties.proposal)) {
            fail('NFT metadata does not contain a complete portable proposal.');
        }
        const record = properties.proposal;
        if (Object.keys(record).some(key => !FIELDS.includes(key))) fail('NFT proposal contains non-authored fields.');
        parcelIds(record.cadastreParcelIds);
        if (!record.site || !record.binding || !record.cadastreSnapshot) fail('NFT proposal is missing its site, binding, or cadastral snapshot.');
        const gate = dependency('__formationDepth', './formation-depth.js').preparePublishRecord(record);
        if (!gate.verdict.flat) fail('NFT proposal contains invalid cadastral references.');
        const result = clone(record);
        if (result.approvalConfig != null) result.approvalConfig = approvalConfig(result.approvalConfig);
        return result;
    }

    function sameIds(left, right, lowerCase = false) {
        const normalize = values => values.map(value => lowerCase ? String(value).toLowerCase() : String(value)).sort();
        return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
    }

    // This proves agreement with the minted commitment, not cadastral completeness or ownership.
    // Source geometry/version evidence in cadastreSnapshot lets a verifier audit that separately.
    async function verifyAgainstChain(record, chain) {
        const ids = parcelIds(record.cadastreParcelIds);
        if (!sameIds(ids, parcelIds(chain.cadastreParcelIds))) fail('NFT metadata and the on-chain consent list disagree.');
        if (!sameIds(ids, (record.binding?.parcels || []).map(hit => hit.parcelId))) fail('NFT binding and consent list disagree.');
        if (typeof chain.isConditional === 'boolean' && record.isConditional !== chain.isConditional) {
            fail('NFT metadata and the on-chain conditional flag disagree.');
        }
        if (Array.isArray(chain.lens) && !sameIds(record.lens || [], chain.lens, chain.ref?.chainType === 'evm')) {
            fail('NFT metadata and the on-chain lens disagree.');
        }
        if (Object.prototype.hasOwnProperty.call(chain, 'siteHash')) {
            const hashApi = dependency('__siteHash', './site-hash.js');
            const args = await hashApi.chainSiteArgs({ site: record.site, binding: record.binding, parcelIds: ids });
            const hex = await hashApi.siteHashHex(record.site);
            if (hex !== chain.siteHash || args.openGround !== chain.openGround) fail('NFT site or open-ground flag differs from the on-chain commitment.');
        }
        return record;
    }

    return { PROTOCOL, FIELDS, authoredRecord, metadataProperties, fromMetadata, verifyAgainstChain, parcelIds };
});
