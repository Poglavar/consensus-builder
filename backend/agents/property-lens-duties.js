// A round's lens member's property duties, signed by the proposer runner (run.mjs) with the lens
// member's own key (personas.json service.confirmsFundedRounds, key file on the host): for each
// executed apartment round of a developer it serves, state each buyer as the first holder of its flat
// (PropertyHolding-v1, basis developer); for each plot of its plot markets (plot-market.json), state the
// sole owner its devnet owner registry gives as first holder (basis registry); and, as the buyer's lens of committed property offers,
// confirm those whose seller its own statements name as holder (property-offer-signer.js confirmSale,
// the browser's check; the confirmation that completes both lenses pays out in the same transaction).
// Nothing else is confirmed: an offer it cannot confirm waits and expires. Every item is read before
// anything is signed, a repeat signs nothing, and one item's failure never stops the others.
import { createRequire } from 'node:module';
import { discoverAgreements, readAgreementStatuses } from './discovery.js';
import { readRoundInventory, readRoundsInventory } from './apartment-actions.js';
import { confirmSale, stateHolding } from './property-offer-signer.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { loadPlotMarkets, plotsOfMember } from './plot-market.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const Offer = require('../../frontend/js/property-offer-record.js');
const Statements = require('../../frontend/js/solana/property-statements.js').configure({ web3 });

// Executed rounds read per lens member and run (newest first); committed offers listed per run.
export const MAX_ROUNDS = 12;
const MAX_AWAITING = 100;

/** AGENT_PROPERTY_LENS_MAX_PER_RUN: transactions one lens member signs per run for these duties (default 12). */
export function propertyLensCap(env = process.env) {
    const raw = env.AGENT_PROPERTY_LENS_MAX_PER_RUN;
    const value = raw === undefined || raw === '' ? 12 : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`AGENT_PROPERTY_LENS_MAX_PER_RUN must be a whole number, got ${JSON.stringify(raw)}`);
    return value;
}

/**
 * The lens members this runner signs for (`memberKeys`) and the developers among `developers` whose
 * rounds name each (developer.lens, a lens-member persona's name or key): Map key → developer personas.
 */
export function lensMembersOfDevelopers(personas, developers, memberKeys) {
    const keyOf = name => personas.find(p => p.role === 'lens-member' && p.name === name)?.wallet ?? name;
    const out = new Map();
    for (const developer of developers.filter(p => p.role === 'developer' && p.developer?.lens)) {
        const key = keyOf(developer.developer.lens);
        if (!memberKeys.includes(key)) continue;
        out.set(key, [...(out.get(key) || []), developer]);
    }
    return out;
}

/** The newest executed apartment rounds of these developers whose lens names `member`: [{ cid, title, account, content }]. */
export async function executedRoundsOf({ index, connection, member, developers, maxRounds = MAX_ROUNDS, log = () => {} }) {
    const cities = [...new Set(developers.map(p => p.developer.city).filter(Boolean))];
    const sponsors = new Set(developers.map(p => p.wallet));
    const found = await readAgreementStatuses(await discoverAgreements({ index, cities, log }), connection);
    const executed = found.filter(row => row.chainStatus === 'executed' && sponsors.has(row.sponsor) && row.rule?.electorate === 'investors' && row.rule?.lens?.includes(member));
    if (executed.length > maxRounds) log(`${executed.length} executed rounds name ${member}; reading the newest ${maxRounds}`);
    const rounds = [];
    for (const summary of executed.slice(0, maxRounds)) {
        const row = await index.getAgreement(summary.cid);
        if (row?.content?.funding?.apartments) rounds.push({ cid: summary.cid, title: summary.name, account: summary.account, content: row.content });
    }
    return rounds;
}

/**
 * State each reserved unit's buyer of these executed rounds as first holder of the flat, once: the
 * statement's address is fixed by the lens member and the flat, so all are read first in one batch and
 * only missing ones are signed. A statement naming someone else is reported, never replaced.
 * → { stated: [{ round, unitId, holder, signature }], already, deferred, conflicts: [...], failures: [...] }
 */
