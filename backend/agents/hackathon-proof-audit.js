// Read-only audit of the public hackathon proof surface. This deliberately consumes the same HTTP
// contracts a judge or outside agent sees; it does not query the database or trust local fixtures.

function cleanBase(value) {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
}

function time(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
}

function newest(items, predicate) {
    return [...(items || [])].filter(predicate)
        .sort((left, right) => time(right.updatedAt || right.recordedAt || right.occurredAt)
            - time(left.updatedAt || left.recordedAt || left.occurredAt))[0] || null;
}

function exactResource(discovery, expected) {
    if (discovery?.state !== 'listed' || !discovery?.listing?.resource) return false;
    try {
        return cleanBase(discovery.listing.resource) === cleanBase(expected);
    } catch {
        return false;
    }
}

function check(id, ok, label, evidence = null, severity = 'required') {
    return { id, status: ok ? 'pass' : severity === 'required' ? 'fail' : 'warn', label, evidence };
}

function validateProspectiveSettlement(status) {
    if (status?.state !== 'settled') return { valid: true, pending: true };
    const settlement = status.settlement;
    const timestamps = settlement?.chronology?.timestamps || {};
    const marketCreated = time(timestamps.marketCreatedAt);
    const yesStake = time(timestamps.yesStakeAt);
    const noStake = time(timestamps.noStakeAt);
    const closes = time(timestamps.marketClosesAt);
    const sourceObserved = time(timestamps.sourceObservedAt);
    const firstSeen = time(timestamps.evidenceCreatedAt);
    const resolved = time(timestamps.resolvedAt);
    const claimed = time(timestamps.claimedAt);
    const resolutionSlot = Number(settlement?.chronology?.transactionSlots?.resolution || 0);
    const claimSlot = Number(settlement?.chronology?.transactionSlots?.claim || 0);
    const resolutionBeforeClaim = resolved < claimed
        || (resolved === claimed && Number.isSafeInteger(resolutionSlot) && Number.isSafeInteger(claimSlot)
            && resolutionSlot > 0 && resolutionSlot < claimSlot);
    const valid = Boolean(
        settlement?.chronology?.classification === 'prospective'
        && settlement.chronology.prospective === true
        && settlement.chronology.marketOrderValid === true
        && settlement.chronology.sourceTimeVerified === true
        && settlement.chronology.sourceAfterClose === true
        && marketCreated > 0 && yesStake > 0 && noStake > 0
        && Math.max(marketCreated, yesStake, noStake) < closes
        && time(status.closesAt) === closes
        && closes <= sourceObserved
        && sourceObserved <= firstSeen
        && firstSeen <= resolved
        && resolutionBeforeClaim
        && ['YES', 'NO'].includes(settlement?.outcome)
        && status?.transactions?.create
        && status?.transactions?.yesStake
        && status?.transactions?.noStake
        && settlement?.evidence?.address
        && /^sha256:[a-f0-9]{64}$/.test(settlement?.evidence?.hash || '')
        && settlement?.transactions?.evidenceFirstSeen
        && settlement?.transactions?.resolution
        && settlement?.transactions?.claim
    );
    return { valid, pending: false, settlement };
}

async function readJson(fetchImpl, url) {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    const body = await response.text();
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    try {
        return JSON.parse(body);
    } catch {
        throw new Error(`${url} did not return JSON`);
    }
}

