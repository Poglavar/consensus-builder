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

// Lens entries arrive as base58 strings or `{ address, name }` objects (the frontend's stored shape).
function lensAddresses(lens) {
    if (!Array.isArray(lens)) return null;
    const addresses = lens.map(entry => typeof entry === 'string' ? entry : entry?.address || entry?.key || null)
        .filter(Boolean).map(String);
    return addresses.length ? addresses : null;
}

// The lens a create event carries, if the activity/run payload exposes it at all.
function eventLens(event) {
    return lensAddresses(event?.action?.lens) || lensAddresses(event?.lens) || null;
}

// The lens a public proposal record carries: the stored lens column first, then the on-chain copy.
function recordLens(record) {
    return lensAddresses(record?.lens) || lensAddresses(record?.onchain?.lens)
        || lensAddresses(record?.onchainData?.lens) || null;
}

const eventParcel = event => event?.action?.parcelId || event?.action?.parcelUid || event?.parcelId || null;
const eventOwner = event => event?.action?.owner || event?.action?.signer || event?.actor?.wallet || null;

/**
 * Attested execution (lens model v3 case): every parcel carries a lens member's ownership attestation,
 * every attested owner signed its acceptance, the proposal is Executed, and the YES side was resolved
 * and claimed. The v1 certificate-holder `accept` path must not appear at all.
 */