export async function stateRoundHolders({ connection, memberKeypair, rounds, budget, sendAndConfirm, env = process.env,
    deps = {}, log = () => {} }) {
    const act = { readRoundInventory, stateHolding, ...deps };
    const member = memberKeypair.publicKey.toBase58();
    const result = { stated: [], already: 0, deferred: 0, conflicts: [], failures: [] };
    const units = [];
    let batchedInventories = null;
    if (!deps.readRoundInventory && typeof readRoundsInventory === 'function' && typeof connection?.getMultipleAccountsInfo === 'function') {
        try {
            batchedInventories = await readRoundsInventory(connection, rounds, { env });
        } catch {
            // Fall back to per-round reads so one corrupt round does not block the others.
            batchedInventories = null;
        }
    }
    for (const round of rounds) {
        try {
            const byId = new Map(round.content.funding.apartments.units.map(unit => [unit.unitId, unit]));
            const inventory = batchedInventories ? (batchedInventories.get(round.account) || [])
                : await act.readRoundInventory(connection, { account: round.account, content: round.content });
            for (const item of inventory) {
                if (item.status !== 'reserved' || !item.buyer) continue;
                const unit = byId.get(item.unitId);
                const asset = { kind: 'flat', xrayBuilding: unit.xrayBuilding, unit: unit.unit, at: unit.at };
                units.push({ round, unitId: item.unitId, buyer: item.buyer, asset, address: Statements.holdingAddress(member, Offer.assetHash(asset)) });
            }
        } catch (error) {
            result.failures.push(`round ${round.cid}: inventory unreadable: ${error.message}`);
        }
    }
    const infos = await getMultipleAccountsBatched(connection, units.map(unit => unit.address), { batchSize: accountsPerRequest(env) });
    for (const [i, unit] of units.entries()) {
        const label = `${unit.round.cid} ${unit.unitId}`;
        try {
            if (infos[i]) {
                const stated = Statements.readHolding(new Uint8Array(infos[i].data));
                if (stated?.fields.holder === unit.buyer) { result.already += 1; continue; }
                result.conflicts.push(`${label}: this lens member already states ${stated?.fields.holder ?? 'an unreadable holder'} first holds it, not the buyer ${unit.buyer}`);
                continue;
            }
            if (budget.left <= 0) { result.deferred += 1; continue; }
            const city = unit.round.content.city;
            const done = await act.stateHolding({ connection, keypair: memberKeypair, asset: unit.asset, city, holder: unit.buyer, basis: 'developer',
                evidence: `agreement:${unit.round.cid}`, sendAndConfirm });
            if (done.signature) budget.left -= 1;
            result.stated.push({ round: unit.round.cid, unitId: unit.unitId, holder: unit.buyer, signature: done.signature });
            log(`stated ${unit.buyer} first holder of ${label} ${done.signature ?? '(already)'}`);
        } catch (error) {
            result.failures.push(`${label}: ${error.message}`);
        }
    }
    return result;
}

/**
 * State, once, the sole owner its devnet owner registry gives each plot of its plot markets as that
 * plot's first holder (PropertyHolding-v1, basis registry). A plot the registry gives no sole owner is
 * skipped; a statement already naming someone else is reported, never replaced. Later sales are its
 * confirmations, so the first statement stays as it is. `readOwners(ids)` → Map(id → [{ owner, ownerCount }]).
 * → { stated: [{ plot, holder, signature }], already, unowned, deferred, conflicts: [...], failures: [...] }
 */
export async function statePlotHolders({ connection, memberKeypair, plots, readOwners, budget, sendAndConfirm, env = process.env,
    deps = {}, log = () => {} }) {
    const act = { stateHolding, ...deps };
    const member = memberKeypair.publicKey.toBase58();
    const result = { stated: [], already: 0, unowned: 0, deferred: 0, conflicts: [], failures: [] };
    if (!plots.length) return result;
    const owners = await readOwners(plots.map(plot => plot.asset.id));
    const addresses = plots.map(plot => Statements.holdingAddress(member, plot.assetHash));
    const infos = await getMultipleAccountsBatched(connection, addresses, { batchSize: accountsPerRequest(env) });
    for (const [i, plot] of plots.entries()) {
        try {
            const set = owners.get(plot.asset.id) || [];
            const holder = set.length === 1 && set[0].ownerCount === 1 ? set[0].owner : null;
            if (!holder) { result.unowned += 1; continue; }
            if (infos[i]) {
                const stated = Statements.readHolding(new Uint8Array(infos[i].data));
                if (stated?.fields.holder === holder) { result.already += 1; continue; }
                result.conflicts.push(`${plot.asset.id}: this lens member already states ${stated?.fields.holder ?? 'an unreadable holder'} first holds it, not the registry's owner ${holder}`);
                continue;
            }
            if (budget.left <= 0) { result.deferred += 1; continue; }
            const done = await act.stateHolding({ connection, keypair: memberKeypair, asset: plot.asset, city: plot.city, holder, basis: 'registry',
                evidence: `devnet-registry:${plot.asset.id}`, sendAndConfirm });
            if (done.signature) budget.left -= 1;
            result.stated.push({ plot: plot.asset.id, holder, signature: done.signature });
            log(`stated ${holder} first holder of ${plot.label} ${done.signature ?? '(already)'}`);
        } catch (error) {
            result.failures.push(`${plot.asset.id}: ${error.message}`);
        }
    }
    return result;
}

/**
 * Confirm, as the buyer's lens, the committed offers waiting for this member (GET
 * /property-offers/awaiting) whose seller its own statements name as holder. A refusal (no holder
 * stated, another holder, another sale of the holding open) leaves the offer waiting; it expires
 * unless that changes. A seller's-lens request (does the buyer qualify) has no rule here and waits.
 * → { confirmed: [{ cid, signature, status }], waiting: [{ cid, reason }], deferred, failures: [...] }
 */
