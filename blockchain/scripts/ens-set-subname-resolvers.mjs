// Point one or more subnames of urbangametheory.eth at our OffchainResolver, in
// one ENS registry tx each (setSubnodeRecord = create subname + set resolver).
// Used to wire parcels.urbangametheory.eth and proposals.urbangametheory.eth.
// Must be signed by the owner of urbangametheory.eth.
//
//   ENS_OWNER_PRIVATE_KEY   private key of urbangametheory.eth's owner (required)
//   ENS_RESOLVER_ADDRESS    OffchainResolver address (default: the deployed one)
//   ENS_SUBNAME_LABELS      comma-separated labels (default: "parcels,proposals")
//   MAINNET_RPC_URL         optional RPC override
//
// Run: node scripts/ens-set-subname-resolvers.mjs
import { JsonRpcProvider, Wallet, Contract, namehash, keccak256, toUtf8Bytes, isAddress } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const PARENT = 'urbangametheory.eth';
const DEFAULT_RESOLVER = '0x874a520C1D2c395F19a3c8eC3eb51fAb6e08572F';

const rpc = process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const pk = process.env.ENS_OWNER_PRIVATE_KEY;
const resolver = process.env.ENS_RESOLVER_ADDRESS || DEFAULT_RESOLVER;
const labels = (process.env.ENS_SUBNAME_LABELS || 'parcels,proposals')
    .split(',').map((s) => s.trim()).filter(Boolean);

if (!pk) {
    console.error('Set ENS_OWNER_PRIVATE_KEY (private key of the wallet that owns urbangametheory.eth).');
    process.exit(1);
}
if (!isAddress(resolver)) {
    console.error(`ENS_RESOLVER_ADDRESS is not a valid address: ${resolver}`);
    process.exit(1);
}

const provider = new JsonRpcProvider(rpc, 1, { staticNetwork: true });
const wallet = new Wallet(pk, provider);
const registry = new Contract(ENS_REGISTRY, [
    'function owner(bytes32) view returns (address)',
    'function resolver(bytes32) view returns (address)',
    'function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl)',
], wallet);

const parentNode = namehash(PARENT);
const parentOwner = await registry.owner(parentNode);
console.log('signer        :', wallet.address);
console.log('parent owner  :', parentOwner);
console.log('resolver      :', resolver);
console.log('labels        :', labels.join(', '));
if (parentOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`\nSigner does not own ${PARENT}. Use the owner wallet (${parentOwner}),`);
    console.error(`or in the ENS app set each subname's resolver to ${resolver}.`);
    process.exit(1);
}

for (const label of labels) {
    const labelhash = keccak256(toUtf8Bytes(label));
    const childNode = namehash(`${label}.${PARENT}`);
    process.stdout.write(`\n${label}.${PARENT}: setting resolver -> ${resolver} ... `);
    const tx = await registry.setSubnodeRecord(parentNode, labelhash, wallet.address, resolver, 0n);
    await tx.wait();
    console.log('ok', tx.hash);
    console.log('  resolver now:', await registry.resolver(childNode));
}
console.log('\nDone.');
