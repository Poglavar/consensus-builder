import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { buildAddressBook } from '../solana/address-book.js';
import { decodeParsedTransaction, loadIdls } from '../solana/tx-decoder.js';
import { formatAtomicAmount } from '../utils/x402-payment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAIN_ACTIONS = Object.freeze({
    mint_and_fund: 'create',
    accept_proposal: 'accept',
    withdraw_acceptance: 'withdrawAcceptance',
    cancel_and_refund: 'cancel',
    create_market: 'createMarket',
    stake: 'stake',
    resolve: 'resolve',
    claim: 'claim',
    donate: 'donate',
    refund_donation: 'refundMyDonations',
    release_donations: 'releaseDonations',
    set_pledge: 'pledge',
    revoke_pledge: 'revokePledge',
    fulfill_pledge: 'fulfillPledge',
    void_pledge: 'voidPledge'
});
const ACTIVITY_PROGRAMS = new Set(['proposal_nft', 'proposal_market', 'proposal_pledge']);

function readPersonas() {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'personas.json'), 'utf8'));
    } catch {
        return { personas: [] };
    }
}

function asLimit(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return 100;
    return Math.min(parsed, 250);
}

function accountFor(instruction, role) {
    return instruction?.accounts?.find(account => account.role === role)?.address || null;
}

export function proposalAccountIndex(rows = []) {
    const index = new Map();
    for (const row of rows) {
        const account = row.proposal_account;
        if (!account || !row.proposal_id) continue;
        index.set(account, String(row.proposal_id));
        try {
            const market = PublicKey.findProgramAddressSync(
                [Buffer.from('market'), new PublicKey(account).toBuffer()],
                new PublicKey('GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB')
            )[0].toBase58();
            index.set(market, String(row.proposal_id));
        } catch { /* invalid legacy account: keep the public proposal usable */ }
    }
    return index;
}

function activityActor(decoded, instruction, book) {
    const wallet = instruction.accounts?.find(account => account.signer)?.address
        || decoded.feePayer?.address
        || null;
    const entry = wallet ? book?.entryFor?.(wallet) : null;
    const persona = entry?.persona || null;
    return {
        id: wallet || 'chain-actor',
        name: persona || decoded.feePayer?.label || wallet || 'Chain actor',
        kind: persona ? 'agent' : 'human',
        controller: persona ? 'algorithm' : 'human',
        wallet
    };
}

function x402Event(decoded, row, book) {
    if (!book?.feePayer || decoded.feePayer?.address !== book.feePayer) return null;
    const payment = decoded.amounts?.find(amount => amount.kind === 'token'
        && amount.from?.owner?.address && amount.to?.owner?.address === book.treasury);
    if (!payment) return null;
    const wallet = payment.from.owner.address;
    const entry = book.entryFor?.(wallet);
    const persona = entry?.persona || null;
    const actor = {
        id: wallet, name: persona || payment.from.owner.label || wallet,
        kind: persona ? 'agent' : 'human', controller: persona ? 'algorithm' : 'human', wallet
    };
    return {
        id: `chain:${decoded.signature}:x402`, source: 'live', actor,
        action: { type: 'x402Payment', amount: payment.amount, asset: payment.symbol || payment.mint },
        entity: null, ok: decoded.status !== 'failed', message: decoded.summary,
        transaction: decoded.signature, occurredAt: decoded.time || null,
        recordedAt: decoded.time || row.created_at || null,
        provenance: { source: 'solana_transaction', slot: decoded.slot, program: 'spl-token', instruction: 'transfer' }
    };
}

function chainAction(instruction, proposalId) {
    const type = CHAIN_ACTIONS[instruction.action];
    const action = { type };
    if (proposalId) action.proposalId = proposalId;
    if (instruction.action === 'stake') action.side = Number(instruction.args?.side) === 1 ? 'yes' : 'no';
    if (instruction.args?.amount != null && ['stake', 'donate', 'set_pledge'].includes(instruction.action)) {
        action.amount = formatAtomicAmount(String(instruction.args.amount), 6);
    }
    if (instruction.args?.parcel_id) action.parcelId = instruction.args.parcel_id;
    return action;
}

