// Pure planning for clawback-retired-programs.mjs: decodes the retired agreement, proposal_pledge and
// proposal_market accounts by their vendored IDLs (backend/scripts/clawback-idl/, trimmed from git:
// d65c1408f for the lens-set generation ESJ1/5RvX/9S7j, 52d7d3eed for the single-lens generation
// Gtdge/1jES/GDYn; ugt 95sje from branch blockchains-update 7e2453c79; proposal_nft 3WsVS from 79278ae78)
// and plans which instructions return devnet USDC and escrowed SOL to our wallets.
// No RPC and no keys here: the script feeds it a snapshot of decoded accounts and token balances.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import web3 from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IDL_DIR = path.resolve(HERE, '../clawback-idl');
export const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Each generation's market and pledge programs read only that generation's agreement program. */
export const GENERATIONS = [
    { name: 'lens-set', agreement: 'ESJ1w3rpzXtUXcZFgRfzHYRBzcrT7HeCychLNXvdBeYH', pledge: '5RvXB53atCdCkDEydpvgUDz4Ph6uFUVyMgpjdSzNwXAq', market: '9S7jXSkWyDYF1W95E8JYDwjpqR9tfXZiMKc6L3NGgJ71' },
    { name: 'single-lens', agreement: 'GtdgeRH89f2qLj4j4v6NcecWSr6RDPP9y4TMfPCGA5jQ', pledge: '1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g', market: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB' },
    // The `ugt` program of branch blockchains-update (7e2453c79): agreements with the same cancel/expire rules, no markets or pledges.
    { name: 'ugt', agreement: '95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9', idlPrefix: 'ugt' },
];
/** proposal_nft (79278ae78, v3 layout): pre-agreement proposals that hold SOL in `sol_balance`. */
export const PROPOSAL_NFT = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const IDL_FILE = { agreement: 'agreement', pledge: 'proposal_pledge', market: 'proposal_market' };

/** programId → { role, generation, label, idlFile } for the eight retired programs. */
export const PROGRAMS = Object.fromEntries([
    ...GENERATIONS.flatMap(gen => ['agreement', 'pledge', 'market'].filter(role => gen[role]).map(role => [
        gen[role], { role, generation: gen.name, label: `${role}_${gen[role].slice(0, 4)}`, idlFile: `${gen.idlPrefix ?? IDL_FILE[role]}.${gen[role].slice(0, 4)}.json` }
    ])),
    [PROPOSAL_NFT, { role: 'proposal_nft', generation: 'proposal-nft', label: 'proposal_nft_3WsV', idlFile: 'proposal_nft.3WsV.json' }],
]);

/** Owners of subject accounts the retired programs can no longer read (they were created before the agreement program). */
const KNOWN_OWNERS = { [PROPOSAL_NFT]: 'proposal_nft (pre-agreement proposals)' };
/** External markets that nobody resolved from court evidence settle VOID after this (proposal_market). */
export const EXTERNAL_RESOLUTION_TIMEOUT = 90 * 86_400;
/** LMSR kind 1: a proposed outcome can be finalized this long after it was proposed. */
export const CHALLENGE_SECONDS = 48 * 3600;
const SIDE_NO = 0, SIDE_YES = 1, OUTCOME_VOID = 2;
const LMSR_KIND_PROPOSAL = 0;

export function loadIdls(dir = IDL_DIR) {
    const idls = new Map();
    for (const [programId, info] of Object.entries(PROGRAMS)) {
        const idl = JSON.parse(fs.readFileSync(path.join(dir, info.idlFile), 'utf8'));
        if (idl.address !== programId) throw new Error(`${info.idlFile} is for ${idl.address}, expected ${programId}`);
        idls.set(programId, idl);
    }
    return idls;
}

// ---------------------------------------------------------------- borsh by IDL

function readType(idl, type, buf, offset) {
    switch (type) {
        case 'pubkey': return [new web3.PublicKey(buf.subarray(offset, offset + 32)).toBase58(), need(buf, offset, 32)];
        case 'bool': return [buf.readUInt8(offset) !== 0, offset + 1];
        case 'u8': return [buf.readUInt8(offset), offset + 1];
        case 'u16': return [buf.readUInt16LE(offset), offset + 2];
        case 'u32': return [buf.readUInt32LE(offset), offset + 4];
        case 'u64': return [buf.readBigUInt64LE(offset), offset + 8];
        case 'i64': return [buf.readBigInt64LE(offset), offset + 8];
        case 'string': {
            const length = buf.readUInt32LE(offset);
            return [buf.subarray(offset + 4, need(buf, offset + 4, length)).toString('utf8'), offset + 4 + length];
        }
        default: break;
    }
    if (type.array) {
        const [inner, count] = type.array;
        if (inner === 'u8') return [Buffer.from(buf.subarray(offset, need(buf, offset, count))).toString('hex'), offset + count];
        const out = [];
        for (let i = 0; i < count; i++) { let value; [value, offset] = readType(idl, inner, buf, offset); out.push(value); }
        return [out, offset];
    }
    if (type.option) {
        if (buf.readUInt8(offset) === 0) return [null, offset + 1];
        return readType(idl, type.option, buf, offset + 1);
    }
    if (type.vec) {
        const count = buf.readUInt32LE(offset); offset += 4; const out = [];
        for (let i = 0; i < count; i++) { let value; [value, offset] = readType(idl, type.vec, buf, offset); out.push(value); }
        return [out, offset];
    }
    if (type.defined) {
        const def = idl.types.find(t => t.name === type.defined.name);
        if (!def) throw new Error(`IDL has no type ${type.defined.name}`);
        if (def.type.kind === 'enum') {
            const index = buf.readUInt8(offset);
            const variant = def.type.variants[index];
            if (!variant || variant.fields) throw new Error(`${def.name}: unsupported variant ${index}`);
            return [variant.name, offset + 1];
        }
        return readStruct(idl, def.type.fields, buf, offset);
    }
    throw new Error(`unsupported IDL type ${JSON.stringify(type)}`);
}
function need(buf, offset, length) {
    if (offset + length > buf.length) throw new RangeError(`account data ends at ${buf.length}, field needs ${offset + length}`);
    return offset + length;
}
function readStruct(idl, fields, buf, offset) {
    const out = {};
    for (const field of fields) [out[field.name], offset] = readType(idl, field.type, buf, offset);
    return [out, offset];
}

/** Decode one account by its Anchor discriminator: { type, data } or { type, error } or { type: null }. */
export function decodeAccount(idl, raw) {
    const buf = Buffer.from(raw);
    const account = idl.accounts.find(a => a.discriminator.every((byte, i) => buf[i] === byte));
    if (!account) return { type: null, error: 'unknown discriminator' };
    const def = idl.types.find(t => t.name === account.name);
    try {
        const [data] = readStruct(idl, def.type.fields, buf, 8);
        return { type: account.name, data };
    } catch (error) {
        return { type: account.name, error: `undecodable ${account.name} (${buf.length} bytes): ${error.message}` };
    }
}

/** Encode a struct by the IDL (tests build mocked accounts with it). */
export function encodeAccount(idl, name, value) {
    const account = idl.accounts.find(a => a.name === name);
    const def = idl.types.find(t => t.name === name);
    const parts = [Buffer.from(account.discriminator)];
    const write = (type, v) => {
        if (type === 'pubkey') return parts.push(new web3.PublicKey(v).toBuffer());
        if (type === 'bool' || type === 'u8') return parts.push(Buffer.from([Number(v)]));
        if (type === 'u16') { const b = Buffer.alloc(2); b.writeUInt16LE(Number(v)); return parts.push(b); }
        if (type === 'u32') { const b = Buffer.alloc(4); b.writeUInt32LE(Number(v)); return parts.push(b); }
        if (type === 'u64') { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return parts.push(b); }
        if (type === 'i64') { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return parts.push(b); }
        if (type === 'string') { const s = Buffer.from(v ?? '', 'utf8'); const b = Buffer.alloc(4); b.writeUInt32LE(s.length); return parts.push(b, s); }
        if (type.vec) {
            const list = Array.isArray(v) ? v : [];
            const b = Buffer.alloc(4); b.writeUInt32LE(list.length); parts.push(b);
            for (const item of list) write(type.vec, item);
            return undefined;
        }
        if (type.array) {
            const [inner, count] = type.array;
            if (inner === 'u8') return parts.push(Buffer.from((typeof v === 'string' ? v : '').padEnd(count * 2, '0'), 'hex'));
            for (let i = 0; i < count; i++) write(inner, v?.[i] ?? SYSTEM_PROGRAM);
            return undefined;
        }
        const inner = idl.types.find(t => t.name === type.defined.name);
        if (inner.type.kind === 'enum') return parts.push(Buffer.from([Math.max(0, inner.type.variants.findIndex(x => x.name === v))]));
        for (const f of inner.type.fields) write(f.type, v?.[f.name]);
        return undefined;
    };
    for (const field of def.type.fields) write(field.type, value[field.name] ?? defaultFor(field.type));
    return Buffer.concat(parts);
}
function defaultFor(type) {
    if (type === 'pubkey') return SYSTEM_PROGRAM;
    if (type === 'u64' || type === 'i64') return 0n;
    if (type === 'string') return '';
    return 0;
}

// ---------------------------------------------------------------- program rules (mirrors of the Rust)

/** proposal_market::payout_amount (parimutuel and external markets). */
export function payoutAmount(side, amount, yesPool, noPool, outcome) {
    if (outcome === OUTCOME_VOID) return amount;
    const [winning, losing] = outcome === SIDE_YES ? [yesPool, noPool] : [noPool, yesPool];
    if (winning === 0n) return amount;
    if (side !== outcome) return 0n;
    return (amount * (winning + losing)) / winning;
}
/** lmsr_market::lmsr_payout. */
export function lmsrPayout(side, shares, outcome) {
    if (outcome === OUTCOME_VOID) return shares / 2n;
    return side === outcome ? shares : 0n;
}
/** lmsr_market::lmsr_obligation. */
export function lmsrObligation(qYes, qNo, outcome) {
    if (outcome === SIDE_YES) return qYes;
    if (outcome === SIDE_NO) return qNo;
    return qYes / 2n + qNo / 2n;
}
const statusOutcome = status => (status === 'Executed' ? SIDE_YES : SIDE_NO);
export const outcomeName = outcome => ['NO', 'YES', 'VOID'][outcome] ?? String(outcome);

// ---------------------------------------------------------------- planning

/**
 * Plan the recovery from a snapshot.
 * @param snapshot.now          unix seconds
 * @param snapshot.ours         Map wallet pubkey → key name (our keypairs)
 * @param snapshot.accounts     Map pubkey → { program, lamports, type, data?, error? } for every account of the eight programs
 * @param snapshot.balances     Map token account pubkey → bigint amount (absent: the account does not exist)
 * @param snapshot.owners       Map pubkey → owner program (or null when missing) for referenced accounts outside `accounts`
 * @returns {{ steps, unrecoverable, foreign, stats }}
 *   steps: ordered, dependencies first; when 'now' or 'later' (with `at`, unix seconds)
 */
export function buildPlan({ now, ours, accounts, balances = new Map(), owners = new Map() }) {
    const steps = [];
    const stepById = new Map();
    const unrecoverable = [];
    const foreign = [];
    const isOurs = key => ours.has(key);
    const byProgram = new Map();
    for (const [key, account] of accounts) {
        if (!byProgram.has(account.program)) byProgram.set(account.program, []);
        byProgram.get(account.program).push([key, account]);
    }
    const ofType = (program, type) => (byProgram.get(program) ?? []).filter(([, a]) => a.type === type && a.data);
    const balance = key => balances.get(key) ?? 0n;

    const addStep = step => {
        if (stepById.has(step.id)) return stepById.get(step.id);
        const full = { dependsOn: [], returns: [], signer: null, at: null, ...step };
        steps.push(full); stepById.set(full.id, full);
        return full;
    };
    const lost = (entry) => unrecoverable.push({ usdc: 0n, lamports: 0n, ...entry });
    const later = (...times) => Math.max(...times.filter(t => t != null));

    for (const gen of GENERATIONS) {
        const agreementLabel = PROGRAMS[gen.agreement].label;

        /** How the agreement reaches a terminal status: { terminal, status, executedAt } | { step } | { never }. Emits its step. */
        const agreementGate = (agreementKey, beneficiary) => {
            const account = accounts.get(agreementKey);
            if (!account || account.program !== gen.agreement) {
                const owner = account ? account.program : owners.get(agreementKey);
                const ownerName = KNOWN_OWNERS[owner] ?? PROGRAMS[owner]?.label ?? owner;
                return { never: `subject ${agreementKey} is ${owner ? `owned by ${ownerName}` : 'missing'}, not the ${agreementLabel} agreement program this ${gen.name} program reads` };
            }
            if (!account.data) return { never: `subject agreement ${agreementKey}: ${account.error}` };
            const a = account.data;
            if (a.status !== 'Active') return { terminal: true, status: a.status, executedAt: Number(a.executed_at) };
            const deadline = Number(a.deadline);
            const deadlinePassed = deadline !== 0 && now > deadline;
            const returns = a.escrow_lamports > 0n && isOurs(a.authority) ? [{ wallet: a.authority, usdc: 0n, lamports: a.escrow_lamports, mint: null }] : [];
            const base = { program: gen.agreement, generation: gen.name, target: agreementKey, returns,
                foreignLamports: a.escrow_lamports > 0n && !isOurs(a.authority) ? a.escrow_lamports : 0n };
            let step;
            if (deadlinePassed) {
                step = addStep({ ...base, id: `expire:${agreementKey}`, action: 'expire', when: 'now', accounts: { agreement: agreementKey, authority: a.authority },
                    note: isOurs(a.authority) ? undefined : `permissionless expire of a foreign sponsor's agreement, to unblock ${beneficiary}` });
            } else if (isOurs(a.authority) && a.decision === 'Pending') {
                step = addStep({ ...base, id: `cancel:${agreementKey}`, action: 'cancel', when: 'now', signer: a.authority, accounts: { agreement: agreementKey, authority: a.authority } });
            } else if (deadline !== 0) {
                step = addStep({ ...base, id: `expire:${agreementKey}`, action: 'expire', when: 'later', at: deadline + 1, accounts: { agreement: agreementKey, authority: a.authority },
                    reason: `deadline ${iso(deadline)} not passed; ${isOurs(a.authority) ? 'decision already Satisfied, so the sponsor cannot cancel' : 'sponsor is not one of our wallets'}` });
            } else {
                return { never: `agreement ${agreementKey} has no deadline and ${isOurs(a.authority) ? 'its decision is Satisfied (cancel refused)' : 'its sponsor is not ours'}` };
            }
            return { step, status: step.action === 'cancel' ? 'Cancelled' : 'Expired' };
        };

        // 1. Escrowed SOL of our own Active agreements.
        for (const [key, account] of ofType(gen.agreement, 'Agreement')) {
            const a = account.data;
            if (a.status !== 'Active' || a.escrow_lamports === 0n) continue;
            if (!isOurs(a.authority)) { foreign.push({ program: gen.agreement, account: key, lamports: a.escrow_lamports, usdc: 0n }); continue; }
            const gate = agreementGate(key, 'its sponsor');
            if (gate.never) lost({ program: gen.agreement, action: 'cancel/expire', account: key, wallet: a.authority, lamports: a.escrow_lamports, reason: gate.never });
        }

        // 2. Markets.
        const positionsByMarket = new Map();
        for (const [key, account] of ofType(gen.market, 'Position')) {
            const list = positionsByMarket.get(account.data.market) ?? [];
            list.push({ key, ...account.data });
            positionsByMarket.set(account.data.market, list);
        }
        const openOurs = list => (list ?? []).filter(p => isOurs(p.owner) && !p.claimed && p.amount > 0n);

        const claimSteps = (action, marketKey, market, mine, outcome, resolution, label) => {
            let left = balance(market.vault);
            for (const p of mine) {
                let payout = action === 'claim_lmsr' ? lmsrPayout(p.side, p.amount, outcome) : payoutAmount(p.side, p.amount, market.yes_pool, market.no_pool, outcome);
                if (payout === 0n) { lost({ program: gen.market, action, account: p.key, wallet: p.owner, reason: `${label}: position on ${outcomeName(p.side)} loses (outcome ${outcomeName(outcome)})` }); continue; }
                let note;
                if (payout > left) { note = `vault holds ${left}, payout ${payout}`; payout = left; }
                left -= payout;
                if (payout === 0n) { lost({ program: gen.market, action, account: p.key, wallet: p.owner, reason: `${label}: vault is empty` }); continue; }
                addStep({ id: `${action}:${p.key}`, action, program: gen.market, generation: gen.name, target: p.key, signer: p.owner,
                    when: resolution?.when ?? 'now', at: resolution?.at ?? null, dependsOn: resolution ? [resolution.id] : [], note,
                    accounts: { market: marketKey, position: p.key, vault: market.vault, claimer_token_account: ata(p.owner, market.stake_mint), claimer: p.owner },
                    returns: [{ wallet: p.owner, usdc: payout, lamports: 0n, mint: market.stake_mint }] });
            }
            return left;
        };
        const foreignOnly = (marketKey, market, list) => {
            const held = balance(market.vault);
            if (held > 0n || (list ?? []).length) foreign.push({ program: gen.market, account: marketKey, usdc: held, lamports: 0n, positions: (list ?? []).length });
        };

        for (const [marketKey, account] of ofType(gen.market, 'Market')) {
            const m = account.data;
            const list = positionsByMarket.get(marketKey);
            const mine = openOurs(list);
            if (!mine.length) { foreignOnly(marketKey, m, list); continue; }
            let outcome; let resolution = null;
            if (m.resolved) outcome = m.outcome;
            else {
                const gate = agreementGate(m.proposal, `market ${marketKey}`);
                if (gate.never) { for (const p of mine) lost({ program: gen.market, action: 'claim', account: p.key, wallet: p.owner, usdc: p.amount, reason: gate.never }); continue; }
                outcome = gate.terminal ? statusOutcome(gate.status) : SIDE_NO;
                resolution = addStep({ id: `resolve:${marketKey}`, action: 'resolve', program: gen.market, generation: gen.name, target: marketKey,
                    when: gate.step?.when ?? 'now', at: gate.step?.at ?? null, dependsOn: gate.step ? [gate.step.id] : [],
                    accounts: { market: marketKey, proposal: m.proposal } });
            }
            claimSteps('claim', marketKey, m, mine, outcome, resolution, 'parimutuel market');
        }

        for (const [marketKey, account] of ofType(gen.market, 'ExternalMarket')) {
            const m = account.data;
            const list = positionsByMarket.get(marketKey);
            const mine = openOurs(list);
            if (!mine.length) { foreignOnly(marketKey, m, list); continue; }
            let outcome; let resolution = null;
            if (m.resolved) outcome = m.outcome;
            else {
                const voidAt = Number(m.closes_at) + EXTERNAL_RESOLUTION_TIMEOUT + 1;
                outcome = OUTCOME_VOID;
                resolution = addStep({ id: `void_external:${marketKey}`, action: 'void_external', program: gen.market, generation: gen.name, target: marketKey,
                    when: now >= voidAt ? 'now' : 'later', at: now >= voidAt ? null : voidAt, accounts: { market: marketKey },
                    reason: now >= voidAt ? undefined : 'unresolved court market: VOID (full refunds) only after its 90-day resolution timeout; resolve_external needs a court attestation and is not attempted' });
            }
            claimSteps('claim_external', marketKey, m, mine, outcome, resolution, 'external market');
        }

        for (const [marketKey, account] of ofType(gen.market, 'LmsrMarket')) {
            const m = account.data;
            const list = positionsByMarket.get(marketKey);
            const mine = openOurs(list);
            const creatorOurs = isOurs(m.creator);
            if (!mine.length && !creatorOurs) { foreignOnly(marketKey, m, list); continue; }
            const graceEnd = Number(m.closes_at) + Number(m.grace_seconds);
            let outcome; let resolution = null; let never = null;
            if (m.resolved) outcome = m.outcome;
            else if (m.kind === LMSR_KIND_PROPOSAL) {
                const subject = accounts.get(m.proposal);
                const settlesByGrace = now > graceEnd && subject?.program === gen.agreement && subject.data?.status === 'Active';
                // Past grace an Active agreement already settles NO: no agreement step (foreign or ours) is needed.
                const gate = settlesByGrace ? { terminal: false, step: { when: 'now' } } : agreementGate(m.proposal, `market ${marketKey}`);
                if (gate.never) never = gate.never;
                else if (gate.terminal) {
                    outcome = gate.status === 'Executed' ? (gate.executedAt <= Number(m.closes_at) ? SIDE_YES : SIDE_NO) : SIDE_NO;
                    resolution = addStep({ id: `resolve_lmsr:${marketKey}`, action: 'resolve_lmsr', program: gen.market, generation: gen.name, target: marketKey, when: 'now',
                        accounts: { market: marketKey, proposal: m.proposal, schema: m.schema } });
                } else {
                    outcome = SIDE_NO;
                    const viaGrace = settlesByGrace;
                    const viaGate = !viaGrace && gate.step.when === 'now';
                    resolution = addStep({ id: `resolve_lmsr:${marketKey}`, action: 'resolve_lmsr', program: gen.market, generation: gen.name, target: marketKey,
                        when: viaGrace || viaGate ? 'now' : 'later', at: viaGrace || viaGate ? null : Math.min(graceEnd + 1, gate.step.at),
                        dependsOn: !viaGrace && viaGate ? [gate.step.id] : [],
                        accounts: { market: marketKey, proposal: m.proposal, schema: m.schema } });
                }
            } else {
                // Kind 1 (recipe): absent evidence proposes NO after grace; finalize after the challenge window.
                let proposedAt = Number(m.resolved_at);
                let resolveStep = null;
                outcome = proposedAt ? m.outcome : SIDE_NO;
                if (!proposedAt) {
                    const resolveAt = now > graceEnd ? null : graceEnd + 1;
                    resolveStep = addStep({ id: `resolve_lmsr:${marketKey}`, action: 'resolve_lmsr', program: gen.market, generation: gen.name, target: marketKey,
                        when: resolveAt ? 'later' : 'now', at: resolveAt, accounts: { market: marketKey, proposal: m.proposal, schema: m.schema },
                        note: 'recipe market without evidence: proposes NO by absence (permissionless), final after the 48 h challenge window' });
                    proposedAt = resolveAt ?? now;
                }
                const finalizeAt = proposedAt + CHALLENGE_SECONDS + 1;
                resolution = addStep({ id: `finalize_lmsr:${marketKey}`, action: 'finalize_lmsr', program: gen.market, generation: gen.name, target: marketKey,
                    when: now >= finalizeAt ? 'now' : 'later', at: now >= finalizeAt ? null : finalizeAt, dependsOn: resolveStep ? [resolveStep.id] : [],
                    accounts: { market: marketKey }, reason: now >= finalizeAt ? undefined : '48 h challenge window of the proposed outcome' });
            }
            if (never) {
                for (const p of mine) lost({ program: gen.market, action: 'claim_lmsr', account: p.key, wallet: p.owner, usdc: p.amount, reason: never });
                if (creatorOurs) lost({ program: gen.market, action: 'reclaim_seed', account: marketKey, wallet: m.creator, usdc: balance(m.vault), reason: never });
                continue;
            }
            claimSteps('claim_lmsr', marketKey, m, mine, outcome, resolution, 'LMSR market');
            if (creatorOurs) {
                // reclaim_seed pays vault − (obligation − paid_out); claims lower both sides equally, so order does not matter.
                const owed = lmsrObligation(m.q_yes, m.q_no, outcome) - m.paid_out;
                const vault = balance(m.vault);
                const amount = vault - (owed > 0n ? owed : 0n);
                if (amount <= 0n) lost({ program: gen.market, action: 'reclaim_seed', account: marketKey, wallet: m.creator, reason: `nothing beyond what positions are owed (vault ${vault}, owed ${owed})` });
                else {
                    const mineClaimIds = mine.map(p => `claim_lmsr:${p.key}`).filter(id => stepById.has(id));
                    addStep({ id: `reclaim_seed:${marketKey}`, action: 'reclaim_seed', program: gen.market, generation: gen.name, target: marketKey, signer: m.creator,
                        when: resolution?.when ?? 'now', at: resolution?.at ?? null, dependsOn: [...(resolution ? [resolution.id] : []), ...mineClaimIds],
                        accounts: { market: marketKey, vault: m.vault, creator_token_account: ata(m.creator, m.stake_mint), creator: m.creator },
                        returns: [{ wallet: m.creator, usdc: amount, lamports: 0n, mint: m.stake_mint }] });
                }
            }
        }

        // 3. Donation escrows (proposal_pledge). Pledge commitments are unfunded: nothing to recover.
        const escrows = new Map(ofType(gen.pledge, 'DonationEscrow'));
        const released = new Set();
        for (const [escrowKey, account] of escrows) {
            const e = account.data;
            if (e.released || !isOurs(e.beneficiary) || balance(e.vault) === 0n) continue;
            const subject = accounts.get(e.proposal);
            if (subject?.program === gen.agreement && subject.data?.status === 'Executed') {
                released.add(escrowKey);
                addStep({ id: `release_donations:${escrowKey}`, action: 'release_donations', program: gen.pledge, generation: gen.name, target: escrowKey, when: 'now',
                    accounts: { escrow: escrowKey, proposal: e.proposal, mint: e.mint, vault: e.vault, beneficiary: e.beneficiary, beneficiary_token_account: ata(e.beneficiary, e.mint), releaser: 'PAYER' },
                    returns: [{ wallet: e.beneficiary, usdc: balance(e.vault), lamports: 0n, mint: e.mint }] });
            }
        }
        const donationsByEscrow = new Map();
        for (const [key, account] of ofType(gen.pledge, 'DonationPosition')) {
            const d = account.data;
            if (d.refunded || d.amount === 0n) continue;
            if (!isOurs(d.owner)) { const list = donationsByEscrow.get(d.escrow) ?? []; list.push(d.amount); donationsByEscrow.set(d.escrow, list); continue; }
            const escrow = escrows.get(d.escrow);
            const lose = (reason, usdc = d.amount) => lost({ program: gen.pledge, action: 'refund_donation', account: key, wallet: d.owner, usdc, reason });
            if (!escrow) { lose(`escrow ${d.escrow} not found among ${PROGRAMS[gen.pledge].label} accounts`); continue; }
            const e = escrow.data;
            // Not a loss in the vault: already paid out, or paid to our sponsor wallet by release_donations.
            if (e.released) { lose(`agreement executed: donations were already released to its sponsor${isOurs(e.beneficiary) ? ' (one of our wallets)' : ''}`, 0n); continue; }
            if (released.has(d.escrow)) { lose('agreement executed: donations go to its sponsor, one of our wallets (counted under release_donations)', 0n); continue; }
            const gate = agreementGate(e.proposal, `donation ${key}`);
            if (gate.never) { lose(gate.never); continue; }
            if (gate.terminal && gate.status === 'Executed') { lose(`agreement executed; donations release to its sponsor ${e.beneficiary}, not ours`); continue; }
            addStep({ id: `refund_donation:${key}`, action: 'refund_donation', program: gen.pledge, generation: gen.name, target: key, signer: d.owner,
                when: gate.step?.when ?? 'now', at: gate.step?.at ?? null, dependsOn: gate.step ? [gate.step.id] : [],
                accounts: { escrow: d.escrow, proposal: e.proposal, position: key, vault: e.vault, donor_token_account: ata(d.owner, e.mint), donor: d.owner },
                returns: [{ wallet: d.owner, usdc: d.amount, lamports: 0n, mint: e.mint }] });
        }
        for (const [escrowKey, amounts] of donationsByEscrow) foreign.push({ program: gen.pledge, account: escrowKey, usdc: amounts.reduce((s, x) => s + x, 0n), lamports: 0n });
    }

    // 4. proposal_nft: SOL locked in a proposal returns to its owner (cancel while Active, reclaim once
    // Expired), or is distributed once Executed. Markets and pledges on these proposals cannot resolve
    // (the retired market/pledge programs read only agreement accounts): they are listed as lost above.
    for (const [key, account] of ofType(PROPOSAL_NFT, 'Proposal')) {
        const p = account.data;
        if (p.sol_balance === 0n) continue;
        const base = { program: PROPOSAL_NFT, generation: 'proposal-nft', target: key, when: 'now', returns: [{ wallet: p.owner, usdc: 0n, lamports: p.sol_balance, mint: null }] };
        if (p.status === 'Executed' && !p.accepted_parcels.length && isOurs(p.owner)) {
            addStep({ ...base, id: `distribute_funds:${key}`, action: 'distribute_funds', accounts: { proposal: key }, remaining: [{ pubkey: p.owner, isWritable: true }],
                note: 'executed by verdict with no accepted parcel: the whole balance returns to the owner' });
        } else if (!isOurs(p.owner) && p.status !== 'Executed') {
            foreign.push({ program: PROPOSAL_NFT, account: key, usdc: 0n, lamports: p.sol_balance });
        } else if (p.status === 'Active') {
            addStep({ ...base, id: `cancel_and_refund:${key}`, action: 'cancel_and_refund', signer: p.owner, accounts: { proposal: key, owner: p.owner } });
        } else if (p.status === 'Expired') {
            addStep({ ...base, id: `reclaim_expired_funds:${key}`, action: 'reclaim_expired_funds', signer: p.owner, accounts: { proposal: key, owner: p.owner } });
        } else {
            lost({ program: PROPOSAL_NFT, action: 'distribute_funds', account: key, wallet: p.owner, lamports: p.sol_balance,
                reason: p.status === 'Executed' ? `executed with ${p.accepted_parcels.length} accepted parcel(s): distribution over acceptance records is not planned` : `${p.status} proposal still holds sol_balance` });
        }
    }

    // A step waits for its latest dependency.
    for (const step of steps) {
        for (const id of step.dependsOn) {
            const dep = stepById.get(id);
            if (dep.when === 'later') { step.when = 'later'; step.at = later(step.at, dep.at); step.reason ??= `waits for ${dep.action} ${dep.target}`; }
        }
    }
    return { steps, unrecoverable, foreign };
}

const ata = (owner, mint) => getAssociatedTokenAddressSync(new web3.PublicKey(mint), new web3.PublicKey(owner), true).toBase58();
export const iso = unix => new Date(unix * 1000).toISOString().replace('.000Z', 'Z');

/** Whether a step's effect is already on chain, from the freshly decoded target (and the vault balance for reclaim_seed). */
export function stepDone(step, target, vaultBalance) {
    if (!target?.data) return false;
    const d = target.data;
    switch (step.action) {
        case 'cancel': case 'expire': return d.status !== 'Active';
        case 'resolve': case 'void_external': case 'finalize_lmsr': return d.resolved === true;
        case 'resolve_lmsr': return d.resolved === true || Number(d.resolved_at) !== 0;
        case 'claim': case 'claim_external': case 'claim_lmsr': return d.claimed === true;
        case 'refund_donation': return d.refunded === true;
        case 'cancel_and_refund': case 'reclaim_expired_funds': case 'distribute_funds': return d.sol_balance === 0n;
        case 'release_donations': return d.released === true;
        case 'reclaim_seed': {
            if (!d.resolved) return false;
            const owed = lmsrObligation(d.q_yes, d.q_no, d.outcome) - d.paid_out;
            return (vaultBalance ?? 0n) - (owed > 0n ? owed : 0n) <= 0n;
        }
        default: return false;
    }
}

/** Steps to run: those matching --only (or the given ids), with every dependency, then the first `max` of them in plan order. */
export function selectSteps(steps, { only = null, max = Infinity, ids = null } = {}) {
    const byId = new Map(steps.map(s => [s.id, s]));
    const matches = step => !only || only.some(o => PROGRAMS[step.program]?.label === o || PROGRAMS[step.program]?.role === o
        || PROGRAMS[step.program]?.generation === o || step.program.startsWith(o));
    const chosen = new Set();
    const add = step => { if (chosen.has(step.id)) return; for (const id of step.dependsOn) add(byId.get(id)); chosen.add(step.id); };
    for (const step of steps) if (step.when === 'now' && (ids ? ids.includes(step.id) : matches(step))) add(step);
    const ordered = steps.filter(s => chosen.has(s.id));
    return ordered.slice(0, max);
}

/** Totals per program, per wallet, now and later. Amounts are bigint base units (USDC 6 decimals, lamports). */
export function summarize(plan, ours) {
    const programs = {};
    const wallets = {};
    const bucket = program => (programs[PROGRAMS[program]?.label ?? program] ??= {
        now: { steps: {}, usdc: 0n, lamports: 0n }, later: { steps: {}, usdc: 0n, lamports: 0n, earliest: null, latest: null },
        never: { count: 0, usdc: 0n, lamports: 0n, reasons: {} }, foreign: { accounts: 0, usdc: 0n, lamports: 0n } });
    for (const step of plan.steps) {
        const b = bucket(step.program)[step.when];
        b.steps[step.action] = (b.steps[step.action] ?? 0) + 1;
        if (step.when === 'later') { b.earliest = b.earliest == null ? step.at : Math.min(b.earliest, step.at); b.latest = Math.max(b.latest ?? 0, step.at); }
        for (const r of step.returns) {
            if (r.mint && r.mint !== USDC_MINT) continue;
            b.usdc += r.usdc; b.lamports += r.lamports;
            const w = (wallets[ours.get(r.wallet) ?? r.wallet] ??= { now: { usdc: 0n, lamports: 0n }, later: { usdc: 0n, lamports: 0n } });
            w[step.when].usdc += r.usdc; w[step.when].lamports += r.lamports;
        }
    }
    for (const u of plan.unrecoverable) {
        const b = bucket(u.program).never;
        b.count += 1; b.usdc += u.usdc; b.lamports += u.lamports;
        const reason = u.reason.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, '…').replace(/\d{4}-\d\d-\d\dT[\d:]+Z/g, '<date>').replace(/\d+/g, 'n');
        b.reasons[reason] = (b.reasons[reason] ?? 0) + 1;
    }
    for (const f of plan.foreign) { const b = bucket(f.program).foreign; b.accounts += 1; b.usdc += f.usdc; b.lamports += f.lamports; }
    return { programs, wallets };
}

export const fmtUsdc = units => (Number(units) / 1e6).toFixed(2);
export const fmtSol = lamports => (Number(lamports) / 1e9).toFixed(4);
