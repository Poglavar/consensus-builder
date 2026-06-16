// Option A contract naming: dedicated, fully on-chain names for the two NFT
// contracts, using the ENS public resolver (no gateway). Creates
//   parcels-nft.urbangametheory.eth   -> ParcelNFT   (Base Sepolia)
//   proposals-nft.urbangametheory.eth -> ProposalNFT (Base Sepolia)
// Signed by the owner of urbangametheory.eth. addr() is coinType 60 (an
// identifier; the contracts live on Base Sepolia).
//
//   ENS_OWNER_PRIVATE_KEY   owner of urbangametheory.eth (required)
//   ENS_PUBLIC_RESOLVER     default 0xF29100983E058B709F3D539b0c765937B804AC15
//   MAINNET_RPC_URL         optional RPC override
import { JsonRpcProvider, Wallet, Contract, namehash, keccak256, toUtf8Bytes, getAddress, isAddress } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const PUBLIC_RESOLVER = process.env.ENS_PUBLIC_RESOLVER || '0xF29100983E058B709F3D539b0c765937B804AC15';
const PARENT = 'urbangametheory.eth';
const NAMES = [
    { label: 'parcels-nft', addr: process.env.PARCEL_NFT_ADDR || '0x191Bb541E185f8C4fBF1eF4CE12a28acCFA6b35d' },
    { label: 'proposals-nft', addr: process.env.PROPOSAL_NFT_ADDR || '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709' },
];

const rpc = process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const pk = process.env.ENS_OWNER_PRIVATE_KEY;
if (!pk) { console.error('Set ENS_OWNER_PRIVATE_KEY (owner of urbangametheory.eth).'); process.exit(1); }

const provider = new JsonRpcProvider(rpc, 1, { staticNetwork: true });
const wallet = new Wallet(pk, provider);
const registry = new Contract(ENS_REGISTRY, [
    'function owner(bytes32) view returns (address)',
    'function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl)',
], wallet);
const resolver = new Contract(PUBLIC_RESOLVER, [
    'function setAddr(bytes32 node, address a)',
    'function addr(bytes32 node) view returns (address)',
], wallet);

const parentNode = namehash(PARENT);
const parentOwner = await registry.owner(parentNode);
console.log('signer        :', wallet.address);
console.log('parent owner  :', parentOwner);
console.log('public resolver:', PUBLIC_RESOLVER);
if (parentOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`\nSigner does not own ${PARENT}.`);
    process.exit(1);
}

for (const { label, addr } of NAMES) {
    if (!isAddress(addr)) { console.error('skip — bad address for', label, addr); continue; }
    const labelhash = keccak256(toUtf8Bytes(label));
    const node = namehash(`${label}.${PARENT}`);
    console.log(`\n${label}.${PARENT} -> ${addr}`);
    let tx = await registry.setSubnodeRecord(parentNode, labelhash, wallet.address, PUBLIC_RESOLVER, 0n);
    await tx.wait();
    console.log('  subname + public resolver set:', tx.hash);
    tx = await resolver.setAddr(node, getAddress(addr));
    await tx.wait();
    console.log('  addr set:', tx.hash);
    console.log('  addr now:', await resolver.addr(node));
}
console.log('\nDone.');