/** Project confirmed program instructions into the same actor/action envelope as agent runs. */
export function chainEvents(rows = [], {
    book,
    idls,
    proposalIdsByAccount = new Map(),
    decode = decodeParsedTransaction
} = {}) {
    const events = [];
    for (const row of rows) {
        const decoded = decode(row.raw, { book, idls });
        if (!decoded?.signature) continue;
        const relevant = (decoded.instructions || []).filter(instruction =>
            !instruction.inner
            && ACTIVITY_PROGRAMS.has(instruction.program?.name)
            && CHAIN_ACTIONS[instruction.action]
        );
        relevant.forEach((instruction, instructionIndex) => {
            const proposalAccount = accountFor(instruction, 'proposal');
            const marketAccount = accountFor(instruction, 'market');
            const proposalId = proposalIdsByAccount.get(proposalAccount)
                || proposalIdsByAccount.get(marketAccount)
                || proposalAccount
                || marketAccount
                || null;
            const actor = activityActor(decoded, instruction, book);
            const action = chainAction(instruction, proposalId);
            events.push({
                id: `chain:${decoded.signature}:${instruction.index ?? instructionIndex}:${action.type}`,
                source: 'live',
                actor,
                action,
                entity: proposalId ? { type: 'proposal', id: proposalId } : null,
                ok: decoded.status !== 'failed',
                message: `${actor.name} submitted ${action.type}${proposalId ? ` for proposal ${proposalId}` : ''}.`,
                transaction: decoded.signature,
                occurredAt: decoded.time || null,
                recordedAt: decoded.time || row.created_at || null,
                provenance: {
                    source: 'solana_transaction',
                    slot: decoded.slot,
                    program: instruction.program?.address || null,
                    instruction: instruction.action
                }
            });
        });
        const payment = x402Event(decoded, row, book);
        if (payment) events.push(payment);
    }
    return events;
}

function controllerOf(summary = {}) {
    if (summary.controller) return summary.controller;
    if (summary.decisionResult?.controller) return summary.decisionResult.controller;
    // Runs created before controller provenance was added still carry LLM-only evidence.
    if (summary.decisionResult?.model || summary.model || summary.batchId || Number(summary.pickCostUsd) > 0) return 'llm';
    return 'algorithm';
}

function runEvents(row) {
    const summary = row.summary || {};
    const controller = controllerOf(summary);
    const actor = {
        id: String(row.persona), name: String(row.persona), kind: 'agent', controller, wallet: summary.wallet || null
    };
    const base = {
        source: 'live', actor, ok: row.status !== 'failed',
        occurredAt: row.updated_at || row.started_at, recordedAt: row.updated_at || row.started_at,
        runId: row.run_id,
        model: summary.decisionResult?.model || summary.model || null,
        modelCostUsd: summary.decisionResult?.costUsd ?? summary.pickCostUsd ?? null,
        batchId: summary.decisionResult?.batchId || summary.batchId || null
    };
    const pickForProposal = (proposalId) => (summary.picks || [])
        .find(pick => String(pick.proposalId) === String(proposalId));
    const withRunContext = (event) => {
        const proposalId = event?.entity?.id || event?.action?.proposalId;
        const pick = proposalId ? pickForProposal(proposalId) : null;
        return {
            ...event,
            // The activity envelope remains shared. These are optional evidence fields, rather than
            // an agent-only shape, so a human or algorithmic event can carry the same provenance.
            rationale: event.rationale || pick?.rationale || null,
            provenance: event.provenance || {
                runId: row.run_id,
                stage: row.stage || null,
                mode: row.mode || null,
                transaction: event.transaction || null
            }
        };
    };
    if (Array.isArray(summary.activities) && summary.activities.length) {
        return summary.activities.map((event, index) => ({
            ...event,
            id: event.id || `activity:${row.run_id}:${index}`,
            source: 'live',
            actor: event.actor || actor,
            runId: row.run_id,
            model: event.model || base.model,
            modelCostUsd: event.modelCostUsd ?? base.modelCostUsd,
            batchId: event.batchId || base.batchId
        })).map(withRunContext);
    }
    const events = [{
        ...base, id: `run:${row.run_id}:${row.stage || 'started'}`,
        action: { type: 'run_status', stage: row.stage || 'started' },
        message: `${row.persona} agent run ${row.status}: ${row.stage || 'started'}.`
    }];
    const picks = Array.isArray(summary.picks) ? summary.picks : [];
    for (const pick of picks) {
        const mint = summary.mints?.[pick.candidateId];
        const post = summary.posts?.[pick.candidateId];
        const stake = summary.stakes?.[pick.candidateId];
        if (mint) events.push({
            ...base, id: `mint:${row.run_id}:${pick.proposalId}`, action: { type: 'create', proposalId: pick.proposalId },
            entity: { type: 'proposal', id: String(pick.proposalId) }, transaction: mint.signature || mint.transactionHash || null,
            message: `${row.persona} created proposal ${pick.name || pick.proposalId}.`
        });
        if (post) events.push({
            ...base, id: `post:${row.run_id}:${pick.proposalId}`, action: { type: 'publish', proposalId: pick.proposalId },
            entity: { type: 'proposal', id: String(pick.proposalId) }, transaction: post.tx || null,
            message: `${row.persona} published proposal ${pick.name || pick.proposalId} through x402.`
        });
        if (stake) events.push({
            ...base, id: `stake:${row.run_id}:${pick.proposalId}`, action: { type: 'stake', proposalId: pick.proposalId },
            entity: { type: 'proposal', id: String(pick.proposalId) }, transaction: stake.stakeSignature || null,
            message: `${row.persona} backed proposal ${pick.name || pick.proposalId}.`
        });
    }
    return events.map(withRunContext);
}

