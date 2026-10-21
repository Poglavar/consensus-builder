// The portable, immutable proposal in NFT metadata. Chain readers and server mirrors use this
// exact record; browser application state and server preparation signatures never enter it.
// Only the reading side remains: the mint that wrote such records went with the design mint path
// (plan-design-agreement.md, M2), and agreements mint in M3.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__chainRecord = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const PROTOCOL = 'proposal-chain/1';
    const FIELDS = Object.freeze([
        'proposalId', 'city', 'type', 'goal', 'proposalRole', 'name', 'title', 'titleOrigin', 'description', 'author',
        'createdAt', 'authoredAt', 'epochYear',
        'cadastreParcelIds', 'site', 'binding', 'toleranceM', 'cadastreSnapshot', 'ownershipFlow',
        'cadastreFrame', 'lens', 'bounds', 'geometry', 'roadProposal', 'buildingProposal',
        'structureProposal', 'parcelLayout', 'ownershipTransfer',
        'ownershipTransferDirection', 'ownershipTransferRecipient', 'ownershipTransferProposal',
        'acquisitionMode', 'boundaryAdjustment', 'primaryType', 'typologyType', 'tags', 'facets',
        'isCorridor', 'proposalOrigin', 'landFork', 'freePlacement', 'agent',
        // The approval setup (rights snapshot and policy): with the parcels and lens it is the
        // approval context every owner decision signs, so chain + IPFS alone can verify decisions.
        'approvalConfig', 'sourceReferences'
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

    function checkSourceReferences(record) {
        dependency('PlanningSourceProposal', '../planning/source-proposal.js').validateReferences(record.sourceReferences);
    }

    function approvalConfig(value) {
        try {
            return dependency('ProposalApproval', './approval.js').normalizeConfig(value);
        } catch (error) {
            return fail(`The approval setup is invalid: ${error.message}`);
        }
    }

    function fromMetadata(metadata) {
        const properties = metadata?.properties;
        if (properties?.proposalProtocol !== PROTOCOL || !properties.proposal
            || typeof properties.proposal !== 'object' || Array.isArray(properties.proposal)) {
            fail('NFT metadata does not contain a complete portable proposal.');
        }
        const record = properties.proposal;
        if (Object.keys(record).some(key => !FIELDS.includes(key))) fail('NFT proposal contains non-authored fields.');
        if (record.proposalOrigin) {
            const origin = dependency('ProposalOrigin', './origin.js').normalize(record.proposalOrigin);
            if (origin.source?.kind === 'local') fail('NFT proposal origin cannot contain a browser-local key.');
        }
        parcelIds(record.cadastreParcelIds);
        checkSourceReferences(record);
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

    return { PROTOCOL, FIELDS, fromMetadata, verifyAgainstChain, parcelIds };
});