function evaluateAttestedCase(attested) {
    if (!attested) return { ok: false, evidence: null };
    const activity = attested.activity || [];
    const withTx = type => activity.filter(event => event.action?.type === type && Boolean(event.transaction));
    const parcelCount = Number(attested.parcelSet?.parcelCount || 0);
    const attestations = withTx('attestOwnership');
    const acceptances = withTx('acceptance');
    const attestedParcels = new Set(attestations.map(eventParcel).filter(Boolean));
    // Parcels with attestations are proven per parcel when events name them, else by count.
    const parcelsAttested = attestedParcels.size > 0 ? attestedParcels.size : attestations.length;
    // Required signatures: sum of each parcel's ownerCount when exposed, else one per parcel.
    const ownerCounts = new Map();
    for (const event of attestations) {
        const count = Number(event.action?.ownerCount);
        const parcel = eventParcel(event);
        if (parcel && Number.isInteger(count) && count >= 1) ownerCounts.set(parcel, Math.max(ownerCounts.get(parcel) || 0, count));
    }
    const declared = attested.parcelSet?.ownerCounts;
    if (ownerCounts.size === 0 && declared && typeof declared === 'object') {
        Object.entries(declared).forEach(([parcel, count]) => {
            if (Number.isInteger(Number(count)) && Number(count) >= 1) ownerCounts.set(parcel, Number(count));
        });
    }
    const exposedCounts = ownerCounts.size > 0 && ownerCounts.size >= parcelCount;
    const requiredAcceptances = exposedCounts ? [...ownerCounts.values()].reduce((sum, count) => sum + count, 0) : parcelCount;
    // One acceptance per attested owner: distinct (parcel, owner) pairs when events name them.
    const pairs = new Set(acceptances.map(event => {
        const parcel = eventParcel(event);
        const owner = eventOwner(event);
        return parcel && owner ? `${parcel}\u0000${owner}` : null;
    }).filter(Boolean));
    const acceptanceCount = pairs.size > 0 ? pairs.size : acceptances.length;
    const legacyAccepts = withTx('accept').length;
    const has = (type, side = null) => activity.some(event => event.action?.type === type
        && (side === null || String(event.action?.side || '').toLowerCase() === side) && Boolean(event.transaction));
    const stagesComplete = ['decision', 'evidence', 'resolution', 'settlement']
        .every(id => attested.stages?.find(item => item.id === id)?.state === 'complete');
    const ok = Boolean(
        parcelCount >= 1
        && String(attested.proposal?.lifecycleStatus || '').toLowerCase() === 'executed'
        && parcelsAttested >= parcelCount
        && acceptanceCount >= requiredAcceptances
        && legacyAccepts === 0
        && attested.branches?.forecast?.resolved === true
        && String(attested.branches?.forecast?.outcome || '').toUpperCase() === 'YES'
        && has('resolve') && has('claim', 'yes')
        && stagesComplete
    );
    return {
        ok,
        evidence: {
            id: attested.id || null, lifecycleStatus: attested.proposal?.lifecycleStatus || null,
            parcelCount, parcelsAttested, attestations: attestations.length,
            acceptances: acceptanceCount, requiredAcceptances,
            requiredFrom: exposedCounts ? 'ownerCount' : 'parcelCount',
            legacyAccepts, outcome: attested.branches?.forecast?.outcome || null
        }
    };
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
    maxRunAgeHours = 48,
    lensWindowDays = 30,
    maxLensLookups = 50,
    // Optional: () => Promise<report> from oracle/open-ground-audit.js runOpenGroundAudit. It needs the
    // database and an RPC, which this HTTP-only audit never touches, so the operator opts in
    // (scripts/hackathon-proof-audit.mjs --open-ground); without it the check is not listed.
    openGroundAudit = null
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
        operations: '/hackathon/operations.json',
        lensMembers: '/lenses/members'
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
    const executedCaseUrl = values.proofManifest?.publicProof?.executedCase;
    if (executedCaseUrl) {
        try {
            values.executedCase = await readJson(fetchImpl, executedCaseUrl);
        } catch (error) {
            errors.executedCase = error instanceof Error ? error.message : String(error);
        }
    } else {
        errors.executedCase = 'proof manifest does not declare publicProof.executedCase';
    }

    const attestedCaseUrl = values.proofManifest?.publicProof?.attestedCase;
    if (attestedCaseUrl) {
        try {
            values.attestedCase = await readJson(fetchImpl, attestedCaseUrl);
        } catch (error) {
            errors.attestedCase = error instanceof Error ? error.message : String(error);
        }
    } else {
        errors.attestedCase = 'proof manifest does not declare publicProof.attestedCase';
    }

    const expectedProposal = `${base}/agent/proposals`;
    const expectedFact = `${base}/agent/oracle/facts`;
    const runs = values.runs?.runs || [];
    const events = values.activity?.events || [];
    const proposer = newest(runs, run => run.controller === 'algorithm'
        && (run.role || 'proposer') === 'proposer' && run.status === 'done');
    // A supporter day that finds its support already on-chain is a recorded no-op; the proof needs the
    // newest run that actually signed, and it must be recent.
    const supporter = newest(runs, run => run.controller === 'algorithm'
        && run.role === 'supporter' && run.status === 'done' && Boolean(run.support?.signature));
    const proposerAge = proposer ? Math.max(0, (Number(now) - time(proposer.updatedAt || proposer.finishedAt)) / 3_600_000) : Infinity;
    const supporterAge = supporter ? Math.max(0, (Number(now) - time(supporter.updatedAt || supporter.finishedAt)) / 3_600_000) : Infinity;
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
    // The executed case is the YES side of the same loop: every listed parcel accepted on-chain, the
    // proposal Executed, the market resolved YES, escrow released, pledge fulfilled and the YES claimed.
    const executed = values.executedCase;
    const executedActivities = executed?.activity || [];
    const executedAction = (type, side = null) => executedActivities.some(event => event.action?.type === type
        && (side === null || String(event.action?.side || '').toLowerCase() === side) && Boolean(event.transaction));
    const executedAccepts = executedActivities.filter(event => event.action?.type === 'accept' && Boolean(event.transaction)).length;
    const executedParcels = Number(executed?.parcelSet?.parcelCount || 0);
    const executedYes = Boolean(
        executed && executedParcels >= 2
        && String(executed.proposal?.lifecycleStatus || '').toLowerCase() === 'executed'
        && executedAccepts >= executedParcels
        && executed.branches?.forecast?.resolved === true
        && String(executed.branches?.forecast?.outcome || '').toUpperCase() === 'YES'
        && executedAction('resolve') && executedAction('releaseDonations') && executedAction('fulfillPledge')
        && executedAction('claim', 'yes')
        && ['decision', 'evidence', 'resolution', 'settlement']
            .every(id => executed.stages?.find(item => item.id === id)?.state === 'complete')
    );

    const attestedExecution = evaluateAttestedCase(values.attestedCase);

    // No self-lens: an agent proposal whose lens is only its creator's wallet is creator-decidable.
    // The lens comes from the create event when the feed exposes it, else from the public record.
    const lensWindowStart = Number(now) - lensWindowDays * 86_400_000;
    const creates = events.filter(event => event.action?.type === 'create'
        && time(event.recordedAt || event.occurredAt) >= lensWindowStart
        && Boolean(event.action?.proposalId || event.entity?.id));
    const createProposalId = event => String(event.action?.proposalId || event.entity?.id);
    const lookupIds = [...new Set(creates.filter(event => !eventLens(event)).map(createProposalId))].slice(0, maxLensLookups);
    const proposalRecords = new Map();
    await Promise.all(lookupIds.map(async id => {
        try {
            proposalRecords.set(id, await readJson(fetchImpl, `${base}/proposals/${encodeURIComponent(id)}`));
        } catch (error) {
            proposalRecords.set(id, { error: error instanceof Error ? error.message : String(error) });
        }
    }));
    const lensReport = creates.map(event => {
        const proposalId = createProposalId(event);
        const record = proposalRecords.get(proposalId);
        const lens = eventLens(event) || recordLens(record);
        const creator = event.actor?.wallet || null;
        return {
            proposalId, creator, lens,
            lensFrom: eventLens(event) ? 'activity' : lens ? 'proposal_record' : null,
            self: Boolean(lens && creator && lens.every(address => address === creator))
        };
    });
    const selfLens = lensReport.filter(item => item.self);
    const undecided = lensReport.filter(item => !item.lens || !item.creator);
    const lensInsufficient = creates.length === 0 || undecided.length > 0;
    const noSelfLens = selfLens.length === 0 && !lensInsufficient;
    const noSelfLensEvidence = errors.activity || {
        windowDays: lensWindowDays, creates: creates.length,
        decided: lensReport.length - undecided.length,
        selfLens: selfLens.map(({ proposalId, creator }) => ({ proposalId, creator })),
        ...(lensInsufficient ? {
            insufficientData: creates.length === 0
                ? `no create events in the last ${lensWindowDays} days`
                : `${undecided.length} create event(s) expose neither a lens nor a creator wallet`,
            undecided: undecided.slice(0, 10).map(({ proposalId, creator, lens }) => ({
                proposalId, missing: [!lens && 'lens', !creator && 'creator'].filter(Boolean)
            }))
        } : {})
    };

    // Attester diversity: ownership attestations from at least two distinct lens members.
    const lensMembers = Array.isArray(values.lensMembers?.members) ? values.lensMembers.members : [];
    const attesters = lensMembers.filter(member => member?.key && Number(member.coverage?.ownership) > 0);

    // Open-ground audit: v3 accounts' site_hash/open_ground/parcel_ids against the published record.
    // Advisory: a chain with no v3 accounts (devnet is v1; layout_version 0 reads as legacy) checks
    // nothing and passes with its counts.
    let openGround = null;
    if (typeof openGroundAudit === 'function') {
        try {
            openGround = await openGroundAudit();
        } catch (error) {
            errors.openGroundAudit = error instanceof Error ? error.message : String(error);
        }
    }

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
        check('deterministic_supporter', Boolean(supporter && supporterAge <= maxRunAgeHours && supporterSignature && supporterAction?.transaction === supporterSignature),
            'A separate deterministic supporter backed another proposal on-chain',
            supporter ? {
                runId: supporter.id, type: supporter.support?.type || null, proposalId: supporter.support?.proposalId || null,
                transaction: supporterSignature, ageHours: Math.round(supporterAge * 10) / 10, maxAgeHours: maxRunAgeHours
            } : errors.runs || 'no completed supporter run carries a transaction'),
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
        check('executed_case_yes', executedYes,
            'A second real-parcel case executed on-chain and its market resolved YES and paid the winner',
            executed ? {
                id: executed.id, lifecycleStatus: executed.proposal?.lifecycleStatus || null,
                outcome: executed.branches?.forecast?.outcome || null, acceptances: executedAccepts,
                parcelCount: executedParcels, stages: executed.stages
            } : errors.executedCase || null),
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
            chronology?.classification || errors.docs || null, 'advisory'),
        // Lens-model checks: advisory until the v2 programs are deployed and the attested case has
        // run. Flipping one to required is deleting its trailing 'advisory'.
        check('attested_execution', attestedExecution.ok,
            'A case executed only through lens-member ownership attestations and owner signatures, and paid YES',
            attestedExecution.evidence || errors.attestedCase || null, 'advisory'),
        check('no_self_lens', noSelfLens,
            `No agent proposal created in the last ${lensWindowDays} days lists only its creator in its lens`,
            noSelfLensEvidence, 'advisory'),
        check('attester_diversity', attesters.length >= 2,
            'At least two distinct lens members have issued ownership attestations',
            values.lensMembers ? {
                members: lensMembers.length,
                attesters: attesters.map(member => ({ key: member.key, name: member.name || null, ownership: Number(member.coverage.ownership) }))
            } : errors.lensMembers || null, 'advisory'),
        ...(typeof openGroundAudit === 'function' ? [check('open_ground_audit',
            Boolean(openGround && Array.isArray(openGround.mismatches) && openGround.mismatches.length === 0
                && !(openGround.undecodable?.length > 0)),
            'Every v3 proposal account declares the site hash, open ground and parcels of its published record',
            openGround ? {
                accounts: openGround.accounts, records: openGround.records ?? null, checked: openGround.checked,
                mismatches: openGround.mismatches.length, byKind: openGround.byKind,
                skipped: openGround.skipped.length, skippedByReason: openGround.skippedByReason,
                undecodable: openGround.undecodable?.length ?? 0,
                examples: openGround.mismatches.slice(0, 10)
            } : errors.openGroundAudit || null, 'advisory')] : [])
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

export { cleanBase, evaluateAttestedCase, exactResource, lensAddresses, validateProspectiveSettlement };
