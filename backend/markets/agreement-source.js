// Fresh, qualified chain evidence for dated agreement bets. An index pointer alone never authorizes
// a trade or a points payout: the CID, sponsor, network, program and deadline must match the account.
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { AgreementClient, AGREEMENT_PROGRAM_ID, createAgreementChain, agreementAccountOf, isPublicKey, ONCHAIN_STATUSES } from '../agreements/onchain.js';
import { CURRENT_AGREEMENTS_BY_ACCOUNTS_SQL } from '../agreements/current-plan-sql.js';

export const MARKET_LIQUIDITY = '100000000';
export const MARKET_GRACE_SECONDS = 0;
// Every LMSR liquidity b a canonical agreement market may carry: b = 100 devnet USDC before 2026-10-30,
// b = 5 for markets opened since (backend/agents/bettor.js DEFAULT_B, frontend/js/solana/market-bridge.js).
export const ACCEPTED_MARKET_LIQUIDITY = Object.freeze([5_000_000n, 100_000_000n]);

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

// getMultipleAccounts takes at most 100 accounts; one slot of each call is the clock sysvar.
const AGREEMENTS_PER_SNAPSHOT = 99;

// readAgreement(address) → the agreement's validated source, or throws. readAgreement.many(addresses)
// → Map(address → source | Error): one index query and one RPC call per 99 agreements, where the
// single reader would make one of each per agreement (the Bets world list reads ~250 of them).
export function createAgreementMarketSource(pool, { env = process.env, chain = createAgreementChain({ env }) } = {}) {
    async function readAgreements(addresses) {
        const unique = [...new Set(addresses)];
        if (unique.some(address => !isPublicKey(address))) {
            throw Object.assign(new Error('A canonical agreement account is required'), { status: 400 });
        }
        const { rows } = await pool.query(CURRENT_AGREEMENTS_BY_ACCOUNTS_SQL, [unique]);
        const result = new Map();
        const indexed = [];
        for (const address of unique) {
            const row = rows.find(item => item.onchain?.account === address && agreementAccountOf(item.cid, item.sponsor) === address);
            if (row) indexed.push({ address, row });
            else result.set(address, Object.assign(new Error('Published binding agreement not found'), { status: 404 }));
        }
        if (!indexed.length) return result;
        const connection = await chain.connection();
        for (let start = 0; start < indexed.length; start += AGREEMENTS_PER_SNAPSHOT) {
            const batch = indexed.slice(start, start + AGREEMENTS_PER_SNAPSHOT);
            // One bank snapshot: an old Active account plus the server's newer wall clock cannot
            // establish absence by a deadline. The chain's own clock must also have crossed it.
            const { context, value } = await connection.getMultipleAccountsInfoAndContext(
                [...batch.map(entry => new PublicKey(entry.address)), SYSVAR_CLOCK_PUBKEY], 'confirmed');
            const clock = value?.[batch.length];
            const chainTime = clock?.data && clock.data.length >= 40 ? Number(Buffer.from(clock.data).readBigInt64LE(32)) : null;
            batch.forEach(({ address, row }, index) => {
                try {
                    const info = value?.[index];
                    if (!info || info.owner?.toBase58() !== AGREEMENT_PROGRAM_ID || chainTime === null) {
                        throw Object.assign(new Error('Agreement and chain clock evidence are unavailable'), { status: 503 });
                    }
                    if (!Number.isSafeInteger(chainTime) || chainTime <= 0) throw Object.assign(new Error('Chain clock is invalid'), { status: 503 });
                    const account = AgreementClient.readAgreement(info.data, address);
                    result.set(address, validateAgreementSource(row, { account, address, slot: context.slot, chainTime }));
                } catch (error) {
                    result.set(address, error);
                }
            });
        }
        return result;
    }

    async function readAgreement(address) {
        if (!isPublicKey(address)) throw Object.assign(new Error('A canonical agreement account is required'), { status: 400 });
        const source = (await readAgreements([address])).get(address);
        if (source instanceof Error) throw source;
        return source;
    }
    readAgreement.many = readAgreements;
    return readAgreement;
}
