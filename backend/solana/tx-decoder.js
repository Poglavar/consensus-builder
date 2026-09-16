// Turns a `getParsedTransaction` response into the explorer's transaction shape: who did what, to
// whom, for how much. jsonParsed instructions come pre-decoded by the RPC; our own Anchor programs
// do not, so their instruction data is matched against the IDL discriminators and the args read
// back with a small borsh reader. Pure — the caller supplies the address book and the IDLs.

import fs from 'fs';
import path from 'path';
import { formatAtomicAmount } from '../utils/x402-payment.js';
import { shortAddress } from './address-book.js';

const IDL_FILES = ['parcel_nft.json', 'proposal_nft.json', 'proposal_market.json'];

const LAMPORTS_DECIMALS = 9;

// Excluded from the per-transaction `programs`/`actions` chip lists: every transaction carries
// compute-budget instructions, and the x402 memo is a payment nonce, not an action. Both are still
// present in full under `instructions[]`.
const NOISE_PROGRAM_NAMES = new Set(['compute-budget', 'spl-memo']);

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = new Map([...B58_ALPHABET].map((char, i) => [char, i]));
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function decodeBase58(str) {
    if (typeof str !== 'string' || str.length === 0) return null;
    // Starts empty, not [0]: a leading '1' is a zero BYTE, counted by the loop below. Seeding a
    // zero here adds a 33rd byte to an all-'1' address such as the System Program.
    const bytes = [];
    for (const char of str) {
        const value = B58_INDEX.get(char);
        if (value === undefined) return null;
        let carry = value;
        for (let i = 0; i < bytes.length; i++) {
            carry += bytes[i] * 58;
            bytes[i] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
    return Buffer.from(bytes.reverse());
}

export function encodeBase58(buf) {
    if (!buf || buf.length === 0) return '';
    // Same reason as decodeBase58: the leading zero bytes are emitted as '1' below, so the digit
    // accumulator must start empty or an all-zero key gains a 33rd character.
    const digits = [];
    for (const byte of buf) {
        let carry = byte;
        for (let i = 0; i < digits.length; i++) {
            carry += digits[i] << 8;
            digits[i] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let out = '';
    for (let i = 0; i < buf.length && buf[i] === 0; i++) out += '1';
    for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
    return out;
}

// Anchor's built-in IDL-account instruction tag: the first 8 bytes of sha256("anchor:idl")
// reversed (little-endian u64), as seen on every `anchor deploy` follow-up transaction.
const ANCHOR_IDL_IX_DISCRIMINATOR = '40f4bc78a7e9690a';

/**
 * Read the three program IDLs from `dir`. Returns lookups by program address and by program name;
 * each instruction is indexed by the hex of its 8-byte Anchor discriminator.
 */
export function loadIdls(dir) {
    const byAddress = new Map();
    const byName = new Map();
    const list = [];

    for (const file of IDL_FILES) {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        const name = raw.metadata?.name || raw.name || path.basename(file, '.json');
        const address = raw.address || raw.metadata?.address || null;
        const instructions = new Map();
        for (const ix of raw.instructions || []) {
            if (!Array.isArray(ix.discriminator)) continue;
            instructions.set(Buffer.from(ix.discriminator).toString('hex'), {
                name: ix.name,
                accounts: (ix.accounts || []).map((account) => account.name),
                args: (ix.args || []).map((arg) => ({ name: arg.name, type: arg.type }))
            });
        }
        const entry = { name, address, instructions };
        list.push(entry);
        byName.set(name, entry);
        if (address) byAddress.set(address, entry);
    }

    return { byAddress, byName, list };
}

// --- borsh arg reading -------------------------------------------------------------------------

class BorshReader {
    constructor(buf) {
        this.buf = buf;
        this.offset = 0;
    }

    take(n) {
        if (this.offset + n > this.buf.length) throw new Error('instruction data ended early');
        const slice = this.buf.subarray(this.offset, this.offset + n);
        this.offset += n;
        return slice;
    }

    readScalar(type) {
        switch (type) {
            case 'u8': return this.take(1).readUInt8(0);
            case 'i8': return this.take(1).readInt8(0);
            case 'u16': return this.take(2).readUInt16LE(0);
            case 'u32': return this.take(4).readUInt32LE(0);
            case 'u64': return this.take(8).readBigUInt64LE(0).toString();
            case 'i64': return this.take(8).readBigInt64LE(0).toString();
            case 'bool': return this.take(1).readUInt8(0) !== 0;
            case 'pubkey':
            case 'publicKey': return encodeBase58(this.take(32));
            case 'string': {
                const len = this.take(4).readUInt32LE(0);
                return this.take(len).toString('utf8');
            }
            default: throw new Error(`unsupported IDL arg type "${JSON.stringify(type)}"`);
        }
    }

    readType(type) {
        if (typeof type === 'string') return this.readScalar(type);
        if (type && typeof type === 'object' && type.vec !== undefined) {
            const len = this.take(4).readUInt32LE(0);
            const out = [];
            for (let i = 0; i < len; i++) out.push(this.readType(type.vec));
            return out;
        }
        throw new Error(`unsupported IDL arg type "${JSON.stringify(type)}"`);
    }
}

function decodeArgs(idlInstruction, payload) {
    if (!idlInstruction.args.length) return { args: {}, argsError: null };
    const reader = new BorshReader(payload);
    const args = {};
    try {
        for (const arg of idlInstruction.args) args[arg.name] = reader.readType(arg.type);
        return { args, argsError: null };
    } catch (error) {
        // A type we cannot read desyncs everything after it, so the whole arg set is reported as
        // undecodable rather than half-truthfully.
        return { args: null, argsError: error.message };
    }
}

// --- helpers -----------------------------------------------------------------------------------

// The raw JSON-RPC response carries addresses as base58 strings, but @solana/web3.js hydrates
// accountKeys/programId/accounts into PublicKey objects before handing the transaction over. Every
// address is funnelled through here so both shapes decode identically.
export function toAddress(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value.toBase58 === 'function') return value.toBase58();
    return null;
}

function unwrapRpcTransaction(rpcTx) {
    if (rpcTx && !rpcTx.transaction && rpcTx.result) return rpcTx.result;
    return rpcTx;
}

function addressObject(book, address, extra = {}) {
    const base = book?.labelFor ? book.labelFor(address) : { address: address ?? null, label: null, kind: null, short: shortAddress(address) };
    return { ...base, ...extra };
}

function buildAccountMeta(accountKeys) {
    const meta = new Map();
    for (const key of accountKeys || []) {
        const address = toAddress(typeof key === 'object' && key !== null && 'pubkey' in key ? key.pubkey : key);
        if (!address) continue;
        meta.set(address, {
            signer: typeof key === 'object' ? Boolean(key.signer) : false,
            writable: typeof key === 'object' ? Boolean(key.writable) : false
        });
    }
    return meta;
}

// token account address -> { mint, owner, decimals }, read off pre/postTokenBalances so an
// unchecked `transfer` (which carries neither mint nor owner) can still be described properly.
function buildTokenAccountMap(rpcTx) {
    const keys = rpcTx?.transaction?.message?.accountKeys || [];
    const map = new Map();
    const balances = [...(rpcTx?.meta?.preTokenBalances || []), ...(rpcTx?.meta?.postTokenBalances || [])];
    for (const balance of balances) {
        const key = keys[balance.accountIndex];
        const address = toAddress(typeof key === 'object' && key !== null && 'pubkey' in key ? key.pubkey : key);
        if (!address) continue;
        map.set(address, {
            mint: balance.mint ?? null,
            owner: balance.owner ?? null,
            decimals: balance.uiTokenAmount?.decimals ?? null
        });
    }
    return map;
}

function tokenParty(book, tokenAccounts, address) {
    const owner = tokenAccounts.get(address)?.owner ?? book?.entryFor?.(address)?.owner ?? null;
    return addressObject(book, address, { owner: owner ? addressObject(book, owner) : null });
}

// The most human name available for an address: its label, else the shortened address.
function who(book, address) {
    if (!address) return 'unknown';
    const entry = book?.labelFor ? book.labelFor(address) : null;
    return entry?.label || shortAddress(address) || address;
}

// Prefer the owner behind a token account ("agent densifier-01") over the account itself.
function whoBehind(book, tokenAccounts, address) {
    const owner = tokenAccounts.get(address)?.owner ?? book?.entryFor?.(address)?.owner ?? null;
    if (owner) return who(book, owner);
    return who(book, address);
}

// --- amounts -----------------------------------------------------------------------------------

function extractAmount(ix, { book, tokenAccounts }) {
    const parsed = ix?.parsed;
    if (!parsed || typeof parsed !== 'object') return null;
    const info = parsed.info || {};

    if (ix.program === 'spl-token' && (parsed.type === 'transfer' || parsed.type === 'transferChecked')) {
        const source = toAddress(info.source);
        const destination = toAddress(info.destination);
        const mint = toAddress(info.mint)
            ?? tokenAccounts.get(source)?.mint
            ?? tokenAccounts.get(destination)?.mint
            ?? null;
        const known = mint ? book?.mintFor?.(mint) : null;
        const atomic = info.tokenAmount?.amount ?? (info.amount != null ? String(info.amount) : null);
        const decimals = info.tokenAmount?.decimals
            ?? tokenAccounts.get(source)?.decimals
            ?? tokenAccounts.get(destination)?.decimals
            ?? known?.decimals
            ?? null;
        const amount = info.tokenAmount?.uiAmountString
            ?? (atomic != null && decimals != null ? formatAtomicAmount(atomic, decimals) : null);
        return {
            kind: 'token',
            mint,
            symbol: known?.symbol ?? null,
            decimals,
            amount,
            amountAtomic: atomic,
            from: tokenParty(book, tokenAccounts, source),
            to: tokenParty(book, tokenAccounts, destination)
        };
    }

    if (ix.program === 'system' && parsed.type === 'transfer') {
        const atomic = info.lamports != null ? String(info.lamports) : null;
        return {
            kind: 'sol',
            mint: null,
            symbol: 'SOL',
            decimals: LAMPORTS_DECIMALS,
            amount: atomic != null ? formatAtomicAmount(atomic, LAMPORTS_DECIMALS) : null,
            amountAtomic: atomic,
            from: addressObject(book, toAddress(info.source), { owner: null }),
            to: addressObject(book, toAddress(info.destination), { owner: null })
        };
    }

    return null;
}

// --- instruction decoding ----------------------------------------------------------------------

function decodeInstruction(ix, { index, inner, parentIndex, book, idlsByAddress, accountMeta }) {
    const programId = toAddress(ix.programId);
    const bookEntry = book?.entryFor?.(programId) || null;
    const idl = idlsByAddress.get(programId) || null;
    const programName = ix.program ?? idl?.name ?? bookEntry?.name ?? null;
    const program = addressObject(book, programId, { name: programName });

    const decoded = {
        index,
        inner,
        parentIndex,
        program,
        action: null,
        args: null,
        accounts: []
    };

    const accountEntry = (role, address) => {
        const meta = accountMeta.get(address) || { signer: false, writable: false };
        return { role, ...addressObject(book, address), signer: meta.signer, writable: meta.writable };
    };

    if (typeof ix.parsed === 'string') {
        // spl-memo: the payload is the memo text itself, not an {info,type} object.
        decoded.action = 'memo';
        decoded.args = { memo: ix.parsed };
        return decoded;
    }

    if (ix.parsed && typeof ix.parsed === 'object') {
        decoded.action = ix.parsed.type ?? null;
        decoded.args = ix.parsed.info ?? null;
        // jsonParsed instructions name their accounts in `info` rather than listing them, so the
        // roles come from the info keys whose values are addresses.
        for (const [role, value] of Object.entries(ix.parsed.info || {})) {
            const address = toAddress(value);
            if (address && BASE58_RE.test(address)) decoded.accounts.push(accountEntry(role, address));
        }
        return decoded;
    }

    const addresses = (Array.isArray(ix.accounts) ? ix.accounts : []).map(toAddress).filter(Boolean);
    decoded.data = ix.data ?? null;

    if (idl && typeof ix.data === 'string') {
        const data = decodeBase58(ix.data);
        if (data && data.length >= 8) {
            const discriminator = data.subarray(0, 8).toString('hex');
            const idlInstruction = idl.instructions.get(discriminator);
            decoded.discriminator = discriminator;
            if (!idlInstruction && discriminator === ANCHOR_IDL_IX_DISCRIMINATOR) {
                // `anchor deploy` / `anchor idl` write the program's IDL into an on-chain account
                // through a built-in instruction no program IDL lists. Name it so the deploy's
                // follow-up transactions do not read as opaque calls.
                decoded.action = 'anchor_idl';
                decoded.args = {};
                decoded.accounts = addresses.map((address) => accountEntry(null, address));
                return decoded;
            }
            if (idlInstruction) {
                decoded.action = idlInstruction.name;
                const { args, argsError } = decodeArgs(idlInstruction, data.subarray(8));
                decoded.args = args;
                if (argsError) decoded.argsError = argsError;
                // Anchor appends `remaining_accounts` after the declared ones, so a longer list
                // still maps positionally. A SHORTER list means the deployed program is not the
                // build this IDL describes — positional names would then be fiction, so the roles
                // are dropped and the mismatch is reported instead.
                const declared = idlInstruction.accounts.length;
                if (addresses.length < declared) {
                    decoded.accountsWarning = `IDL declares ${declared} accounts, instruction supplied ${addresses.length} — roles not assigned`;
                    decoded.accounts = addresses.map((address) => accountEntry(null, address));
                } else {
                    if (addresses.length > declared) {
                        decoded.accountsWarning = `IDL declares ${declared} accounts, instruction supplied ${addresses.length} — extras are remaining_accounts`;
                    }
                    decoded.accounts = addresses.map((address, i) => accountEntry(idlInstruction.accounts[i] ?? null, address));
                }
                return decoded;
            }
        }
    }

    decoded.accounts = addresses.map((address) => accountEntry(null, address));
    return decoded;
}

// --- summary -----------------------------------------------------------------------------------

function accountAddress(decoded, role) {
    return decoded.accounts.find((account) => account.role === role)?.address ?? null;
}

// The party a sentence is about. When the IDL role is missing (older deployed build, see
// accountsWarning) fall back to the instruction's signer — whoever acted had to sign.
function actorAddress(decoded, role) {
    return accountAddress(decoded, role)
        ?? decoded.accounts.find((account) => account.signer)?.address
        ?? null;
}

// The instruction a human would name the transaction after. Compute-budget is never it; our own
// programs and program deploys outrank the plumbing (a deploy is preceded by a system createAccount).
function pickPrimary(topLevel, idlsByAddress) {
    const preferred = topLevel.find((decoded) => idlsByAddress.has(decoded.program.address)
        || decoded.program.name === 'bpf-upgradeable-loader');
    if (preferred) return preferred;
    return topLevel.find((decoded) => decoded.program.name !== 'compute-budget') || topLevel[0] || null;
}

function innerTokenAmount(primary, rawInner, ctx) {
    const group = (rawInner || []).find((entry) => entry.index === primary.index);
    for (const ix of group?.instructions || []) {
        const amount = extractAmount(ix, ctx);
        if (amount && amount.kind === 'token') return amount;
    }
    return null;
}

function buildSummary(primary, ctx) {
    const { book, tokenAccounts, feePayerAddress, rawInner, idlsByAddress, signature } = ctx;
    if (!primary) return `transaction ${shortAddress(signature) ?? 'unknown'}`;

    const name = primary.program.name;
    const action = primary.action;
    const args = primary.args || {};
    const label = (address) => who(book, address);

    if (name === 'spl-token' && (action === 'transfer' || action === 'transferChecked')) {
        const amount = extractAmount({ program: name, parsed: { type: action, info: args } }, ctx);
        const value = amount?.amount ?? amount?.amountAtomic ?? 'an unknown amount of';
        const symbol = amount?.symbol ?? 'tokens';
        const from = whoBehind(book, tokenAccounts, toAddress(args.source));
        const to = whoBehind(book, tokenAccounts, toAddress(args.destination));
        if (feePayerAddress && book?.feePayer && feePayerAddress === book.feePayer) {
            return `${from} paid ${value} ${symbol} to ${to} (x402 settlement, fee paid by x402 facilitator)`;
        }
        return `${from} sent ${value} ${symbol} to ${to}`;
    }

    if (name === 'system' && action === 'transfer') {
        const amount = extractAmount({ program: name, parsed: { type: action, info: args } }, ctx);
        return `${label(toAddress(args.source))} sent ${amount?.amount ?? '?'} SOL to ${label(toAddress(args.destination))}`;
    }

    if (name === 'spl-associated-token-account' && (action === 'createIdempotent' || action === 'create')) {
        const symbol = book?.mintFor?.(toAddress(args.mint))?.symbol ?? 'token';
        return `created ${symbol} account for ${label(toAddress(args.wallet))}`;
    }

    if (name === 'bpf-upgradeable-loader') {
        // A deploy is one `deployWithMaxDataLen` preceded by dozens of `write` chunks into a
        // temporary buffer account that no address book knows; name the chunks as what they are.
        if (action === 'write' || action === 'initializeBuffer') {
            const buffer = toAddress(args.account) ?? toAddress(args.bufferAccount);
            const who = label(toAddress(args.authority) ?? feePayerAddress);
            const what = action === 'write' ? 'uploaded a program chunk to' : 'initialized';
            return `${who} ${what} deploy buffer ${buffer ? shortAddress(buffer) : '(unknown)'}`;
        }
        const verb = action === 'deployWithMaxDataLen' ? 'deployed' : action === 'upgrade' ? 'upgraded' : action;
        const target = toAddress(args.programAccount);
        const programLabel = idlsByAddress.get(target)?.name ?? label(target);
        const authority = toAddress(args.authority) ?? toAddress(args.upgradeAuthority) ?? toAddress(args.payerAccount);
        return `program ${programLabel} ${verb} by ${label(authority)}`;
    }

    if (name === 'proposal_market') {
        const marketAddress = accountAddress(primary, 'market');
        const market = marketAddress ? label(marketAddress) : null;
        const inMarket = market ? ` in market ${market}` : '';
        const fromMarket = market ? ` from market ${market}` : '';
        if (action === 'stake') {
            const inner = innerTokenAmount(primary, rawInner, ctx);
            const amount = inner?.amount ?? (args.amount != null ? formatAtomicAmount(String(args.amount), 6) : null);
            const symbol = inner?.symbol ?? 'USDC';
            const side = Number(args.side) === 1 ? 'YES' : 'NO';
            return `${label(actorAddress(primary, 'staker'))} staked ${amount ?? '?'} ${symbol} on ${side}${inMarket}`;
        }
        if (action === 'create_market') {
            const vault = accountAddress(primary, 'vault');
            const proposalAddress = accountAddress(primary, 'proposal');
            const on = proposalAddress ? ` on proposal ${label(proposalAddress)}` : '';
            return `${label(actorAddress(primary, 'creator'))} opened a market${on}${vault ? ` (vault ${label(vault)})` : ''}`;
        }
        if (action === 'resolve') return market ? `market ${market} resolved` : 'market resolved';
        if (action === 'claim') {
            const inner = innerTokenAmount(primary, rawInner, ctx);
            const claimer = label(actorAddress(primary, 'claimer'));
            if (!inner) return `${claimer} claimed${fromMarket}`;
            return `${claimer} claimed ${inner.amount ?? inner.amountAtomic} ${inner.symbol ?? 'tokens'}${fromMarket}`;
        }
    }

    if (name === 'proposal_nft') {
        const proposalAddress = accountAddress(primary, 'proposal');
        const onProposal = proposalAddress ? ` on proposal ${label(proposalAddress)}` : '';
        if (action === 'mint_and_fund') {
            const parcels = Array.isArray(args.parcel_ids) && args.parcel_ids.length ? args.parcel_ids.join(',') : 'no parcels';
            const sol = args.sol_amount != null ? formatAtomicAmount(String(args.sol_amount), LAMPORTS_DECIMALS) : '?';
            return `${label(actorAddress(primary, 'owner'))} minted proposal for parcels ${parcels} funded with ${sol} SOL`;
        }
        if (action === 'accept_proposal') {
            return `${label(actorAddress(primary, 'accepter'))} accepted parcel ${args.parcel_id ?? '?'}${onProposal}`;
        }
        if (action === 'withdraw_acceptance') {
            return `${label(actorAddress(primary, 'withdrawer'))} withdrew acceptance of parcel ${args.parcel_id ?? '?'}${onProposal}`;
        }
        if (action === 'cancel_and_refund') {
            const target = proposalAddress ? `proposal ${label(proposalAddress)}` : 'a proposal';
            return `${label(actorAddress(primary, 'owner'))} cancelled ${target} and was refunded`;
        }
        if (action === 'contribute_funds') {
            const sol = args.amount != null ? formatAtomicAmount(String(args.amount), LAMPORTS_DECIMALS) : '?';
            return `${label(actorAddress(primary, 'contributor'))} contributed ${sol} SOL${onProposal ? ` to proposal ${label(proposalAddress)}` : ''}`;
        }
        if (action === 'distribute_funds') {
            return proposalAddress ? `proposal ${label(proposalAddress)} distributed its funds` : 'proposal funds distributed';
        }
        if (action === 'initialize') return `${label(actorAddress(primary, 'authority'))} initialized the proposal counter`;
    }

    if (name === 'parcel_nft') {
        const owner = label(actorAddress(primary, 'owner'));
        if (action === 'mint_parcel') return `${owner} minted parcel ${args.parcel_id ?? '?'}`;
        if (action === 'set_parcel_metadata_uri') {
            const parcel = accountAddress(primary, 'parcel');
            return `${owner} updated the metadata uri of parcel ${parcel ? label(parcel) : 'account'}`;
        }
    }

    const programLabel = name ?? shortAddress(primary.program.address) ?? 'an unknown program';
    if (action === 'anchor_idl') return `${label(feePayerAddress)} wrote the on-chain IDL of ${programLabel} (Anchor idl instruction)`;
    if (action) return `${label(feePayerAddress)} called ${action} on ${programLabel}`;
    return `${label(feePayerAddress)} sent a transaction to ${programLabel}`;
}

// --- entry point -------------------------------------------------------------------------------

/**
 * Decode one `getParsedTransaction` result into the explorer's `transactions[]` item.
 * Accepts either the RPC result object or the whole `{ jsonrpc, result }` envelope.
 */
export function decodeParsedTransaction(rpcTx, { book, idls } = {}) {
    const tx = unwrapRpcTransaction(rpcTx);
    if (!tx || !tx.transaction) return null;

    const idlsByAddress = idls?.byAddress instanceof Map
        ? idls.byAddress
        : (idls instanceof Map ? idls : new Map());
    const message = tx.transaction.message || {};
    const accountKeys = message.accountKeys || [];
    const accountMeta = buildAccountMeta(accountKeys);
    const tokenAccounts = buildTokenAccountMap(tx);
    const signature = tx.transaction.signatures?.[0] ?? null;
    const firstKey = accountKeys[0];
    const feePayerAddress = toAddress(typeof firstKey === 'object' && firstKey !== null && 'pubkey' in firstKey ? firstKey.pubkey : firstKey);
    const amountCtx = { book, tokenAccounts };

    const rawTop = message.instructions || [];
    const rawInner = tx.meta?.innerInstructions || [];
    const innerByParent = new Map(rawInner.map((entry) => [entry.index, entry.instructions || []]));

    const topLevel = [];
    const instructions = [];
    const amounts = [];

    rawTop.forEach((ix, index) => {
        const decoded = decodeInstruction(ix, { index, inner: false, parentIndex: null, book, idlsByAddress, accountMeta });
        topLevel.push(decoded);
        instructions.push(decoded);
        const amount = extractAmount(ix, amountCtx);
        if (amount) amounts.push(amount);

        (innerByParent.get(index) || []).forEach((innerIx, innerIndex) => {
            const innerDecoded = decodeInstruction(innerIx, {
                index: innerIndex,
                inner: true,
                parentIndex: index,
                book,
                idlsByAddress,
                accountMeta
            });
            instructions.push(innerDecoded);
            const innerAmount = extractAmount(innerIx, amountCtx);
            if (innerAmount) amounts.push(innerAmount);
        });
    });

    const meaningful = topLevel.filter((decoded) => !NOISE_PROGRAM_NAMES.has(decoded.program.name) && decoded.action !== null);
    const programs = [...new Set(meaningful.map((decoded) => decoded.program.name ?? shortAddress(decoded.program.address)))];
    const actions = [...new Set(meaningful.map((decoded) => decoded.action))];

    const primary = pickPrimary(topLevel, idlsByAddress);
    const failed = Boolean(tx.meta?.err);
    let summary = buildSummary(primary, {
        book,
        tokenAccounts,
        feePayerAddress,
        rawInner,
        idlsByAddress,
        signature
    });
    if (failed) summary = `${summary} (failed)`;

    return {
        signature,
        slot: tx.slot ?? null,
        blockTime: tx.blockTime ?? null,
        time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
        status: failed ? 'failed' : 'success',
        error: failed ? JSON.stringify(tx.meta.err) : null,
        feePayer: addressObject(book, feePayerAddress),
        feeLamports: tx.meta?.fee ?? null,
        feeSol: tx.meta?.fee != null ? formatAtomicAmount(String(tx.meta.fee), LAMPORTS_DECIMALS) : null,
        programs,
        actions,
        summary,
        amounts,
        instructions
    };
}
