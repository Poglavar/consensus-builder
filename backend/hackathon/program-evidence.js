// Read-only deployment evidence. A timestamp is earned by observing the current devnet program and
// ProgramData accounts; generating a manifest never advances it. Hashes cover deployed bytes, not a
// claim that a local source tree reproduced that binary.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { DEVNET_GENESIS_HASH } from '../agreements/onchain.js';
import { OUR_PROGRAMS } from '../solana/address-book.js';
import { createRpcConnection } from '../solana/rpc.js';

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const NAMES = { agreement: 'Agreement', proposal_market: 'ProposalMarket', proposal_pledge: 'ProposalPledge', parcel_nft: 'ParcelNFT' };
export const PROOF_PROGRAMS = OUR_PROGRAMS.map(program => ({ name: NAMES[program.name], address: program.address }));
export const PROGRAM_EVIDENCE_TTL_MS = 15 * 60 * 1000;

export async function readProgramEvidence(connection, { now = () => Date.now(), programs = PROOF_PROGRAMS } = {}) {
    if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error('Expected Solana devnet');
    const programAccounts = await connection.getMultipleAccountsInfo(programs.map(program => new PublicKey(program.address)), 'confirmed');
    if (programAccounts.length !== programs.length) throw new Error('Incomplete program account response');
    const dataAddresses = programAccounts.map((account, index) => {
        if (!account?.executable || account.owner.toBase58() !== LOADER || account.data.length < 36 || account.data.readUInt32LE(0) !== 2) {
            throw new Error(`${programs[index].name} is not an upgradeable executable program`);
        }
        return new PublicKey(account.data.subarray(4, 36));
    });
    const dataAccounts = await connection.getMultipleAccountsInfo(dataAddresses, 'confirmed');
    if (dataAccounts.length !== programs.length) throw new Error('Incomplete ProgramData response');
    const observed = dataAccounts.map((account, index) => {
        if (!account || account.owner.toBase58() !== LOADER || account.data.length <= 45 || account.data.readUInt32LE(0) !== 3) {
            throw new Error(`${programs[index].name} has no valid ProgramData account`);
        }
        const slot = Number(account.data.readBigUInt64LE(4));
        if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error('Invalid deployment slot');
        return {
            ...programs[index], network: 'solana:devnet',
            programDataAddress: dataAddresses[index].toBase58(), lastDeployedSlot: slot,
            binarySha256: createHash('sha256').update(account.data.subarray(45)).digest('hex'),
            upgradeAuthority: account.data[12] === 1 ? new PublicKey(account.data.subarray(13, 45)).toBase58() : null,
            source: `https://explorer.solana.com/address/${dataAddresses[index].toBase58()}?cluster=devnet`
        };
    });
    return {
        state: 'verified', verifiedAt: new Date(now()).toISOString(),
        method: 'devnet RPC: executable owner, ProgramData address, deployment slot and SHA-256 of bytes after the 45-byte metadata header',
        programs: observed
    };
}

export function createProgramEvidenceReader({ env = process.env, connection, now = () => Date.now() } = {}) {
    let cached;
    let pending;
    return async () => {
        if (cached && now() - Date.parse(cached.verifiedAt) < PROGRAM_EVIDENCE_TTL_MS) return cached;
        if (!pending) {
            connection ??= createRpcConnection(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
            pending = readProgramEvidence(connection, { now }).then(result => (cached = result))
                .finally(() => { pending = null; });
        }
        return pending;
    };
}
