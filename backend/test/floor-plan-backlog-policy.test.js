// Headless regression tests for finite backlog retry and completion decisions.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
    backlogDecision,
    freshTerminalCheckpoint,
    locationRetryKey,
    recordLocationFailure,
    selectLocationWork,
} from '../floor-plans/backlog-policy.js';

test('location work admits new discoveries and retries temporary failures after backoff', () => {
    const rows = [
        { url: 'https://example.test/a', sha256: 'a1', needsLocation: true, sourceAvailable: true },
        { url: 'https://example.test/b', sha256: 'b1', needsLocation: true, sourceAvailable: true },
    ];
    const failures = recordLocationFailure({}, { ...rows[0], error: new Error('temporary'), now: 1_000 });
    const early = selectLocationWork(rows, failures, { now: 60_999 });
    assert.deepEqual(early.selected, [rows[1]]);
    assert.deepEqual(early.waiting, [rows[0]]);

    const due = selectLocationWork(rows, failures, { now: 61_000 });
    assert.deepEqual(due.selected, rows);
});

test('location failures back off exponentially, exhaust, and reset for a new source hash', () => {
    const url = 'https://example.test/listing';
    const first = recordLocationFailure({}, { url, sha256: 'old', error: 'one', now: 1_000 });
    const second = recordLocationFailure(first, { url, sha256: 'old', error: 'two', now: 2_000 });
    const third = recordLocationFailure(second, { url, sha256: 'old', error: 'three', now: 3_000 });
    assert.equal(third[locationRetryKey(url, 'old')].attempts, 3);
    assert.equal(third[locationRetryKey(url, 'old')].nextRetryAt, new Date(243_000).toISOString());
    assert.equal(third[locationRetryKey(url, 'old')].exhausted, true);

    const rows = [{ url, sha256: 'old', needsLocation: true, sourceAvailable: true },
        { url, sha256: 'new', needsLocation: true, sourceAvailable: true }];
    const result = selectLocationWork(rows, third, { now: 4_000 });
    assert.deepEqual(result.exhausted, [rows[0]]);
    assert.deepEqual(result.selected, [rows[1]]);
});

test('location selection classifies unavailable sources and respects batch limits', () => {
    const rows = [
        { url: 'a', sha256: '1', needsLocation: true, sourceAvailable: false },
        { url: 'b', sha256: '2', needsLocation: true, sourceAvailable: true },
        { url: 'c', sha256: '3', needsLocation: true, sourceAvailable: true },
    ];
    const result = selectLocationWork(rows, {}, { limit: 1 });
    assert.deepEqual(result.unavailable, [rows[0]]);
    assert.deepEqual(result.selected, [rows[1]]);
    assert.deepEqual(result.waiting, [rows[2]]);
});

test('deferred and errored work can reach a stable attention outcome', () => {
    assert.deepEqual(backlogDecision({ deferredItems: 2, stableRounds: 2 }), { status: 'needs-attention', done: true });
    assert.deepEqual(backlogDecision({ errors: 1, stableRounds: 2 }), { status: 'needs-attention', done: true });
});

test('pending batches and active crawling prevent false completion', () => {
    assert.deepEqual(backlogDecision({ pendingBatches: 1, stableRounds: 5 }), { status: 'waiting-provider', done: false });
    assert.deepEqual(backlogDecision({ actionableTasks: 1, pendingBatches: 1 }), { status: 'running', done: false });
    assert.deepEqual(backlogDecision({ crawlActive: true, stableRounds: 3 }), { status: 'waiting-crawl', done: false });
});

test('budget limit stops submissions with remaining actionable tasks; unknown batches require reconciliation', () => {
    assert.deepEqual(backlogDecision({ actionableTasks: 4, budgetDeferred: true }), { status: 'budget-limit', done: true });
    assert.deepEqual(backlogDecision({ unknownBatches: 1, actionableTasks: 4, budgetDeferred: true }), { status: 'reconciliation-required', done: true });
});

test('terminal checkpoints must be fresh and match the expected child exit code', () => {
    const startedAt = Date.parse('2026-10-16T10:00:00.000Z');
    const fresh = { status: 'stages-complete', finishedAt: '2026-10-16T10:00:01.000Z' };
    assert.equal(freshTerminalCheckpoint(fresh, { startedAt, exitCode: 0 }), true);
    assert.equal(freshTerminalCheckpoint({ ...fresh, finishedAt: '2026-10-16T09:59:59.000Z', updatedAt: '2026-10-16T10:01:00.000Z' }, { startedAt, exitCode: 0 }), false);
    assert.equal(freshTerminalCheckpoint(fresh, { startedAt, exitCode: 2 }), false);
    assert.equal(freshTerminalCheckpoint(fresh, { startedAt, exitCode: 1 }), false);
    assert.equal(freshTerminalCheckpoint(fresh, { startedAt, exitCode: 0, stalled: true }), false);
    assert.equal(freshTerminalCheckpoint({ ...fresh, error: 'startup failure' }, { startedAt, exitCode: 0 }), false);
    assert.equal(freshTerminalCheckpoint({ status: 'budget-limit', finishedAt: '2026-10-16T10:00:01.000Z' }, { startedAt, exitCode: 2 }), true);
    assert.equal(freshTerminalCheckpoint({ status: 'interrupted', finishedAt: '2026-10-16T10:00:01.000Z' }, { startedAt, exitCode: 0 }), true);
});
