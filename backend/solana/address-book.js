// Human labels for the Solana addresses this system touches. The transaction explorer derives
// everything from the chain, so an address is all it ever has; this module turns those base58
// strings into "agent densifier-01 USDC account" and tells the scanner which ones to watch.
// Pure: the only input is what the caller passes in (env, personas, fee payer).

import { PublicKey } from '@solana/web3.js';

// Our four Anchor programs on devnet. Kept here (not read from the IDLs) so the book stands
// alone — the decoder matches instruction data against the IDLs, the book only names things.
export const OUR_PROGRAMS = Object.freeze([
    { address: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1', name: 'parcel_nft', label: 'parcel_nft program' },
    { address: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg', name: 'proposal_nft', label: 'proposal_nft program' },
    { address: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', name: 'proposal_market', label: 'proposal_market program' },
    { address: '1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g', name: 'proposal_pledge', label: 'proposal_pledge program' }
]);

// Solana's own programs. These are never watched (every transaction on the cluster touches them);
// they exist in the book purely so an instruction can be labelled "System Program".
export const SYSTEM_PROGRAMS = Object.freeze([
    { address: '11111111111111111111111111111111', name: 'system', label: 'System Program' },
    { address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', name: 'spl-token', label: 'SPL Token' },
    { address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', name: 'spl-associated-token-account', label: 'Associated Token Program' },
    { address: 'ComputeBudget111111111111111111111111111111', name: 'compute-budget', label: 'Compute Budget Program' },
    { address: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', name: 'spl-memo', label: 'Memo Program' },
    { address: 'BPFLoaderUpgradeab1e11111111111111111111111', name: 'bpf-upgradeable-loader', label: 'BPF Upgradeable Loader' }
]);

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const DEFAULT_X402_FEE_PAYER = 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5';

// Kinds the signature scanner polls. Programs are included, but only OUR programs — polling the
// System Program would return the whole cluster.
export const WATCHED_KINDS = Object.freeze(['program', 'wallet', 'token-account', 'fee-payer']);

// "ABCDEF…WXYZ" — what a UI shows when there is no label. Short addresses are returned as-is.
export function shortAddress(address) {
    if (typeof address !== 'string' || address.length <= 9) return address ?? null;
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

// The associated token account of `owner` for `mint`, derived the same way the SPL client does.
export function deriveAssociatedTokenAddress(owner, mint) {
    const [pda] = PublicKey.findProgramAddressSync(
        [new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM_ID).toBuffer(), new PublicKey(mint).toBuffer()],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
    );
    return pda.toBase58();
}

function normalizePersonas(personas) {
    if (Array.isArray(personas)) return personas;
    if (personas && Array.isArray(personas.personas)) return personas.personas;
    return [];
}

/**
 * Build the address book.
 *
 * @param {object} opts
 * @param {object} [opts.env]           process.env-shaped object; X402_PAY_TO names the treasury.
 * @param {object|Array} [opts.personas] personas.json contents, or just its `personas` array.
 * @param {string} [opts.x402FeePayer]   the facilitator wallet that pays settlement fees.
 */
export function buildAddressBook({ env = {}, personas = [], x402FeePayer = DEFAULT_X402_FEE_PAYER } = {}) {
    const entries = [];
    const byAddress = new Map();

    const add = (entry) => {
        if (!entry.address || byAddress.has(entry.address)) return;
        const full = { kind: null, label: null, ...entry };
        byAddress.set(full.address, full);
        entries.push(full);
    };

    for (const program of OUR_PROGRAMS) add({ ...program, kind: 'program', ours: true });
    for (const program of SYSTEM_PROGRAMS) add({ ...program, kind: 'program', ours: false });

    add({ address: DEVNET_USDC_MINT, label: 'USDC (devnet)', kind: 'mint', symbol: 'USDC', decimals: 6 });

    const treasury = typeof env.X402_PAY_TO === 'string' ? env.X402_PAY_TO.trim() : '';
    if (treasury) {
        add({ address: treasury, label: 'treasury wallet', kind: 'wallet' });
        add({
            address: deriveAssociatedTokenAddress(treasury, DEVNET_USDC_MINT),
            label: 'treasury USDC account',
            kind: 'token-account',
            owner: treasury,
            mint: DEVNET_USDC_MINT
        });
    }

    if (x402FeePayer) add({ address: x402FeePayer, label: 'x402 facilitator (fee payer)', kind: 'fee-payer' });

    for (const persona of normalizePersonas(personas)) {
        const wallet = typeof persona?.wallet === 'string' ? persona.wallet.trim() : '';
        const name = persona?.name;
        if (!wallet || !name) continue;
        add({ address: wallet, label: `agent ${name}`, kind: 'wallet', persona: name });
        add({
            address: deriveAssociatedTokenAddress(wallet, DEVNET_USDC_MINT),
            label: `agent ${name} USDC account`,
            kind: 'token-account',
            owner: wallet,
            mint: DEVNET_USDC_MINT,
            persona: name
        });
    }

    const labelFor = (address) => {
        const entry = byAddress.get(address);
        return {
            address: address ?? null,
            label: entry ? entry.label : null,
            kind: entry ? entry.kind : null,
            short: shortAddress(address)
        };
    };

    return {
        entries,
        labelFor,
        // Full entry (carries owner/mint/symbol/decimals/persona) or null — the decoder needs the
        // extras that labelFor deliberately leaves out.
        entryFor: (address) => byAddress.get(address) || null,
        mintFor: (address) => {
            const entry = byAddress.get(address);
            return entry && entry.kind === 'mint' ? { symbol: entry.symbol ?? null, decimals: entry.decimals ?? null } : null;
        },
        treasury: treasury || null,
        feePayer: x402FeePayer || null,
        usdcMint: DEVNET_USDC_MINT
    };
}

// Addresses worth polling getSignaturesForAddress on: our programs, every wallet, every token
// account, and the facilitator fee payer. Mints and Solana's own programs are excluded.
// The legend ("who is who"): every labelled party incl. the facilitator's fee payer, which is
// worth naming on a row even though it is never scanned (see watchedAddresses).
export function legendAddresses(book) {
    const entries = book?.entries ?? [];
    return entries
        .filter((entry) => WATCHED_KINDS.includes(entry.kind) && (entry.kind !== 'program' || entry.ours === true))
        .map((entry) => entry.address);
}

// The scan set: our programs, our wallets and their token accounts. The x402 facilitator's fee
// payer is deliberately NOT scanned even though it is labelled — it signs every x402 payment on
// devnet by anyone, so scanning it pulls strangers' test payments into our history (three
// self-payments from an unrelated wallet showed up that way on 2026-09-16).
export function watchedAddresses(book) {
    const entries = book?.entries ?? [];
    return entries
        .filter((entry) => WATCHED_KINDS.includes(entry.kind) && entry.kind !== 'fee-payer' && (entry.kind !== 'program' || entry.ours === true))
        .map((entry) => entry.address);
}
