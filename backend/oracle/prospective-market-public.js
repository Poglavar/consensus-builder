// Public, privacy-preserving projection of the prospective court-market experiment. The private
// state file contains the parcel and outcome operations; this module exposes only commitments,
// aggregate stakes, scheduler health and public Solana evidence.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PROSPECTIVE_MARKET = Object.freeze({
    market: 'Atps3gg4ZCvDMtbosTK5Evrb1PAwY2shUBvkzjihkaNQ',
    recipeHash: 'sha256:1d8195b99b29f3c46b8902b703efea223513f63debd8eecb07bc02956aee9175',
    closesAt: '2026-09-22T21:00:00.000Z',
    chain: 'solana:devnet',
    stakeMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    stakePerSideAtomic: '10000',
    decimals: 6,
    transactions: Object.freeze({
        create: '5Xj91vDkDa71qAXjpkxoyBJXRxXPw7Fc333Tx9eW71LMQ3wCLvxNUR3RwxL8U22oioYpUgMHz59XY5zWB9tAvSpd',
        yesStake: '38v9wsfiW4eAkbFvqVyRH3npT7exUon44fEFUpM3p9PQwtYbnPSQv83rDFnmYuF7ccy5xgtXZZ51KaLRtB1eyPDe',
        noStake: '3Hr8pZSS76ff4ZXpHEn1DMymt9oZ9BQQDVxYZykf8FQrL4bPhL9W5fwsv3kRFftgDEe31UxJSicWF3ksaDUodKCU'
    })
});

const DEFAULT_STATS_FILE = fileURLToPath(new URL('../logs/prospective-resolver-stats.json', import.meta.url));

