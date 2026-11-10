// Option B: set on-chain records for the parcels apex name on the hybrid OffchainResolver
// so parcels.urbangametheory.eth resolves to the ParcelAnchor contract (addr) + a
// description/url, fully on-chain. proposals.urbangametheory.eth names no contract
// (its records are agreements and designs by CID), so its addr records are cleared.
// Signed by the resolver owner (the deployer wallet).
//
//   DEPLOYER_PRIVATE_KEY    resolver owner (required)
//   PARCEL_ANCHOR_ADDR      default: the Base Sepolia ParcelAnchor
//   ENS_RESOLVER_ADDRESS    hybrid resolver (default: the deployed one)
//   MAINNET_RPC_URL         optional RPC override
import { JsonRpcProvider, Wallet, Contract, namehash, isAddress, getBytes, hexlify, ZeroAddress } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const RESOLVER = process.env.ENS_RESOLVER_ADDRESS || '0x72684C772d8Db1D8A6Db00B511ab9dA02bfB1a4B';
const rpc = process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const pk = process.env.DEPLOYER_PRIVATE_KEY;
const APP_URL = 'https://urbangametheory.xyz';
// ENSIP-11 coinType for the contract's actual chain (Base Sepolia, 84532).
const BASE_SEPOLIA_COINTYPE = (1n << 31n) | 84532n;

const APEX = [
    { name: 'parcels.urbangametheory.eth', addr: process.env.PARCEL_ANCHOR_ADDR || '0x6785a94694af9455C42F49849027736ABdd1aE2D', description: 'Urban Game Theory — parcel anchors' },
    { name: 'proposals.urbangametheory.eth', addr: ZeroAddress, description: 'Urban Game Theory — agreements and designs' },
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
    // An empty ENSIP-11 value clears the record (no contract), like the zero ETH address above.
    const baseValue = a.addr === ZeroAddress ? '0x' : getBytes(a.addr);
    tx = await resolver['setAddr(bytes32,uint256,bytes)'](node, BASE_SEPOLIA_COINTYPE, baseValue); await tx.wait(); console.log('  base-sepolia addr set (ENSIP-11)');
    tx = await resolver.setText(node, 'description', a.description); await tx.wait(); console.log('  description set');
    tx = await resolver.setText(node, 'url', APP_URL); await tx.wait(); console.log('  url set');
    console.log('  eth addr   :', await resolver['addr(bytes32)'](node));
    console.log('  base addr  :', hexlify(await resolver['addr(bytes32,uint256)'](node, BASE_SEPOLIA_COINTYPE)));
}
console.log('\nDone.');
