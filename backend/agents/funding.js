import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { sendAndConfirmPolling } from './solana-send.js';
import { usdcToAtomic } from './bettor.js';
import { updateRun } from './ledger.js';
import { getAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction, TokenAccountNotFoundError } from '@solana/spl-token';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SOURCE_PERSONA = 'densifier-01';
const MIN_BOT_SOL = 0.05 * LAMPORTS_PER_SOL;
const TARGET_BOT_SOL = 0.2 * LAMPORTS_PER_SOL;
const MAX_TRANSFER = 0.2 * LAMPORTS_PER_SOL;
const SOURCE_RESERVE = 0.5 * LAMPORTS_PER_SOL;
const FEE_ALLOWANCE = 0.005 * LAMPORTS_PER_SOL;

const personas = JSON.parse(fs.readFileSync(new URL('./personas.json', import.meta.url), 'utf8')).personas;
const byName = new Map(personas.map((entry) => [entry.name, entry]));

function configuredPersona(persona) {
    const name = typeof persona === 'string' ? persona : persona?.name;
    const suppliedWallet = typeof persona === 'object' && persona ? persona.wallet : undefined;
    const configured = name ? byName.get(name) : personas.find(item => item.wallet && item.wallet === suppliedWallet);
    const hasSuppliedWallet = typeof persona === 'object' && persona && Object.hasOwn(persona, 'wallet');
    if (!configured?.wallet || (hasSuppliedWallet && suppliedWallet !== configured.wallet)) {
        throw new Error('SOL funding is limited to configured bot wallets');
    }
    return configured;
}

function lamports(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid wallet balance; no SOL transfer can be planned');
    return value;
}

function configuredSource() {
    const source = byName.get(SOURCE_PERSONA);
    if (!source?.wallet || !source.keypairPath) throw new Error('Configured SOL top-up wallet is unavailable');
    return source;
}

async function loadConfiguredFunder(source) {
    try {
        const keyPath = source.keypairPath.startsWith('~/')
            ? path.join(os.homedir(), source.keypairPath.slice(2))
            : source.keypairPath;
        const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8')));
        return Keypair.fromSecretKey(secret);
    } catch {
        throw new Error(`Unable to load configured SOL top-up wallet ${source.wallet}`);
    }
}

/**
 * Top up a configured bot wallet from densifier-01 on devnet when it falls below 0.05 SOL.
 * The funding signer is loaded only after all read-only eligibility and reserve checks pass.
 */
export async function ensureBotSolFunding({
    connection,
    persona,
    enabled = process.env.AGENT_SOL_FUNDING_ENABLED === '1',
    loadFunder = loadConfiguredFunder,
    sendAndConfirm = sendAndConfirmPolling
}) {
    if (!enabled) return { status: 'skipped', reason: 'disabled' };

    const recipient = configuredPersona(persona);
    const source = configuredSource();
    if (recipient.wallet === source.wallet) {
        return { status: 'skipped', reason: 'source-wallet', wallet: recipient.wallet };
    }

    const target = new PublicKey(recipient.wallet);
    const sourceAddress = new PublicKey(source.wallet);
    const currentBalance = lamports(await connection.getBalance(target, 'confirmed'));
    if (currentBalance >= MIN_BOT_SOL) {
        return { status: 'skipped', reason: 'sufficient-balance', wallet: recipient.wallet, balanceLamports: currentBalance };
    }

    let genesisHash;
    try {
        genesisHash = await connection.getGenesisHash();
    } catch {
        throw new Error('Cannot verify Solana devnet; no SOL was transferred');
    }
    if (genesisHash !== DEVNET_GENESIS_HASH) {
        throw new Error('SOL auto-funding is restricted to Solana devnet; no SOL was transferred');
    }

    const amount = Math.min(TARGET_BOT_SOL - currentBalance, MAX_TRANSFER);
    const sourceBalance = lamports(await connection.getBalance(sourceAddress, 'confirmed'));
    if (sourceBalance < amount + SOURCE_RESERVE + FEE_ALLOWANCE) {
        throw new Error(`SOL top-up wallet ${source.wallet} has insufficient devnet SOL; fund this address before retrying`);
    }

    let funder;
    try {
        funder = await loadFunder(source);
    } catch {
        throw new Error(`Unable to load configured SOL top-up wallet ${source.wallet}`);
    }
    if (funder?.publicKey?.toBase58() !== source.wallet) {
        throw new Error(`Configured SOL top-up wallet signer does not match ${source.wallet}`);
    }

    const transaction = new Transaction().add(SystemProgram.transfer({
        fromPubkey: sourceAddress,
        toPubkey: target,
        lamports: amount
    }));
    const signature = await sendAndConfirm(connection, transaction, [funder], { commitment: 'confirmed' });

    const [finalRecipientBalance, finalSourceBalance] = await Promise.all([
        connection.getBalance(target, 'confirmed'),
        connection.getBalance(sourceAddress, 'confirmed')
    ]);
    if (lamports(finalRecipientBalance) < TARGET_BOT_SOL) {
        throw new Error(`SOL top-up transaction ${signature} confirmed, but ${recipient.wallet} remains below 0.2 SOL`);
    }
    if (lamports(finalSourceBalance) < SOURCE_RESERVE) {
        throw new Error(`SOL top-up transaction ${signature} confirmed, but reserve at ${source.wallet} is below 0.5 SOL`);
    }

    return {
        status: 'funded',
        wallet: recipient.wallet,
        sourceWallet: source.wallet,
        amountLamports: amount,
        signature,
        balanceLamports: finalRecipientBalance
    };
}