export async function confirmAwaitingSales({ connection, memberKeypair, offerTools, recordOnchain, budget, sendAndConfirm, deps = {}, log = () => {} }) {
    const act = { confirmSale, ...deps };
    const member = memberKeypair.publicKey.toBase58();
    const result = { confirmed: [], waiting: [], deferred: 0, failures: [] };
    const page = await offerTools.list({ awaiting: member, limit: MAX_AWAITING });
    if (page.hasMore) log(`more than ${MAX_AWAITING} offers wait for ${member}; the rest on a later run`);
    for (const row of page.propertyOffers || []) {
        const buyerLens = row.onchain?.buyerLens;
        if (!buyerLens?.members?.includes(member) || buyerLens.confirmed?.includes(member)) {
            result.waiting.push({ cid: row.cid, reason: 'only the seller’s lens names this member; no rule confirms a buyer' });
            continue;
        }
        if (budget.left <= 0) { result.deferred += 1; continue; }
        try {
            const done = await act.confirmSale({ connection, keypair: memberKeypair, row: { cid: row.cid, content: row.content, onchain: row.onchain ?? null },
                recordOnchain, sendAndConfirm });
            if (done.signature) budget.left -= 1;
            result.confirmed.push({ cid: row.cid, signature: done.signature, status: done.status });
            log(`confirmed offer ${row.cid} as its buyer's lens ${done.signature ?? '(already)'} → ${done.status}`);
        } catch (error) {
            if (error?.code === 'refused') result.waiting.push({ cid: row.cid, reason: error.message });
            else result.failures.push(`offer ${row.cid}: ${error.message}`);
        }
    }
    return result;
}

/**
 * The runner's stage: for each lens member it signs for that serves a developer of this run, state
 * first holders, then confirm waiting sales, within AGENT_PROPERTY_LENS_MAX_PER_RUN transactions.
 * Problems go to `failures` (the run's verdict); a summary line per member to `report`.
 */
export async function propertyLensStage({ connection, index, personas, developers, memberSigners, offerTools, recordOnchain, readOwners, failures, report,
    env = process.env, sendAndConfirm, deps = {}, log = () => {}, markets = loadPlotMarkets() }) {
    const members = lensMembersOfDevelopers(personas, developers, Object.keys(memberSigners));
    for (const [member, serving] of members) {
        const name = personas.find(p => p.wallet === member)?.name ?? member;
        const say = message => log(`${name} property lens: ${message}`);
        const budget = { left: propertyLensCap(env) };
        let keypair;
        try { keypair = memberSigners[member](); } catch (error) { failures.push(`${name} property lens: ${error.message}`); continue; }
        let holders = { stated: [], already: 0, deferred: 0, conflicts: [], failures: [] };
        let sales = { confirmed: [], waiting: [], deferred: 0, failures: [] };
        try {
            const rounds = await (deps.executedRoundsOf || executedRoundsOf)({ index, connection, member, developers: serving, log: say });
            holders = await stateRoundHolders({ connection, memberKeypair: keypair, rounds, budget, sendAndConfirm, env, deps, log: say });
        } catch (error) {
            failures.push(`${name} property lens: first holders: ${error.message}`);
        }
        let plotHolders = { stated: [], already: 0, unowned: 0, deferred: 0, conflicts: [], failures: [] };
        try {
            plotHolders = await statePlotHolders({ connection, memberKeypair: keypair, plots: plotsOfMember({ member, personas, markets }), readOwners,
                budget, sendAndConfirm, env, deps, log: say });
        } catch (error) {
            failures.push(`${name} property lens: plot holders: ${error.message}`);
        }
        try {
            sales = await confirmAwaitingSales({ connection, memberKeypair: keypair, offerTools, recordOnchain, budget, sendAndConfirm, deps, log: say });
        } catch (error) {
            failures.push(`${name} property lens: confirmations: ${error.message}`);
        }
        for (const problem of [...holders.conflicts, ...holders.failures, ...plotHolders.conflicts, ...plotHolders.failures, ...sales.failures]) failures.push(`${name} property lens ${problem}`);
        for (const item of sales.waiting) say(`offer ${item.cid} waits: ${item.reason}`);
        const deferred = holders.deferred + plotHolders.deferred + sales.deferred;
        report.push(`${name}: ${holders.stated.length} flat first holder(s) stated (${holders.already} already) · ${plotHolders.stated.length} plot first holder(s) stated (${plotHolders.already} already, ${plotHolders.unowned} without a sole registry owner) · ${sales.confirmed.length} sale(s) confirmed · ${sales.waiting.length} waiting${deferred ? ` · ${deferred} deferred (cap ${propertyLensCap(env)})` : ''}`);
    }
}