function proposalEvents(row) {
    const agent = row.agent || {};
    const proposalId = String(row.proposal_id);
    const persona = String(agent.persona || 'agent');
    const wallet = agent.wallet || null;
    const controller = agent.controller || 'llm';
    return [{
        id: `proposal:${proposalId}:published`,
        source: 'live',
        actor: { id: wallet || persona, name: persona, kind: 'agent', controller, wallet },
        action: { type: 'publish', proposalId },
        entity: { type: 'proposal', id: proposalId },
        ok: true,
        message: `${persona} published proposal ${row.display_name || proposalId} through x402.`,
        transaction: agent.paid?.tx || null,
        occurredAt: row.created_at,
        recordedAt: row.updated_at || row.created_at,
        runId: agent.run_id || null
    }];
}

function mergeEvents(...lists) {
    const byAction = new Map();
    lists.flat().forEach(event => {
        const hasEntityOrTransaction = Boolean(event.entity?.id || event.transaction);
        const key = hasEntityOrTransaction
            ? `${event.action?.type || ''}:${event.entity?.id || ''}:${event.transaction || ''}`
            : (event.id || `${event.recordedAt}:${event.message || ''}`);
        byAction.set(key, event);
    });
    return Array.from(byAction.values()).sort((left, right) => {
        const a = Date.parse(left.recordedAt || left.occurredAt || 0) || 0;
        const b = Date.parse(right.recordedAt || right.occurredAt || 0) || 0;
        return a - b;
    });
}

function runDetail(row, costs = []) {
    const summary = row.summary || {};
    const recordedCost = costs.reduce((total, cost) => total + (Number(cost.usd) || 0), 0);
    const summaryCost = Number(summary.decisionResult?.costUsd ?? summary.pickCostUsd ?? 0);
    return {
        id: row.run_id,
        persona: row.persona,
        role: summary.role || 'proposer',
        wallet: summary.wallet || null,
        mode: row.mode,
        status: row.status,
        stage: row.stage,
        startedAt: row.started_at,
        finishedAt: row.finished_at || null,
        updatedAt: row.updated_at,
        controller: controllerOf(summary),
        model: summary.decisionResult?.model || summary.model || costs[0]?.model || null,
        modelCostUsd: recordedCost || (Number.isFinite(summaryCost) ? summaryCost : 0),
        batchId: summary.decisionResult?.batchId || summary.batchId || costs[0]?.batch_id || null,
        outcome: summary.outcome || null,
        support: summary.support || null,
        picks: Array.isArray(summary.picks) ? summary.picks.map(pick => ({
            candidateId: pick.candidateId || null,
            proposalId: pick.proposalId || null,
            name: pick.name || null,
            rationale: pick.rationale || null
        })) : [],
        costs: costs.map(cost => ({
            item: cost.item,
            provider: cost.provider,
            model: cost.model,
            batchId: cost.batch_id,
            inputTokens: cost.input_tokens,
            outputTokens: cost.output_tokens,
            cacheReadTokens: cost.cache_read_tokens,
            cacheCreationTokens: cost.cache_creation_tokens,
            usd: Number(cost.usd),
            recordedAt: cost.created_at
        }))
    };
}