export const BOT_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const MIN_BOT_USDC = 100_000n;
const TARGET_BOT_USDC = 500_000n;
const SOURCE_USDC_RESERVE = 1_000_000n;

async function readUsdcBalance(connection, wallet) {
    const account = getAssociatedTokenAddressSync(BOT_USDC_MINT, new PublicKey(wallet));
    try {
        const token = await getAccount(connection, account, 'confirmed');
        if (!token.mint.equals(BOT_USDC_MINT) || !token.owner.equals(new PublicKey(wallet))) {
            throw new Error('Bot USDC account has an unexpected mint or owner');
        }
        return token.amount;
    } catch (error) {
        if (error instanceof TokenAccountNotFoundError) return 0n;
        throw error;
    }
}

function usdcBalance(value) {
    if (typeof value !== 'bigint' || value < 0n) throw new Error('Invalid USDC balance; no token transfer can be planned');
    return value;
}

// All scheduled actor processes share this source wallet. Hold one database-session lock across
// the balance recheck, signed transfer and readback so simultaneous top-ups respect its reserve.
async function withUsdcFundingLock(pool, sourceWallet, work) {
    if (!pool || typeof pool.connect !== 'function') throw new Error('USDC funding requires the agent database pool');
    const client = await pool.connect();
    const key = `ugt-bot-usdc:${sourceWallet}`;
    let locked = false;
    let releaseError;
    try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
        locked = true;
        return await work();
    } catch (error) {
        releaseError = error;
        throw error;
    } finally {
        try {
            if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
        } catch (error) { releaseError = error; throw error; }
        finally { client.release(releaseError); }
    }
}

