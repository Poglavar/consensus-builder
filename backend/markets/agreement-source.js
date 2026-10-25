// Fresh, qualified chain evidence for dated agreement bets. An index pointer alone never authorizes
// a trade or a points payout: the CID, sponsor, network, program and deadline must match the account.
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { AgreementClient, AGREEMENT_PROGRAM_ID, createAgreementChain, agreementAccountOf, isPublicKey, ONCHAIN_STATUSES } from '../agreements/onchain.js';

export const MARKET_LIQUIDITY = '100000000';
export const MARKET_GRACE_SECONDS = 0;

export function validateAgreementSource(row, observed) {
    if (!row || !observed?.account || observed.problem) throw Object.assign(new Error('Agreement chain evidence is unavailable'), { status: 503 });
    const account = observed.account;
    const sponsor = row.sponsor;
    if (row.onchain?.chain !== 'solana' || row.onchain.cluster !== 'devnet' ||
        agreementAccountOf(row.cid, sponsor) !== observed.address || row.onchain.account !== observed.address ||
        account.cid !== row.cid || account.authority !== sponsor) {
        throw Object.assign(new Error('Agreement identity does not match its chain account'), { status: 409 });
    }
    const chainStatus = ONCHAIN_STATUSES[account.statusCode];
    if (!chainStatus || !Number.isSafeInteger(account.deadline) || account.deadline <= 0) {
        throw Object.assign(new Error('A known agreement status and a dated agreement are required'), { status: 409 });
    }
    const indexDeadline = row.deadline instanceof Date ? row.deadline.getTime() : Date.parse(row.deadline || '');
    if (Math.floor(indexDeadline / 1000) !== account.deadline) throw Object.assign(new Error('Published and chain agreement deadlines differ'), { status: 409 });
    return {
        account: observed.address, cid: row.cid, city: row.city, sponsor,
        closesAt: account.deadline, graceSeconds: MARKET_GRACE_SECONDS,
        chainStatus, executedAt: account.executedAt || null,
        insiders: [account.authority, account.lens].filter(isPublicKey),
        observedSlot: observed.slot, chainTime: observed.chainTime
    };
}

export function createAgreementMarketSource(pool, { env = process.env, chain = createAgreementChain({ env }) } = {}) {
    return async function readAgreement(address) {
        if (!isPublicKey(address)) throw Object.assign(new Error('A canonical agreement account is required'), { status: 400 });
        const { rows } = await pool.query(`SELECT cid, city, deadline, content->>'sponsor' AS sponsor, onchain
            FROM consensus.agreement WHERE onchain->>'account' = $1`, [address]);
        const row = rows.find(item => agreementAccountOf(item.cid, item.sponsor) === address);
        if (!row) throw Object.assign(new Error('Published binding agreement not found'), { status: 404 });
        const connection = await chain.connection();
        // One bank snapshot: an old Active account plus the server's newer wall clock cannot
        // establish absence by a deadline. The chain's own clock must also have crossed it.
        const { context, value } = await connection.getMultipleAccountsInfoAndContext(
            [new PublicKey(address), SYSVAR_CLOCK_PUBKEY], 'confirmed');
        const [info, clock] = value || [];
        if (!info || info.owner?.toBase58() !== AGREEMENT_PROGRAM_ID || !clock?.data || clock.data.length < 40) {
            throw Object.assign(new Error('Agreement and chain clock evidence are unavailable'), { status: 503 });
        }
        const chainTime = Number(Buffer.from(clock.data).readBigInt64LE(32));
        if (!Number.isSafeInteger(chainTime) || chainTime <= 0) throw Object.assign(new Error('Chain clock is invalid'), { status: 503 });
        const account = AgreementClient.readAgreement(info.data, address);
        return validateAgreementSource(row, { account, address, slot: context.slot, chainTime });
    };
}
