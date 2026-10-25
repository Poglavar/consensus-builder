// The judge's case graph of one agreement (routes/hackathon-cases.js): its parcel set, the stages from
// minting through support, forecast, decision, public evidence, resolution and settlement, and the
// activity, actors and transactions behind them. Pure.
import { buildParcelSet } from '../proposals/parcel-set.js';

const TERMINAL_LIFECYCLES = new Set(['executed', 'cancelled', 'expired']);

function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function stage(id, label, state, detail, evidence = []) {
    return { id, label, state, detail, evidence: evidence.filter(Boolean) };
}

function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

function transactionLink(signature) {
    return signature ? `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet` : null;
}

function accountLink(address) {
    return address ? `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet` : null;
}

export function parcelSetIdentity(agreement = {}) {
    return buildParcelSet({
        parcelIds: agreement.inputParcelIds || [],
        jurisdiction: agreement.city || null
    });
}

function supportStage(support, activity = []) {
    if (!support || support.state === 'unavailable') {
        return stage('support', 'Support', 'unavailable', support?.error || 'On-chain support state is unavailable.');
    }
    const donation = number(support.donations?.totalUsdc);
    const pledgeEvent = [...activity].reverse().find(event => event.action?.type === 'pledge');
    const pledge = number(support.pledges?.activeUsdc) + number(support.pledges?.fulfilledUsdc)
        || number(pledgeEvent?.action?.amount);
    const donated = number(support.donations?.donationCount) > 0 || donation > 0;
    const pledged = number(support.pledges?.pledgeCount) > 0 || pledge > 0;
    const evidence = [support.donations?.escrow, support.pledges?.book].map(accountLink);
    if (donated && pledged) {
        const donationState = number(support.donations?.refundedUsdc) > 0 ? ' and later refunded'
            : support.donations?.released ? ' and later released' : '';
        const pledgeState = activity.some(event => event.action?.type === 'voidPledge') ? ' and later voided'
            : number(support.pledges?.fulfilledUsdc) > 0 ? ' and later fulfilled'
                : number(support.pledges?.revokedUsdc) > 0 ? ' and later revoked' : '';
        return stage('support', 'Donate and pledge', 'complete', `${donation} devnet USDC donated${donationState}; ${pledge} devnet USDC pledged${pledgeState}.`, evidence);
    }
    if (donated || pledged) {
        return stage('support', 'Donate and pledge', 'partial', donated
            ? `${donation} devnet USDC donated; no pledge is currently recorded.`
            : `${pledge} devnet USDC pledged; no funded donation is currently recorded.`, evidence);
    }
    return stage('support', 'Donate and pledge', 'pending', 'No funded donation or active pledge is currently recorded.', evidence);
}

function forecastStage(market) {
    if (!market || market.state === 'unavailable') {
        return stage('forecast', 'Forecast', 'unavailable', market?.error || 'On-chain market state is unavailable.');
    }
    if (!market.exists) return stage('forecast', 'Forecast', 'pending', 'No market exists for this agreement yet.');
    const yes = number(market.yesUsdc);
    const no = number(market.noUsdc);
    const detail = `${yes} devnet USDC YES; ${no} devnet USDC NO.`;
    return stage('forecast', 'Forecast', yes > 0 && no > 0 ? 'complete' : yes > 0 || no > 0 ? 'partial' : 'pending', detail, [accountLink(market.account)]);
}

function decisionStage(agreement, activity) {
    const status = String(agreement.status || 'active');
    const terminal = TERMINAL_LIFECYCLES.has(status.toLowerCase());
    const evidence = activity
        .filter(event => ['attest', 'execute', 'cancel', 'expire'].includes(event.action?.type))
        .map(event => transactionLink(event.transaction));
    return stage('decision', 'Decision and lifecycle', terminal ? 'complete' : 'pending',
        terminal ? `The agreement is ${status}.` : `The agreement is ${status}; no terminal decision has been recorded.`, evidence);
}

export function lifecycleEvidence(agreement, oracleEvents) {
    return oracleEvents?.find(event => event.eventType === 'agreement_lifecycle'
        && event.subject?.type === 'agreement' && event.subject.id === agreement.account
        && event.outcome === agreement.status && TERMINAL_LIFECYCLES.has(event.outcome)
        && /^sha256:[a-f0-9]{64}$/.test(event.source?.hash || '') && event.source?.transaction) || null;
}

function evidenceStage(agreement, oracleEvents) {
    if (!Array.isArray(oracleEvents)) return stage('evidence', 'Public evidence', 'unavailable', 'Oracle event state is unavailable.');
    const event = lifecycleEvidence(agreement, oracleEvents);
    if (!event) return stage('evidence', 'Public evidence', 'pending', 'No source-hashed terminal event exists for this agreement yet.');
    return stage('evidence', 'Public evidence', 'complete', `${event.eventType} recorded outcome ${event.outcome}.`, [
        event.source?.transactionUrl || transactionLink(event.source?.transaction),
        event.source?.url
    ]);
}

function resolutionStage(market, evidence) {
    if (!market || market.state === 'unavailable') {
        return stage('resolution', 'Permissionless resolution', 'unavailable', market?.error || 'On-chain market state is unavailable.');
    }
    if (!market.exists) return stage('resolution', 'Permissionless resolution', 'blocked', 'A market must exist before it can resolve.');
    if (market.resolved) return stage('resolution', 'Permissionless resolution', 'complete', `Market resolved ${market.outcome}.`, [accountLink(market.account)]);
    if (evidence) return stage('resolution', 'Permissionless resolution', 'ready', 'Terminal agreement state is recorded; any wallet may submit resolution.', [accountLink(market.account)]);
    return stage('resolution', 'Permissionless resolution', 'pending', 'Market is open and waits for a terminal agreement state.', [accountLink(market.account)]);
}

