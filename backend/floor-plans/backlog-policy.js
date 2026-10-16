// Pure retry and completion policy for finite listing processing passes.
export function locationRetryKey(url, sha256) {
    return `${url}\n${sha256}`;
}

export function recordLocationFailure(failures, { url, sha256, error, now = Date.now(), maxAttempts = 3, retryDelayMs = 60_000 }) {
    const key = locationRetryKey(url, sha256);
    const previous = failures?.[key];
    const attempts = (previous?.attempts || 0) + 1;
    const attemptedAt = new Date(now);
    const nextRetryAt = new Date(now + retryDelayMs * (2 ** (attempts - 1)));
    return {
        ...(failures || {}),
        [key]: {
            url,
            sha256,
            attempts,
            error: error instanceof Error ? error.message : String(error),
            lastAttemptAt: attemptedAt.toISOString(),
            nextRetryAt: nextRetryAt.toISOString(),
            exhausted: attempts >= maxAttempts,
        },
    };
}

export function selectLocationWork(rows, failures, { now = Date.now(), limit = 50 } = {}) {
    const selected = [];
    const waiting = [];
    const exhausted = [];
    const unavailable = [];
    for (const row of rows) {
        if (!row.needsLocation) continue;
        if (!row.sourceAvailable) {
            unavailable.push(row);
            continue;
        }
        const failure = failures?.[locationRetryKey(row.url, row.sha256)];
        if (failure?.exhausted) {
            exhausted.push(row);
            continue;
        }
        if (failure && Date.parse(failure.nextRetryAt) > now) {
            waiting.push(row);
            continue;
        }
        if (selected.length < limit) selected.push(row);
        else waiting.push(row);
    }
    return { selected, waiting, exhausted, unavailable };
}

export function backlogDecision({
    actionableLocations = 0,
    retryLocations = 0,
    actionableTasks = 0,
    pendingBatches = 0,
    unknownBatches = 0,
    crawlActive = false,
    assetRemaining = 0,
    deferredItems = 0,
    errors = 0,
    budgetDeferred = false,
    stableRounds = 0,
} = {}) {
    if (unknownBatches > 0) return { status: 'reconciliation-required', done: true };

    const work = actionableLocations > 0 || actionableTasks > 0 || assetRemaining > 0;
    if (work && pendingBatches > 0) return { status: 'running', done: false };
    if (!work && pendingBatches > 0) return { status: 'waiting-provider', done: false };
    if (budgetDeferred && actionableTasks > 0 && actionableLocations === 0 && retryLocations === 0 && assetRemaining === 0) {
        return { status: 'budget-limit', done: true };
    }
    if (work) return { status: 'running', done: false };
    if (retryLocations > 0) return { status: 'waiting-retry', done: false };
    if (crawlActive) return { status: 'waiting-crawl', done: false };
    if (stableRounds < 2) return { status: 'confirming-idle', done: false };
    return errors > 0 || deferredItems > 0
        ? { status: 'needs-attention', done: true }
        : { status: 'stages-complete', done: true };
}

export function freshTerminalCheckpoint(state, { startedAt, exitCode, stalled = false } = {}) {
    if (stalled || !state || state.error || !Number.isFinite(startedAt)) return false;
    const finishedAt = Date.parse(state.finishedAt);
    if (!Number.isFinite(finishedAt) || finishedAt < startedAt) return false;
    if (['stages-complete', 'interrupted'].includes(state.status)) return exitCode === 0;
    return ['needs-attention', 'reconciliation-required', 'budget-limit'].includes(state.status) && exitCode === 2;
}
