import { spawn } from 'node:child_process';

function workerCount(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Worker count must be a positive integer.');
    return value;
}

/** Dispatch each item once, preserving input order when a slot becomes free. */
export async function runConcurrent(items, workers, processItem, { shouldStop = () => false, onError } = {}) {
    workerCount(workers);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
        while (next < items.length && !shouldStop()) {
            const item = items[next++];
            try { await processItem(item); }
            catch (error) {
                if (!onError) throw error;
                await onError(item, error);
            }
        }
    }));
}

/** Bound a heavy stage independently of the number of cities in progress. */
export function createStageLimiter(workers) {
    workerCount(workers);
    const waiting = [];
    let active = 0;
    const advance = () => {
        while (active < workers && waiting.length) {
            const { operation, resolve, reject } = waiting.shift();
            active++;
            Promise.resolve().then(operation).then(resolve, reject).finally(() => {
                active--;
                advance();
            });
        }
    };
    return operation => new Promise((resolve, reject) => {
        waiting.push({ operation, resolve, reject });
        advance();
    });
}

/** Resolve only after the child exits, including timeout escalation and spawn failures. */
export function runProcess(command, args, { timeoutMs, killAfterMs = 5000, ...options }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(killAfterMs) || killAfterMs <= 0) {
        throw new TypeError('Process timeout and kill grace must be positive.');
    }
    return new Promise(resolve => {
        let child;
        try { child = spawn(command, args, options); }
        catch (error) { resolve({ status: null, signal: null, error }); return; }
        let error = null;
        let killTimer;
        const timeout = setTimeout(() => {
            error = Object.assign(new Error('Qualification process timed out.'), { code: 'ETIMEDOUT' });
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
            killTimer.unref();
        }, timeoutMs);
        timeout.unref();
        child.once('error', failure => { error ||= failure; });
        child.once('close', (status, signal) => {
            clearTimeout(timeout);
            clearTimeout(killTimer);
            resolve({ status, signal, error });
        });
    });
}
