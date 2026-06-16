// Option B: set on-chain records for the apex names on the hybrid OffchainResolver
// so parcels.urbangametheory.eth / proposals.urbangametheory.eth resolve to the
// NFT contracts (addr) + a description/url, fully on-chain. Signed by the
// resolver owner (the deployer wallet).
//
//   DEPLOYER_PRIVATE_KEY    resolver owner (required)
//   ENS_RESOLVER_ADDRESS    hybrid resolver (default: the deployed one)
//   MAINNET_RPC_URL         optional RPC override
import { JsonRpcProvider, Wallet, Contract, namehash, isAddress, getBytes, hexlify } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const RESOLVER = process.env.ENS_RESOLVER_ADDRESS || '0x72684C772d8Db1D8A6Db00B511ab9dA02bfB1a4B';
const rpc = process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const pk = process.env.DEPLOYER_PRIVATE_KEY;
const APP_URL = 'https://urbangametheory.xyz';
// ENSIP-11 coinType for the contracts' actual chain (Base Sepolia, 84532).
const BASE_SEPOLIA_COINTYPE = (1n << 31n) | 84532n;

const APEX = [
    { name: 'parcels.urbangametheory.eth', addr: '0x191Bb541E185f8C4fBF1eF4CE12a28acCFA6b35d', description: 'Urban Game Theory — Parcel NFT' },
    { name: 'proposals.urbangametheory.eth', addr: '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709', description: 'Urban Game Theory — Proposal NFT' },
];

if (!pk) { console.error('Set DEPLOYER_PRIVATE_KEY (the resolver owner).'); process.exit(1); }
if (!isAddress(RESOLVER)) { console.error('Bad ENS_RESOLVER_ADDRESS'); process.exit(1); }

const provider = new JsonRpcProvider(rpc, 1, { staticNetwork: true });
const wallet = new Wallet(pk, provider);
const resolver = new Contract(RESOLVER, [
    'function owner() view returns (address)',
    'function setAddr(bytes32 node, address a)',
    'function setAddr(bytes32 node, uint256 coinType, bytes a)',
    'function setText(bytes32 node, string key, string value)',
    'function addr(bytes32 node) view returns (address)',
    'function addr(bytes32 node, uint256 coinType) view returns (bytes)',
], wallet);

const owner = await resolver.owner();
console.log('signer        :', wallet.address);
console.log('resolver owner:', owner);
console.log('resolver      :', RESOLVER);
if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error('\nSigner is not the resolver owner.');
    process.exit(1);
}

for (const a of APEX) {
    const node = namehash(a.name);
    console.log(`\n${a.name} -> ${a.addr}`);
    let tx = await resolver['setAddr(bytes32,address)'](node, a.addr); await tx.wait(); console.log('  eth addr set:', tx.hash);
    tx = await resolver['setAddr(bytes32,uint256,bytes)'](node, BASE_SEPOLIA_COINTYPE, getBytes(a.addr)); await tx.wait(); console.log('  base-sepolia addr set (ENSIP-11)');
    tx = await resolver.setText(node, 'description', a.description); await tx.wait(); console.log('  description set');
    tx = await resolver.setText(node, 'url', APP_URL); await tx.wait(); console.log('  url set');
    console.log('  eth addr   :', await resolver['addr(bytes32)'](node));
    console.log('  base addr  :', hexlify(await resolver['addr(bytes32,uint256)'](node, BASE_SEPOLIA_COINTYPE)));
}
console.log('\nDone.');