export function setupAgentActivityRoute(app, pool, {
    env = process.env,
    book = buildAddressBook({ env, personas: readPersonas() }),
    idls = loadIdls(path.join(__dirname, '..', '..', 'blockchain', 'solana', 'idl'))
} = {}) {
    app.get('/agent/activity', async (req, res) => {
        try {
            const limit = asLimit(req.query.limit);
            const [runs, proposals, transactions, proposalAccounts] = await Promise.all([
                pool.query(
                    `SELECT run_id, persona, mode, status, stage, summary, started_at, updated_at
                       FROM consensus.agent_run
                      ORDER BY updated_at DESC
                      LIMIT $1`,
                    [limit]
                ),
                pool.query(
                    `SELECT proposal_id,
                            COALESCE(name, title, proposal_data->>'name', proposal_data->>'title') AS display_name,
                            proposal_data->'agent' AS agent,
                            created_at, updated_at
                       FROM proposal
                      WHERE proposal_data ? 'agent'
                      ORDER BY created_at DESC
                      LIMIT $1`,
                    [limit]
                ),
                pool.query(
                    `SELECT signature, slot, block_time, raw, created_at
                       FROM consensus.solana_transaction
                      WHERE cluster = 'devnet'
                      ORDER BY block_time DESC NULLS LAST, slot DESC
                      LIMIT $1`,
                    [limit]
                ),
                pool.query(
                    `SELECT proposal_id,
                            COALESCE(onchain_data->>'proposalId',
                                     proposal_data #>> '{onchain,proposalId}',
                                     proposal_data #>> '{onchainData,proposalId}') AS proposal_account
                       FROM proposal
                      WHERE COALESCE(onchain_data->>'proposalId',
                                     proposal_data #>> '{onchain,proposalId}',
                                     proposal_data #>> '{onchainData,proposalId}') IS NOT NULL`
                )
            ]);
            const chain = chainEvents(transactions.rows, {
                book, idls, proposalIdsByAccount: proposalAccountIndex(proposalAccounts.rows)
            });
            const events = mergeEvents(
                chain,
                runs.rows.flatMap(runEvents),
                proposals.rows.flatMap(proposalEvents)
            ).slice(-limit);
            res.json({ events, count: events.length, source: 'live' });
        } catch (error) {
            console.error('GET /agent/activity failed', error);
            res.status(500).json({ error: 'Failed to read agent activity' });
        }
    });

    // Bounded run index for the judge/demo surface. This is intentionally separate from the event
    // feed: a completed zero-pick run is evidence of scheduler liveness even when it produced no
    // proposal transaction. Controller filtering is applied after legacy provenance inference.
    app.get('/agent/runs', async (req, res) => {
        try {
            const limit = asLimit(req.query.limit);
            const controller = String(req.query.controller || '').trim().toLowerCase();
            if (controller && !['algorithm', 'llm'].includes(controller)) {
                return res.status(400).json({ error: 'controller must be algorithm or llm' });
            }
            const { rows } = await pool.query(
                `SELECT run_id, persona, mode, status, stage, summary, started_at, finished_at, updated_at
                   FROM consensus.agent_run
                  ORDER BY updated_at DESC
                  LIMIT $1`,
                [controller ? 250 : limit]
            );
            const runs = rows.map(row => runDetail(row, []))
                .filter(run => !controller || run.controller === controller)
                .slice(0, limit);
            return res.json({ runs, count: runs.length });
        } catch (error) {
            console.error('GET /agent/runs failed', error);
            return res.status(500).json({ error: 'Failed to read agent runs' });
        }
    });

    // Read-only drill-down for the explorer. Costs are taken from the immutable per-call ledger,
    // never re-estimated from an activity message or model name.
    app.get('/agent/runs/:runId', async (req, res) => {
        try {
            const runId = String(req.params.runId || '').trim();
            if (!runId) return res.status(400).json({ error: 'runId is required' });
            const { rows } = await pool.query(
                `SELECT run_id, persona, mode, status, stage, summary, started_at, finished_at, updated_at
                   FROM consensus.agent_run
                  WHERE run_id = $1
                  LIMIT 1`,
                [runId]
            );
            const row = rows[0];
            if (!row) return res.status(404).json({ error: 'Agent run not found' });
            const costs = await pool.query(
                `SELECT item, provider, model, batch_id, input_tokens, output_tokens,
                        cache_read_tokens, cache_creation_tokens, usd, created_at
                   FROM consensus.agent_cost
                  WHERE run_id = $1
                  ORDER BY created_at ASC, id ASC`,
                [runId]
            );
            return res.json({ run: runDetail(row, costs.rows), events: runEvents(row) });
        } catch (error) {
            console.error('GET /agent/runs/:runId failed', error);
            return res.status(500).json({ error: 'Failed to read agent run' });
        }
    });
}

export { asLimit, controllerOf, mergeEvents, proposalEvents, runDetail, runEvents };