export async function auditHackathonProof({
    baseUrl = 'https://api.urbangametheory.xyz',
    fetchImpl = globalThis.fetch,
    now = Date.now(),
    maxRunAgeHours = 48
} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
    const base = cleanBase(baseUrl);
    const paths = {
        docs: '/docs/agents.json',
        proposalDiscovery: '/agent/discovery',
        oracleDiscovery: '/agent/discovery?resource=oracle-facts',
        runs: '/agent/runs?limit=50',
        activity: '/agent/activity?limit=200',
        oracleEvents: '/oracle/events?limit=25',
        publicRecords: '/oracle/public-records/summary',
        proofManifest: '/hackathon/proof.json',
        prospectiveStatus: '/oracle/markets/prospective/status',
        operations: '/hackathon/operations.json'
    };
    const entries = Object.entries(paths);
    const settled = await Promise.allSettled(entries.map(([, path]) => readJson(fetchImpl, `${base}${path}`)));
    const values = {};
    const errors = {};
    settled.forEach((result, index) => {
        const key = entries[index][0];
        if (result.status === 'fulfilled') values[key] = result.value;
        else errors[key] = result.reason instanceof Error ? result.reason.message : String(result.reason);
    });
    const canonicalCaseUrl = values.proofManifest?.publicProof?.canonicalCase;
    if (canonicalCaseUrl) {
        try {
            values.canonicalCase = await readJson(fetchImpl, canonicalCaseUrl);
        } catch (error) {
            errors.canonicalCase = error instanceof Error ? error.message : String(error);
        }
    } else {
        errors.canonicalCase = 'proof manifest does not declare publicProof.canonicalCase';
    }

    const expectedProposal = `${base}/agent/proposals`;
    const expectedFact = `${base}/agent/oracle/facts`;
    const runs = values.runs?.runs || [];
    const events = values.activity?.events || [];
    const proposer = newest(runs, run => run.controller === 'algorithm'
        && (run.role || 'proposer') === 'proposer' && run.status === 'done');
    const supporter = newest(runs, run => run.controller === 'algorithm'
        && run.role === 'supporter' && run.status === 'done');
    const proposerAge = proposer ? Math.max(0, (Number(now) - time(proposer.updatedAt || proposer.finishedAt)) / 3_600_000) : Infinity;
    const proposerAction = proposer && newest(events, event => event.runId === proposer.id && Boolean(event.transaction));
    const supporterSignature = supporter?.support?.signature || null;
    const supporterAction = supporter && newest(events, event => event.runId === supporter.id
        && event.action?.type === supporter.support?.type && Boolean(event.transaction));
    const activityMatrix = {
        humanSupport: events.some(event => event.actor?.kind === 'human'
            && ['donate', 'pledge'].includes(event.action?.type) && Boolean(event.transaction)),
        humanForecast: events.some(event => event.actor?.kind === 'human'
            && event.action?.type === 'stake' && ['yes', 'no'].includes(String(event.action?.side || '').toLowerCase())
            && Boolean(event.transaction)),
        algorithm: events.some(event => event.actor?.controller === 'algorithm' && Boolean(event.transaction)),
        llm: events.some(event => event.actor?.controller === 'llm' && Boolean(event.transaction)),
        resolver: events.some(event => ['resolve', 'claim', 'refundMyDonations', 'releaseDonations'].includes(event.action?.type)
            && Boolean(event.transaction))
    };
    const external = values.docs?.oracle?.externalMarket;
    const externalProof = external?.proof || {};
    const lifecycle = newest(values.oracleEvents?.events, event => event.eventType === 'proposal_lifecycle'
        && /^sha256:[a-f0-9]{64}$/.test(event.source?.hash || '') && Boolean(event.source?.transaction));
    const records = values.publicRecords;
    const chronology = externalProof.chronology;
    const prospectiveSettlement = validateProspectiveSettlement(values.prospectiveStatus);
    const canonical = values.canonicalCase;
    const canonicalActivities = canonical?.activity || [];
    const canonicalAction = (type, side = null) => canonicalActivities.some(event => event.action?.type === type
        && (side === null || String(event.action?.side || '').toLowerCase() === side)
        && Boolean(event.transaction));
    const canonicalSupport = canonical?.branches?.support || {};
    const canonicalForecast = canonical?.branches?.forecast || {};
    const canonicalSetup = Boolean(
        canonical?.parcelSet?.parcelCount >= 2
        && canonical?.proposal?.account
        && Number(canonicalSupport.donations?.totalUsdc) > 0
        && (Number(canonicalSupport.pledges?.pledgeCount) > 0 || canonicalAction('pledge'))
        && Number(canonicalForecast.yesUsdc) > 0
        && Number(canonicalForecast.noUsdc) > 0
        && canonicalAction('create') && canonicalAction('publish')
        && canonicalAction('donate') && canonicalAction('pledge')
        && canonicalAction('stake', 'yes') && canonicalAction('stake', 'no')
    );
    const canonicalTerminal = ['decision', 'evidence', 'resolution', 'settlement']
        .every(id => canonical?.stages?.find(item => item.id === id)?.state === 'complete');

    const checks = [
        check('proposal_bazaar', exactResource(values.proposalDiscovery, expectedProposal),
            'Paid proposal endpoint has an exact hosted Bazaar listing',
            errors.proposalDiscovery || values.proposalDiscovery?.listing?.resource || values.proposalDiscovery?.state || null),
        check('oracle_fact_bazaar', exactResource(values.oracleDiscovery, expectedFact),
            'Paid verified-fact endpoint has its own exact Bazaar listing',
            errors.oracleDiscovery || values.oracleDiscovery?.listing?.resource || values.oracleDiscovery?.state || null),
        check('deterministic_proposer', Boolean(proposer && proposerAge <= maxRunAgeHours && proposerAction),
            `A deterministic proposer completed within ${maxRunAgeHours} hours and produced an on-chain action`,
            proposer ? { runId: proposer.id, ageHours: Number(proposerAge.toFixed(2)), transaction: proposerAction?.transaction || null } : errors.runs || null),
        check('deterministic_supporter', Boolean(supporter && supporterSignature && supporterAction?.transaction === supporterSignature),
            'A separate deterministic supporter backed another proposal on-chain',
            supporter ? { runId: supporter.id, type: supporter.support?.type || null, proposalId: supporter.support?.proposalId || null, transaction: supporterSignature } : errors.runs || null),
        check('proposal_lifecycle_oracle', Boolean(lifecycle),
            'A source-hashed terminal proposal event is publicly auditable',
            lifecycle ? { eventId: lifecycle.id, outcome: lifecycle.outcome, transaction: lifecycle.source.transaction } : errors.oracleEvents || null),
        check('court_attestations', Boolean(records?.attestations > 0 && records?.schemaId
            && records?.v2?.status === 'live_devnet' && records?.v2?.attestations > 0),
            'The Croatian court bridge reports public devnet attestations and live source-timed V2 evidence',
            records ? {
                attestations: records.attestations, decisions: records.decisions,
                schemaId: records.schemaId, v2Attestations: records.v2?.attestations || 0
            } : errors.publicRecords || null),
        check('external_market_lifecycle', Boolean(external?.status === 'live_devnet'
            && external.proofMarket && external.proofResolution && external.proofClaim
            && externalProof.create && externalProof.yesStake && externalProof.noStake),
        'A two-sided recipe-bound external market resolved and paid out on devnet',
        external ? { market: external.proofMarket, resolution: external.proofResolution, claim: external.proofClaim } : errors.docs || null),
        check('prospective_market_open', Boolean(external?.prospectiveProof?.status === 'market_open_awaiting_post_close_evidence'
            && external.prospectiveProof.market && external.prospectiveProof.transactions?.create
            && external.prospectiveProof.transactions?.yesStake && external.prospectiveProof.transactions?.noStake),
        'A source-timed V2 market opened and both outcomes were staked before future evidence',
        external?.prospectiveProof ? {
            market: external.prospectiveProof.market,
            closesAt: external.prospectiveProof.closesAt,
            transactions: external.prospectiveProof.transactions
        } : errors.docs || null),
        check('public_proof_manifest', Boolean(values.proofManifest?.hackathon?.branch === 'colosseum-worlds-fair'
            && values.proofManifest?.publicProof?.prospectiveMarket === `${base}/oracle/markets/prospective/status`
            && values.proofManifest?.publicProof?.operations === `${base}/hackathon/operations.json`
            && Boolean(values.proofManifest?.publicProof?.canonicalCase)),
        'Hackathon scope and public evidence links are machine-readable',
        values.proofManifest?.hackathon || errors.proofManifest || null),
        check('release_artifact_identity', Boolean(
            values.proofManifest?.releaseArtifacts?.backend?.commit
            && values.proofManifest?.releaseArtifacts?.frontend?.manifest
            && values.proofManifest?.releaseArtifacts?.programs?.length >= 2
            && values.proofManifest.releaseArtifacts.programs.every(program =>
                Number.isSafeInteger(program.lastDeployedSlot)
                && /^[a-f0-9]{64}$/.test(program.binarySha256 || '')
                && Boolean(program.programDataAddress)
            )
        ),
        'Backend, frontend build and mutable Solana deployments have distinct public identities',
        values.proofManifest?.releaseArtifacts || errors.proofManifest || null),
        check('canonical_case_setup', canonicalSetup,
            'One plural parcel case proves paid proposal, donation, pledge and both forecast sides',
            canonical ? {
                id: canonical.id, parcelCount: canonical.parcelSet?.parcelCount || 0,
                progress: canonical.progress, transactions: canonical.transactions?.length || 0
            } : errors.canonicalCase || null),
        check('canonical_case_terminal', canonicalTerminal,
            'The canonical case also proves decision, evidence, resolution and settlement',
            canonical ? { id: canonical.id, state: canonical.state, stages: canonical.stages } : errors.canonicalCase || null),
        check('human_agent_activity_matrix', Object.values(activityMatrix).every(Boolean),
            'Humans, deterministic and LLM agents, and a resolver share one transaction-backed activity stream',
            activityMatrix, 'advisory'),
        check('prospective_resolver_status', Boolean(values.prospectiveStatus?.market === external?.prospectiveProof?.market
            && ['open', 'checking_evidence', 'awaiting_evidence', 'settled'].includes(values.prospectiveStatus?.state)),
        'The prospective market exposes a redacted live resolver state',
        values.prospectiveStatus ? {
            market: values.prospectiveStatus.market,
            state: values.prospectiveStatus.state,
            lastCheck: values.prospectiveStatus.resolver?.lastRun?.endedAt || null
        } : errors.prospectiveStatus || null),
        check('scheduled_operations_freshness', values.operations?.status === 'healthy'
            && Array.isArray(values.operations?.jobs)
            && values.operations.jobs.length >= 4
            && values.operations.jobs.every(job => job.status === 'completed' && job.freshness?.state === 'fresh'),
        'Scheduled proposer, supporter, land oracle and resolver publish fresh successful outcomes',
        values.operations?.jobs || errors.operations || null),
        check('prospective_settlement_proof', prospectiveSettlement.valid,
            prospectiveSettlement.pending
                ? 'The genuinely prospective settlement remains honestly pending'
                : 'The prospective payout publishes a complete, correctly ordered proof',
            prospectiveSettlement.pending ? {
                state: values.prospectiveStatus?.state || null,
                closesAt: values.prospectiveStatus?.closesAt || null
            } : prospectiveSettlement.settlement),
        check('chronology_label', Boolean(chronology?.classification),
            'The external-market proof publishes its evidence chronology classification',
            chronology?.classification || errors.docs || null, 'advisory')
    ];
    const summary = checks.reduce((counts, item) => {
        counts[item.status] += 1;
        return counts;
    }, { pass: 0, warn: 0, fail: 0 });
    return {
        version: 1,
        auditedAt: new Date(Number(now)).toISOString(),
        baseUrl: base,
        status: summary.fail === 0 ? 'verified' : 'incomplete',
        summary,
        checks,
        sourceErrors: errors
    };
}

export { cleanBase, exactResource, validateProspectiveSettlement };
