function asLimit(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return 100;
    return Math.min(parsed, 250);
}

function runEvents(row) {
    const summary = row.summary || {};
    const actor = {
        id: String(row.persona), name: String(row.persona), kind: 'agent', controller: 'llm', wallet: summary.wallet || null
    };
    const base = {
        source: 'live', actor, ok: row.status !== 'failed',
        occurredAt: row.updated_at || row.started_at, recordedAt: row.updated_at || row.started_at,
        runId: row.run_id,
        model: summary.decisionResult?.model || summary.model || null,
        modelCostUsd: summary.decisionResult?.costUsd ?? summary.pickCostUsd ?? null,
        batchId: summary.decisionResult?.batchId || summary.batchId || null
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
        }));
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
    return events;
}

function proposalEvents(row) {
    const agent = row.agent || {};
    const proposalId = String(row.proposal_id);
    const persona = String(agent.persona || 'agent');
    const wallet = agent.wallet || null;
    return [{
        id: `proposal:${proposalId}:published`,
        source: 'live',
        actor: { id: wallet || persona, name: persona, kind: 'agent', controller: 'llm', wallet },
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

export function setupAgentActivityRoute(app, pool) {
    app.get('/agent/activity', async (req, res) => {
        try {
            const limit = asLimit(req.query.limit);
            const [runs, proposals] = await Promise.all([
                pool.query(
                    `SELECT run_id, persona, status, stage, summary, started_at, updated_at
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
}

export { asLimit, mergeEvents, proposalEvents, runEvents };