function finiteTime(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function positiveInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function safeLastRun(runStats) {
    if (!runStats || runStats.job !== 'prospective-market-resolver') return null;
    if (runStats.market && runStats.market !== PROSPECTIVE_MARKET.market) return null;
    return {
        status: ['completed', 'failed'].includes(runStats.runStatus) ? runStats.runStatus : 'unknown',
        phase: typeof runStats.phase === 'string' ? runStats.phase : null,
        readiness: typeof runStats.readiness === 'string' ? runStats.readiness : null,
        startedAt: finiteTime(runStats.startedAt),
        endedAt: finiteTime(runStats.endedAt)
    };
}

function safeSettlement(runStats) {
    if (!runStats || runStats.phase !== 'settled') return null;
    const transactions = runStats.transactions || {};
    const evidence = runStats.evidence || {};
    const chronology = runStats.chronology || {};
    if (chronology.classification !== 'prospective' || chronology.prospective !== true) return null;
    return {
        outcome: ['YES', 'NO'].includes(runStats.outcome) ? runStats.outcome : null,
        evidence: {
            address: typeof evidence.address === 'string' ? evidence.address : null,
            hash: /^sha256:[a-f0-9]{64}$/.test(evidence.hash || '') ? evidence.hash : null
        },
        transactions: {
            evidenceFirstSeen: typeof transactions.evidenceFirstSeen === 'string' ? transactions.evidenceFirstSeen : null,
            resolution: typeof transactions.resolve === 'string' ? transactions.resolve : null,
            claim: typeof transactions.claim === 'string' ? transactions.claim : null
        },
        chronology: {
            classification: 'prospective',
            prospective: true,
            marketOrderValid: chronology.marketOrderValid === true,
            attestationAfterClose: chronology.attestationAfterClose === true,
            sourceTimeVerified: chronology.sourceTimeVerified === true,
            sourceAfterClose: chronology.sourceAfterClose === true,
            timestamps: {
                marketCreatedAt: finiteTime(chronology.timestamps?.marketCreatedAt),
                yesStakeAt: finiteTime(chronology.timestamps?.yesStakeAt),
                noStakeAt: finiteTime(chronology.timestamps?.noStakeAt),
                lastStakeAt: finiteTime(chronology.timestamps?.lastStakeAt),
                marketClosesAt: finiteTime(chronology.timestamps?.marketClosesAt),
                sourceObservedAt: finiteTime(chronology.timestamps?.sourceObservedAt),
                evidenceCreatedAt: finiteTime(chronology.timestamps?.evidenceCreatedAt),
                resolvedAt: finiteTime(chronology.timestamps?.resolvedAt),
                claimedAt: finiteTime(chronology.timestamps?.claimedAt)
            },
            transactionSlots: {
                evidenceFirstSeen: positiveInteger(chronology.transactionSlots?.evidenceFirstSeen),
                resolution: positiveInteger(chronology.transactionSlots?.resolution),
                claim: positiveInteger(chronology.transactionSlots?.claim)
            },
            reason: typeof chronology.reason === 'string' ? chronology.reason : null
        }
    };
}

export function buildProspectiveMarketStatus({ runStats = null, now = Date.now() } = {}) {
    const lastRun = safeLastRun(runStats);
    const settlement = safeSettlement(runStats);
    const afterClose = Number(now) >= Date.parse(PROSPECTIVE_MARKET.closesAt);
    let state = afterClose ? 'checking_evidence' : 'open';
    if (lastRun?.status === 'failed') state = 'resolver_error';
    else if (lastRun?.phase === 'settled') state = 'settled';
    else if (lastRun?.readiness === 'no_matching_post_close_attestation'
        || lastRun?.phase === 'awaiting_evidence') state = 'awaiting_evidence';
    else if (!afterClose && lastRun?.readiness === 'market_open') state = 'open';

    const stakePerSide = Number(PROSPECTIVE_MARKET.stakePerSideAtomic) / (10 ** PROSPECTIVE_MARKET.decimals);
    return {
        version: 1,
        experiment: 'first-prospective-court-market',
        state,
        chain: PROSPECTIVE_MARKET.chain,
        market: PROSPECTIVE_MARKET.market,
        marketUrl: `https://explorer.solana.com/address/${PROSPECTIVE_MARKET.market}?cluster=devnet`,
        recipeHash: PROSPECTIVE_MARKET.recipeHash,
        closesAt: PROSPECTIVE_MARKET.closesAt,
        stakes: {
            symbol: 'USDC', mint: PROSPECTIVE_MARKET.stakeMint,
            yes: stakePerSide, no: stakePerSide, pool: stakePerSide * 2,
            atomicPerSide: PROSPECTIVE_MARKET.stakePerSideAtomic,
            decimals: PROSPECTIVE_MARKET.decimals
        },
        transactions: PROSPECTIVE_MARKET.transactions,
        settlement,
        resolver: {
            schedule: '45 * * * *',
            cadence: 'hourly at minute 45',
            settlementMode: 'live, permissionless and idempotent',
            lastRun
        },
        evidencePolicy: {
            source: 'Croatian judiciary e-Oglasna archive',
            requirement: 'a matching source-timestamped V2 court attestation first published after market close',
            temporalGuard: 'market close <= sourceObservedAt <= resolution time'
        },
        privacy: {
            redacted: ['parcelUid', 'yesOperation', 'noOperation', 'decisionUuid', 'decisionLink', 'wallets', 'rpcUrl'],
            reason: 'the public status proves chronology and automation without republishing parcel-level legal data'
        }
    };
}

export function readProspectiveMarketStatus({
    env = process.env,
    now = Date.now(),
    readFile = fs.readFileSync
} = {}) {
    const statsFile = env.PROSPECTIVE_RUN_STATS || DEFAULT_STATS_FILE;
    let runStats = null;
    try {
        runStats = JSON.parse(readFile(statsFile, 'utf8'));
    } catch (error) {
        if (error?.code !== 'ENOENT') console.warn('Could not read prospective resolver stats:', error.message);
    }
    return buildProspectiveMarketStatus({ runStats, now });
}
