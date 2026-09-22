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

export function parcelSetIdentity(proposal = {}) {
    return buildParcelSet({
        parcelIds: proposal.cadastreParcelIds || [],
        jurisdiction: proposal.city || 'unknown',
        referenceAt: proposal.createdAt || null,
        geometryHash: proposal.cadastreFrame?.geometryHash || null
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
    if (!market.exists) return stage('forecast', 'Forecast', 'pending', 'No proposal market exists yet.');
    const yes = number(market.yesUsdc);
    const no = number(market.noUsdc);
    const detail = `${yes} devnet USDC YES; ${no} devnet USDC NO.`;
    return stage('forecast', 'Forecast', yes > 0 && no > 0 ? 'complete' : yes > 0 || no > 0 ? 'partial' : 'pending', detail, [accountLink(market.account)]);
}

function decisionStage(proposal, activity) {
    const lifecycle = String(proposal.lifecycleStatus || 'Active');
    const terminal = TERMINAL_LIFECYCLES.has(lifecycle.toLowerCase());
    const evidence = activity
        .filter(event => ['accept', 'execute', 'cancel', 'expire'].includes(event.action?.type))
        .map(event => transactionLink(event.transaction));
    return stage('decision', 'Owner or lifecycle decision', terminal ? 'complete' : 'pending',
        terminal ? `Proposal lifecycle is ${lifecycle}.` : `Proposal lifecycle is ${lifecycle}; no terminal decision has been recorded.`, evidence);
}

function evidenceStage(oracleEvents) {
    if (!Array.isArray(oracleEvents)) return stage('evidence', 'Public evidence', 'unavailable', 'Oracle event state is unavailable.');
    const event = oracleEvents[0];
    if (!event) return stage('evidence', 'Public evidence', 'pending', 'No source-hashed terminal event exists for this proposal yet.');
    return stage('evidence', 'Public evidence', 'complete', `${event.eventType} recorded outcome ${event.outcome}.`, [
        event.source?.transactionUrl || transactionLink(event.source?.transaction),
        event.source?.url
    ]);
}

function resolutionStage(market, oracleEvents) {
    if (!market || market.state === 'unavailable') {
        return stage('resolution', 'Permissionless resolution', 'unavailable', market?.error || 'On-chain market state is unavailable.');
    }
    if (!market.exists) return stage('resolution', 'Permissionless resolution', 'blocked', 'A market must exist before it can resolve.');
    if (market.resolved) return stage('resolution', 'Permissionless resolution', 'complete', `Market resolved ${market.outcome}.`, [accountLink(market.account)]);
    if (oracleEvents?.length) return stage('resolution', 'Permissionless resolution', 'ready', 'Qualifying evidence exists; any wallet may submit resolution.', [accountLink(market.account)]);
    return stage('resolution', 'Permissionless resolution', 'pending', 'Market is open and waits for a terminal source-hashed event.', [accountLink(market.account)]);
}

function settlementStage(market, activity) {
    const terminal = activity.filter(event => [
        'claim', 'refund', 'refundMyDonations', 'release', 'releaseDonations', 'fulfil', 'fulfill', 'fulfillPledge'
    ].includes(event.action?.type));
    if (terminal.length) {
        return stage('settlement', 'Payout or refund', 'complete', `${terminal.length} terminal money-moving action${terminal.length === 1 ? '' : 's'} recorded.`, terminal.map(event => transactionLink(event.transaction)));
    }
    if (!market?.resolved) return stage('settlement', 'Payout or refund', 'blocked', 'Settlement becomes available after the relevant lifecycle or market outcome.');
    return stage('settlement', 'Payout or refund', 'pending', 'The market is resolved, but no claim or refund activity is recorded yet.');
}

export function buildHackathonCase({ proposal, activity = [], support = null, market = null, oracleEvents = [], links = {}, generatedAt } = {}) {
    if (!proposal?.proposalId) throw new Error('proposal with proposalId is required');
    const parcelSet = parcelSetIdentity(proposal);
    const proposalAccount = proposal.onchain?.proposalId || null;
    const proposalEvidence = unique([
        proposal.onchain?.transactionHash,
        ...activity.filter(event => ['create', 'publish'].includes(event.action?.type)).map(event => event.transaction)
    ]).map(transactionLink);
    const stages = [
        stage('proposal', 'Paid proposal', proposalAccount ? 'complete' : 'partial', proposalAccount
            ? `Proposal anchors ${parcelSet.parcelCount} cadastral parcel${parcelSet.parcelCount === 1 ? '' : 's'} to a Solana account.`
            : 'The public proposal exists, but no Solana proposal account is attached.', proposalEvidence),
        supportStage(support, activity),
        forecastStage(market),
        decisionStage(proposal, activity),
        evidenceStage(oracleEvents),
        resolutionStage(market, oracleEvents),
        settlementStage(market, activity)
    ];
    const transactions = unique(activity.map(event => event.transaction)).map(signature => ({
        signature, url: transactionLink(signature), action: activity.find(event => event.transaction === signature)?.action?.type || null
    }));
    const actors = Array.from(new Map(activity.filter(event => event.actor?.id)
        .map(event => [event.actor.wallet || event.actor.id, event.actor])).values());
    const complete = stages.filter(item => item.state === 'complete').length;
    return {
        version: 1,
        id: proposal.proposalId,
        generatedAt: generatedAt || new Date().toISOString(),
        state: complete === stages.length ? 'complete' : complete > 1 ? 'in_progress' : 'early',
        proposal: {
            id: proposal.proposalId,
            databaseId: proposal.id ?? null,
            name: proposal.name || proposal.title || proposal.proposalId,
            city: proposal.city || null,
            author: proposal.author || null,
            lifecycleStatus: proposal.lifecycleStatus || null,
            createdAt: proposal.createdAt || null,
            account: proposalAccount,
            agent: proposal.agent || null
        },
        parcelSet,
        branches: {
            support: { donations: support?.donations || null, pledges: support?.pledges || null },
            forecast: market?.exists ? market : null,
            evidence: oracleEvents
        },
        stages,
        relationships: [
            { from: 'proposal', to: 'support', kind: 'can_progress_in_parallel' },
            { from: 'proposal', to: 'forecast', kind: 'can_progress_in_parallel' },
            { from: 'proposal', to: 'decision', kind: 'can_progress_in_parallel' },
            { from: 'decision', to: 'evidence', kind: 'materializes' },
            { from: 'forecast', to: 'resolution', kind: 'awaits' },
            { from: 'evidence', to: 'resolution', kind: 'authorizes' },
            { from: 'resolution', to: 'settlement', kind: 'unlocks' }
        ],
        actors,
        activity,
        transactions,
        progress: { complete, total: stages.length },
        links
    };
}
