// Step 4 of the ENS rollout: create parcels.urbangametheory.eth and point its
// resolver at our deployed OffchainResolver, in one ENS registry tx. Must be
// signed by the owner of urbangametheory.eth.
//
//   ENS_OWNER_PRIVATE_KEY   private key of urbangametheory.eth's owner (required)
//   ENS_RESOLVER_ADDRESS    OffchainResolver address (default: the deployed one)
//   MAINNET_RPC_URL         optional RPC override
//
// Run: node scripts/ens-set-parcels-resolver.mjs
import { JsonRpcProvider, Wallet, Contract, namehash, keccak256, toUtf8Bytes, isAddress } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const PARENT = 'urbangametheory.eth';
const LABEL = 'parcels';
const DEFAULT_RESOLVER = '0x874a520C1D2c395F19a3c8eC3eb51fAb6e08572F';

const rpc = process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const pk = process.env.ENS_OWNER_PRIVATE_KEY;
const resolver = process.env.ENS_RESOLVER_ADDRESS || DEFAULT_RESOLVER;

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
const labelhash = keccak256(toUtf8Bytes(LABEL));
const childNode = namehash(`${LABEL}.${PARENT}`);

const parentOwner = await registry.owner(parentNode);
console.log('signer        :', wallet.address);
console.log('parent owner  :', parentOwner);
if (parentOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`\nSigner does not own ${PARENT}. Use the owner wallet (${parentOwner}),`);
    console.error('or do it in the ENS app: add subname "parcels", set its resolver to', resolver);
    process.exit(1);
}

console.log(`\nSetting ${LABEL}.${PARENT}: owner=${wallet.address}, resolver=${resolver} ...`);
const tx = await registry.setSubnodeRecord(parentNode, labelhash, wallet.address, resolver, 0n);
console.log('tx sent:', tx.hash);
await tx.wait();
console.log('resolver now  :', await registry.resolver(childNode));
console.log('Done.');
