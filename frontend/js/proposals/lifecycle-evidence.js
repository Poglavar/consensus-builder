// Pure projection of proposal lifecycle claims onto qualified evidence.
// Local map application and purchase simulations are deliberately not lifecycle evidence.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalLifecycleEvidence = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const PROTOCOL = 'proposal-lifecycle-evidence/1';
    const STATUSES = Object.freeze(['Active', 'Executed', 'Cancelled', 'Expired', 'draft']);
    const TERMINAL = new Set(['Executed', 'Cancelled', 'Expired']);
    const PROPOSAL_CHAIN_PROTOCOL = 'proposal-chain/1';
    const LIFECYCLE_EVENT_TYPE = 'proposal_lifecycle';
    const SOLANA_PROPOSAL_PROGRAM = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
    const EVENT_STATUS = Object.freeze({ executed: 'Executed', cancelled: 'Cancelled', expired: 'Expired' });
    const EVENT_STATUS_BYTE = Object.freeze({ Executed: 1, Cancelled: 2, Expired: 3 });

    function canonicalStatus(value) {
        if (typeof value !== 'string') return null;
        const normalized = value.trim().toLowerCase();
        return STATUSES.find(status => status.toLowerCase() === normalized) || null;
    }

    function validTime(value) {
        if (typeof value !== 'string' || !value.trim()) return false;
        return Number.isFinite(Date.parse(value));
    }

    function chainMirrorObservation(mirror) {
        if (!mirror || typeof mirror !== 'object' || mirror.protocol !== PROPOSAL_CHAIN_PROTOCOL
            || !mirror.ref || typeof mirror.ref !== 'object'
            || typeof mirror.ref.chainType !== 'string' || !mirror.ref.chainType
            || typeof mirror.ref.chainId !== 'string' || !mirror.ref.chainId
            || typeof mirror.ref.contract !== 'string' || !mirror.ref.contract
            || typeof mirror.ref.tokenId !== 'string' || !mirror.ref.tokenId
            || !validTime(mirror.verifiedAt)) return null;
        const lifecycle = mirror.lifecycle;
        const status = canonicalStatus(lifecycle?.status);
        if (!status || !validTime(lifecycle.observedAt)) return null;
        return {
            source: 'chain-mirror',
            status,
            observedAt: new Date(lifecycle.observedAt).toISOString(),
            verifiedAt: new Date(mirror.verifiedAt).toISOString(),
            chainRef: { ...mirror.ref }
        };
    }

    function lifecycleEventObservation(event, mirror) {
        if (!event || typeof event !== 'object' || event.eventType !== LIFECYCLE_EVENT_TYPE
            || event.subject?.type !== 'proposal' || !mirror?.ref) return null;
        const eventStatus = EVENT_STATUS[event.outcome];
        const evidence = event.evidence;
        const source = event.source;
        const ref = mirror.ref;
        if (!eventStatus || ref.chainType !== 'solana'
            || ref.chainId !== 'solana-devnet' || ref.contract !== SOLANA_PROPOSAL_PROGRAM
            || String(event.subject.id || '') !== String(ref.tokenId || '')
            || !validTime(event.observedAt)
            || event.attester?.kind !== 'solana_program'
            || event.attester?.address !== SOLANA_PROPOSAL_PROGRAM
            || source?.chain !== 'solana:devnet'
            || typeof source.transaction !== 'string' || !source.transaction.trim()
            || typeof source.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(source.hash)
            || evidence?.proposalStatusByte !== EVENT_STATUS_BYTE[eventStatus]) return null;
        return {
            source: 'land-event',
            status: eventStatus,
            observedAt: new Date(event.observedAt).toISOString(),
            eventId: typeof event.id === 'string' ? event.id : null,
            transaction: source.transaction,
            sourceHash: source.hash,
            attester: event.attester.address
        };
    }

    function chainReadObservation(chainRead) {
        const status = canonicalStatus(chainRead?.status);
        const ref = chainRead?.chainRef;
        if (!status || !validTime(chainRead?.observedAt) || !ref || typeof ref !== 'object'
            || typeof ref.chainType !== 'string' || !ref.chainType
            || typeof ref.chainId !== 'string' || !ref.chainId
            || typeof ref.contract !== 'string' || !ref.contract
            || typeof ref.tokenId !== 'string' || !ref.tokenId) return null;
        return {
            source: 'chain-state-read', status,
            observedAt: new Date(chainRead.observedAt).toISOString(),
            chainRef: { ...ref }
        };
    }

    function deadlineObservation(status, expiresAt, now) {
        if (status !== 'Expired' || !validTime(expiresAt)) return null;
        const asOf = now instanceof Date ? now : new Date(now);
        const expires = new Date(expiresAt);
        if (!Number.isFinite(asOf.getTime()) || expires.getTime() > asOf.getTime()) return null;
        return {
            source: 'expiry-deadline',
            status: 'Expired',
            expiresAt: expires.toISOString(),
            evaluatedAt: asOf.toISOString()
        };
    }

    function projectLifecycleEvidence({ lifecycleStatus, chainMirror, lifecycleEvent, chainRead, expiresAt, now = new Date() } = {}) {
        const claimedStatus = canonicalStatus(lifecycleStatus);
        if (!claimedStatus) {
            return {
                lifecycleStatus: 'Unknown',
                lifecycleEvidence: { protocol: PROTOCOL, state: 'unknown', claimedStatus: null }
            };
        }

        const observations = [];
        const mirrorObservation = chainMirrorObservation(chainMirror);
        if (mirrorObservation) observations.push(mirrorObservation);
        const eventObservation = lifecycleEventObservation(lifecycleEvent, chainMirror);
        if (eventObservation) observations.push(eventObservation);
        const readObservation = chainReadObservation(chainRead);
        if (readObservation) observations.push(readObservation);

        const latestObservedAt = observations.reduce((latest, observation) =>
            Math.max(latest, Date.parse(observation.observedAt)), -Infinity);
        const latestObservations = observations.filter(observation => Date.parse(observation.observedAt) === latestObservedAt);
        const latestStatuses = Array.from(new Set(latestObservations.map(observation => observation.status)));
        const conflictingTerminalObservation = observations.some(observation =>
            TERMINAL.has(observation.status) && observation.status !== claimedStatus);
        if (latestStatuses.length === 1 && latestStatuses[0] === claimedStatus && !conflictingTerminalObservation) {
            const primary = latestObservations.find(observation => observation.source === 'land-event')
                || latestObservations.find(observation => observation.source === 'chain-state-read')
                || latestObservations[0];
            return {
                lifecycleStatus: claimedStatus,
                lifecycleEvidence: {
                    protocol: PROTOCOL,
                    state: 'observed',
                    status: claimedStatus,
                    source: primary.source,
                    observedAt: primary.observedAt,
                    observations
                }
            };
        }

        const deadline = deadlineObservation(claimedStatus, expiresAt, now);
        if (deadline && !conflictingTerminalObservation) {
            return {
                lifecycleStatus: 'Expired',
                lifecycleEvidence: { protocol: PROTOCOL, state: 'derived', ...deadline }
            };
        }

        return {
                // Lifecycle state remains the operational axis. Evidence qualifies the claim and
                // presentation independently; missing proof must not undo cancellation/expiry.
                lifecycleStatus: claimedStatus,
            lifecycleEvidence: {
                protocol: PROTOCOL,
                state: 'unknown',
                claimedStatus,
                reason: 'no-matching-observation',
                ...(observations.length ? { observations } : {})
            }
        };
    }

    function hasObservedStatus(proposal, status) {
        const evidence = proposal?.lifecycleEvidence;
        return !!evidence && evidence.protocol === PROTOCOL && evidence.state === 'observed'
            && canonicalStatus(evidence.status) === canonicalStatus(status)
            && validTime(evidence.observedAt);
    }

    function hasDerivedDeadlineStatus(proposal) {
        const evidence = proposal?.lifecycleEvidence;
        if (evidence?.protocol === PROTOCOL && evidence.state === 'derived'
            && evidence.source === 'expiry-deadline' && evidence.status === 'Expired'
            && validTime(evidence.expiresAt) && validTime(evidence.evaluatedAt)) return true;
        return canonicalStatus(proposal?.lifecycleStatus) === 'Expired'
            && validTime(proposal?.expiresAt) && Date.parse(proposal.expiresAt) <= Date.now();
    }

    return Object.freeze({
        PROTOCOL,
        STATUSES,
        canonicalStatus,
        projectLifecycleEvidence,
        chainReadObservation,
        hasObservedStatus,
        hasDerivedDeadlineStatus
    });
});