function settlementStage(market, activity) {
    const terminal = activity.filter(event => event.ok !== false && event.transaction && [
        'claim', 'refund', 'refundMyDonations', 'release', 'releaseDonations', 'fulfil', 'fulfill', 'fulfillPledge'
    ].includes(event.action?.type));
    if (terminal.length) {
        return stage('settlement', 'Payout or refund', 'complete', `${terminal.length} terminal money-moving action${terminal.length === 1 ? '' : 's'} recorded.`, terminal.map(event => transactionLink(event.transaction)));
    }
    if (!market?.resolved) return stage('settlement', 'Payout or refund', 'blocked', 'Settlement becomes available after the relevant lifecycle or market outcome.');
    return stage('settlement', 'Payout or refund', 'pending', 'The market is resolved, but no claim or refund activity is recorded yet.');
}

export function buildHackathonCase({ agreement, activity = [], activityError = null, support = null, market = null, oracleEvents = [], links = {}, generatedAt } = {}) {
    if (!agreement?.cid) throw new Error('an agreement with its cid is required');
    const parcelSet = parcelSetIdentity(agreement);
    const minted = Boolean(agreement.onchain?.account);
    const mintEvidence = unique([
        agreement.onchain?.signature,
        ...activity.filter(event => ['mint', 'fund'].includes(event.action?.type)).map(event => event.transaction)
    ]).map(transactionLink);
    const stages = [
        stage('agreement', 'Minted agreement', minted ? 'complete' : 'partial', minted
            ? `The agreement settles ${parcelSet.parcelCount} cadastral parcel${parcelSet.parcelCount === 1 ? '' : 's'} and is minted as Solana account ${agreement.onchain.account}.`
            : 'The agreement is published, but its Solana account is not recorded yet.', [...mintEvidence, accountLink(agreement.onchain?.account)]),
        supportStage(support, activity),
        forecastStage(market),
        decisionStage(agreement, activity),
        evidenceStage(agreement, oracleEvents),
        resolutionStage(market, lifecycleEvidence(agreement, oracleEvents)),
        settlementStage(market, activity)
    ];
    const transactions = unique(activity.map(event => event.transaction)).map(signature => ({
        signature, url: transactionLink(signature), action: activity.find(event => event.transaction === signature)?.action?.type || null
    }));
    const actors = Array.from(new Map(activity.filter(event => event.actor?.id)
        .map(event => [event.actor.wallet || event.actor.id, event.actor])).values());
    const complete = stages.filter(item => item.state === 'complete').length;
    // The headline proves the outcome. Optional support branches retain their own progress; a market
    // payout does not imply that every pledge was fulfilled or that there were stakes on both sides.
    const expectedOutcome = agreement.status === 'executed' ? 'YES'
        : ['cancelled', 'expired'].includes(agreement.status) ? 'NO' : null;
    const confirmed = type => activity.some(event => event.ok === true && event.transaction
        && event.provenance?.source === 'solana_transaction' && event.action?.type === type);
    const requirements = {
        mint: minted && confirmed('mint'),
        forecast: Boolean(market?.exists && (number(market.yesUsdc) > 0 || number(market.noUsdc) > 0) && confirmed('stake')),
        decision: Boolean(expectedOutcome && confirmed(agreement.status === 'executed' ? 'execute' : agreement.status === 'cancelled' ? 'cancel' : 'expire')
            && (agreement.status !== 'executed' || confirmed('attest'))),
        evidence: Boolean(lifecycleEvidence(agreement, oracleEvents)),
        resolution: Boolean(expectedOutcome && market?.resolved && market.outcome === expectedOutcome && confirmed('resolve')),
        claim: confirmed('claim')
    };
    return {
        version: 2,
        id: agreement.cid,
        generatedAt: generatedAt || new Date().toISOString(),
        state: complete === stages.length ? 'complete' : complete > 1 ? 'in_progress' : 'early',
        outcomeProof: {
            state: !activityError && Object.values(requirements).every(Boolean) ? 'verified' : 'incomplete',
            outcome: expectedOutcome,
            missing: Object.entries(requirements).filter(([, passed]) => !passed).map(([key]) => key),
            activityError
        },
        agreement: {
            cid: agreement.cid,
            name: agreement.title || agreement.cid,
            city: agreement.city || null,
            author: agreement.author || null,
            sponsor: agreement.sponsor || null,
            status: agreement.status || null,
            createdAt: agreement.createdAt || null,
            deadline: agreement.deadline || null,
            account: agreement.account || null
        },
        parcelSet,
        branches: {
            support: { donations: support?.donations || null, pledges: support?.pledges || null },
            forecast: market?.exists ? market : null,
            evidence: oracleEvents
        },
        stages,
        relationships: [
            { from: 'agreement', to: 'support', kind: 'can_progress_in_parallel' },
            { from: 'agreement', to: 'forecast', kind: 'can_progress_in_parallel' },
            { from: 'agreement', to: 'decision', kind: 'can_progress_in_parallel' },
            { from: 'decision', to: 'evidence', kind: 'materializes' },
            { from: 'forecast', to: 'resolution', kind: 'awaits' },
            { from: 'decision', to: 'resolution', kind: 'authorizes' },
            { from: 'resolution', to: 'settlement', kind: 'unlocks' }
        ],
        actors,
        activity,
        transactions,
        progress: { complete, total: stages.length },
        links
    };
}