/** Top up a configured actor only when its next token-spending action needs USDC. */
export async function ensureBotUsdcFunding({
    connection, persona, pool, requiredAtomic, maxActionAtomic = TARGET_BOT_USDC,
    enabled = process.env.AGENT_USDC_FUNDING_ENABLED === '1',
    readBalance = readUsdcBalance,
    loadFunder = loadConfiguredFunder,
    sendAndConfirm = sendAndConfirmPolling
}) {
    if (!enabled) return { status: 'skipped', reason: 'disabled' };
    const recipient = configuredPersona(persona);
    const source = configuredSource();
    if (typeof maxActionAtomic !== 'bigint' || maxActionAtomic <= 0n || typeof requiredAtomic !== 'bigint' || requiredAtomic <= 0n || requiredAtomic > maxActionAtomic) {
        throw new Error('USDC funding requires a positive action amount within its explicit cap (default 0.5 USDC)');
    }
    const targetBalance = requiredAtomic > TARGET_BOT_USDC ? requiredAtomic : TARGET_BOT_USDC;
    if (recipient.wallet === source.wallet) {
        if (requiredAtomic > TARGET_BOT_USDC) {
            const balance = usdcBalance(await readBalance(connection, source.wallet));
            if (balance - requiredAtomic < SOURCE_USDC_RESERVE) throw new Error(`USDC funding wallet ${source.wallet} cannot seed its market while retaining 1 test USDC; fund the source wallet before retrying`);
        }
        return { status: 'skipped', reason: 'source-wallet', wallet: recipient.wallet };
    }
    const minimum = requiredAtomic > MIN_BOT_USDC ? requiredAtomic : MIN_BOT_USDC;
    const balance = usdcBalance(await readBalance(connection, recipient.wallet));
    if (balance >= minimum) return { status: 'skipped', reason: 'sufficient-balance', wallet: recipient.wallet };
    if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) {
        throw new Error('USDC auto-funding is restricted to Solana devnet; no tokens were transferred');
    }
    return withUsdcFundingLock(pool, source.wallet, async () => {
        const current = usdcBalance(await readBalance(connection, recipient.wallet));
        if (current >= minimum) return { status: 'skipped', reason: 'sufficient-balance', wallet: recipient.wallet };
        const amount = targetBalance - current;
        const sourceBalance = usdcBalance(await readBalance(connection, source.wallet));
        if (sourceBalance - amount < SOURCE_USDC_RESERVE) {
            throw new Error(`USDC funding wallet ${source.wallet} cannot top up ${recipient.wallet} while retaining 1 test USDC; fund the source wallet before retrying`);
        }
        if (lamports(await connection.getBalance(new PublicKey(source.wallet), 'confirmed')) < SOURCE_RESERVE + FEE_ALLOWANCE) {
            throw new Error(`USDC funding wallet ${source.wallet} needs devnet SOL for fees and token-account rent`);
        }
        const funder = await loadFunder(source);
        if (funder?.publicKey?.toBase58() !== source.wallet) throw new Error('Configured USDC funding signer does not match the source wallet');
        const target = new PublicKey(recipient.wallet);
        const sourceToken = getAssociatedTokenAddressSync(BOT_USDC_MINT, funder.publicKey);
        const targetToken = getAssociatedTokenAddressSync(BOT_USDC_MINT, target);
        const transaction = new Transaction()
            .add(createAssociatedTokenAccountIdempotentInstruction(funder.publicKey, targetToken, target, BOT_USDC_MINT))
            .add(createTransferCheckedInstruction(sourceToken, BOT_USDC_MINT, targetToken, funder.publicKey, amount, 6));
        const signature = await sendAndConfirm(connection, transaction, [funder], { commitment: 'confirmed' });
        const [afterRecipient, afterSource] = await Promise.all([
            readBalance(connection, recipient.wallet), readBalance(connection, source.wallet)
        ]);
        if (usdcBalance(afterRecipient) < targetBalance || usdcBalance(afterSource) < SOURCE_USDC_RESERVE) {
            throw new Error(`USDC top-up transaction ${signature} confirmed but balance readback failed; inspect this receipt before retrying`);
        }
        return { status: 'funded', wallet: recipient.wallet, sourceWallet: source.wallet,
            mint: BOT_USDC_MINT.toBase58(), amountAtomic: amount.toString(), balanceAtomic: afterRecipient.toString(), signature };
    });
}


// Wallet maintenance is separate from the actor's stake/donation budget. Pledges, claims and
// revocations transfer no USDC out of the wallet and must never trigger a token top-up.
export async function fundBotAction({ action, runId, ...options }) {
    if (!['stake', 'donate'].includes(action?.type)) return { status: 'skipped', reason: 'no-token-spend' };
    const enabled = options.enabled ?? (process.env.AGENT_USDC_FUNDING_ENABLED === '1');
    if (enabled && (typeof runId !== 'string' || !runId || typeof options.pool?.query !== 'function')) {
        throw new Error('USDC action funding requires a run ID and ledger pool before transferring');
    }
    const receipt = await ensureBotUsdcFunding({ ...options, enabled, requiredAtomic: usdcToAtomic(String(action.amount)) });
    if (receipt.status === 'funded') {
        await updateRun(options.pool, runId, { summaryPatch: { usdcFunding: receipt } });
        console.log(`[${new Date().toISOString()}] USDC funding — status=completed wallet=${receipt.wallet} amountAtomic=${receipt.amountAtomic} tx=${receipt.signature}`);
    }
    return receipt;
}
