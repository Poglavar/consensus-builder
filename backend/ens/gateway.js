// CCIP-Read (ERC-3668) gateway core for ENS parcel names.
// Decodes an offchain-resolver query for <slug>.parcels.urbangametheory.eth,
// builds the requested record (addr / text) from a parcel_ens row, and returns
// a signed response that the L1 OffchainResolver verifies against a trusted
// signer. Pure logic only — DB lookup and ownerOf live in routes/ens.js.

import {
    AbiCoder,
    getBytes,
    toUtf8String,
    keccak256,
    solidityPackedKeccak256,
    SigningKey,
    getAddress,
    ZeroAddress,
} from 'ethers';

const abi = AbiCoder.defaultAbiCoder();

// Function selectors we handle.
const SELECTOR = {
    RESOLVE: '0x9061b923',     // resolve(bytes name, bytes data)  (wrapper)
    ADDR: '0x3b3b57de',        // addr(bytes32)
    ADDR_COIN: '0xf1cb7e06',   // addr(bytes32,uint256)
    TEXT: '0x59d1d43c',        // text(bytes32,string)
};

const ETH_COIN_TYPE = 60n;

// Decode a DNS wire-format name (<len><label>...0x00) into an array of labels.
function decodeDnsName(nameHex) {
    const bytes = getBytes(nameHex);
    const labels = [];
    let i = 0;
    while (i < bytes.length) {
        const len = bytes[i];
        if (len === 0) break;
        labels.push(toUtf8String(bytes.slice(i + 1, i + 1 + len)));
        i += 1 + len;
    }
    return labels;
}

// Given the full label list and the parent's labels, return the subname labels
// (everything before the parent), or null when the name isn't under the parent.
function subnameLabels(labels, parentLabels) {
    const subCount = labels.length - parentLabels.length;
    if (subCount < 0) return null;
    for (let k = 0; k < parentLabels.length; k++) {
        if ((labels[subCount + k] || '').toLowerCase() !== parentLabels[k].toLowerCase()) {
            return null;
        }
    }
    return labels.slice(0, subCount);
}

// The slug is always a single label (slugs never contain dots). For both flat
// (<slug>.parcels…) and city-scoped (<slug>.<city>.parcels…) forms the slug is
// the first subname label. No subname labels → the apex (contract naming).
function slugFromName(nameHex, parentLabels) {
    const labels = decodeDnsName(nameHex);
    const sub = subnameLabels(labels, parentLabels);
    if (sub === null) return { underParent: false, slug: null };
    if (sub.length === 0) return { underParent: true, slug: null }; // apex
    return { underParent: true, slug: sub[0].toLowerCase() };
}

// Build the text record value for a given key from a parcel_ens record.
// isApex distinguishes the parent name itself (contract naming) from a present
// but unknown subname (record === null, not apex) which must resolve to empty.
function buildTextValue(key, record, config, isApex) {
    if (!record) {
        if (!isApex) return ''; // known query shape, no such parcel
        // Apex / contract name.
        if (key === 'url') return config.publicBaseUrl;
        if (key === 'description') return 'Urban Game Theory — global parcels';
        return '';
    }
    switch (key) {
        case 'url':
            // parcel_id may contain '/' (Zagreb); the deep-link route reads the
            // raw path including slashes, so we intentionally do not encode it.
            return `${config.publicBaseUrl}/parcel/${record.parcel_id}`;
        case 'description': {
            const where = record.city_name ? ` in ${record.city_name}` : '';
            const area = record.area_m2 ? ` (${Math.round(record.area_m2)} m²)` : '';
            return `Parcel ${record.parcel_id}${where}${area}`;
        }
        case 'geo':
            return (record.lat != null && record.lon != null) ? `${record.lat},${record.lon}` : '';
        case 'avatar':
            return record.image_url || '';
        default:
            return '';
    }
}

// Compute the ABI-encoded answer for the inner resolver query.
// `owner` is the address the addr() records resolve to (parcel owner, the
// ParcelNFT contract for the apex, or the zero address when unknown).
function buildResult(innerData, { record, owner, config, isApex }) {
    const selector = innerData.slice(0, 10).toLowerCase();
    const body = '0x' + innerData.slice(10);
    const addr = owner ? getAddress(owner) : ZeroAddress;

    if (selector === SELECTOR.TEXT) {
        const [, key] = abi.decode(['bytes32', 'string'], body);
        return abi.encode(['string'], [buildTextValue(key, record, config, isApex)]);
    }
    if (selector === SELECTOR.ADDR) {
        return abi.encode(['address'], [addr]);
    }
    if (selector === SELECTOR.ADDR_COIN) {
        const [, coinType] = abi.decode(['bytes32', 'uint256'], body);
        const value = (coinType === ETH_COIN_TYPE && addr !== ZeroAddress) ? getBytes(addr) : '0x';
        return abi.encode(['bytes'], [value]);
    }
    // Unsupported record type → empty bytes (resolver decodes as "no record").
    return '0x';
}

// EIP-191-free signature hash used by ENS SignatureVerifier:
//   keccak256(0x1900 ‖ sender ‖ expires ‖ keccak256(request) ‖ keccak256(result))
function makeSignatureHash(sender, expires, request, result) {
    return solidityPackedKeccak256(
        ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
        ['0x1900', getAddress(sender), expires, keccak256(request), keccak256(result)],
    );
}

// Resolve a CCIP-Read query end to end and return the signed response bytes
// (abi.encode(result, expires, signature)) for the JSON `{ data }` field.
//   sender      — the L1 resolver address (from the request)
//   callData    — the wrapper calldata: resolve(bytes name, bytes data)
//   lookupSlug  — async (slug) => parcel_ens row | null
//   resolveOwner— async (record) => 0x-address | null   (best-effort ownerOf)
async function resolveQuery({ sender, callData, lookupSlug, resolveOwner, config }) {
    const selector = callData.slice(0, 10).toLowerCase();
    if (selector !== SELECTOR.RESOLVE) {
        throw new Error(`Unexpected wrapper selector ${selector}`);
    }
    const [nameHex, innerData] = abi.decode(['bytes', 'bytes'], '0x' + callData.slice(10));

    const { underParent, slug } = slugFromName(nameHex, config.parentLabels);
    if (!underParent) {
        throw new Error('Name is not under the configured parent');
    }

    const isApex = slug === null;
    let record = null;
    let owner = isApex ? (config.apexAddress || null) : null; // apex → ParcelNFT contract address
    if (slug) {
        record = await lookupSlug(slug);
        owner = (record && typeof resolveOwner === 'function') ? await resolveOwner(record) : null;
    }

    const result = buildResult(innerData, { record, owner, config, isApex });
    const expires = BigInt(config.now()) + BigInt(config.ttlSeconds);
    const hash = makeSignatureHash(sender, expires, callData, result);
    const signature = new SigningKey(config.signingKey).sign(hash).serialized;

    return abi.encode(['bytes', 'uint64', 'bytes'], [result, expires, signature]);
}

export {
    decodeDnsName,
    subnameLabels,
    slugFromName,
    buildTextValue,
    buildResult,
    makeSignatureHash,
    resolveQuery,
    SELECTOR,
};
