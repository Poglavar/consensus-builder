import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { sendAndConfirmPolling } from './solana-send.js';

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
