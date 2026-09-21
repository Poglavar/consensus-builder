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
        prospectiveStatus: '/oracle/markets/prospective/status'
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
    const external = values.docs?.oracle?.externalMarket;
    const externalProof = external?.proof || {};
    const lifecycle = newest(values.oracleEvents?.events, event => event.eventType === 'proposal_lifecycle'
        && /^sha256:[a-f0-9]{64}$/.test(event.source?.hash || '') && Boolean(event.source?.transaction));
    const records = values.publicRecords;
    const chronology = externalProof.chronology;

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
            && values.proofManifest?.publicProof?.prospectiveMarket === `${base}/oracle/markets/prospective/status`),
        'Hackathon scope and public evidence links are machine-readable',
        values.proofManifest?.hackathon || errors.proofManifest || null),
        check('prospective_resolver_status', Boolean(values.prospectiveStatus?.market === external?.prospectiveProof?.market
            && ['open', 'checking_evidence', 'awaiting_evidence', 'settled'].includes(values.prospectiveStatus?.state)),
        'The prospective market exposes a redacted live resolver state',
        values.prospectiveStatus ? {
            market: values.prospectiveStatus.market,
            state: values.prospectiveStatus.state,
            lastCheck: values.prospectiveStatus.resolver?.lastRun?.endedAt || null
        } : errors.prospectiveStatus || null),
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

export { cleanBase, exactResource };
