function asLimit(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return 100;
    return Math.min(parsed, 250);
}

function runEvents(row) {
    const summary = row.summary || {};
    const controller = summary.controller || summary.decisionResult?.controller || (summary.model ? 'llm' : 'algorithm');
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
    return {
        id: row.run_id,
        persona: row.persona,
        mode: row.mode,
        status: row.status,
        stage: row.stage,
        startedAt: row.started_at,
        finishedAt: row.finished_at || null,
        updatedAt: row.updated_at,
        controller: summary.controller || summary.decisionResult?.controller || (summary.model ? 'llm' : 'algorithm'),
        model: summary.decisionResult?.model || summary.model || null,
        batchId: summary.decisionResult?.batchId || summary.batchId || null,
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

export function setupAgentActivityRoute(app, pool) {
    app.get('/agent/activity', async (req, res) => {
        try {
            const limit = asLimit(req.query.limit);
            const [runs, proposals] = await Promise.all([
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
                )
            ]);
            const events = mergeEvents(
                runs.rows.flatMap(runEvents),
                proposals.rows.flatMap(proposalEvents)
            ).slice(-limit);
            res.json({ events, count: events.length, source: 'live' });
        } catch (error) {
            console.error('GET /agent/activity failed', error);
            res.status(500).json({ error: 'Failed to read agent activity' });
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

export { asLimit, mergeEvents, proposalEvents, runDetail, runEvents };
