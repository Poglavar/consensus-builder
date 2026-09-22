import fs from 'node:fs';
import path from 'node:path';

export function landOracleStatsPath(env = process.env) {
    return env.LAND_ORACLE_RUN_STATS || path.resolve(process.cwd(), 'logs/land-oracle-stats.json');
}

export function buildLandOracleRunStats({ startedAt, endedAt, result = null, error = null, dryRun = false } = {}) {
    const missingEvidence = Array.isArray(result?.missingEvidence) ? result.missingEvidence.length : 0;
    const completed = !error && missingEvidence === 0;
    return {
        version: 1,
        job: 'consensus-builder-land-oracle',
        runStatus: completed ? 'completed' : 'failed',
        verdict: completed ? 'success' : 'failure',
        startedAt: startedAt || null,
        endedAt: endedAt || null,
        dryRun: Boolean(dryRun),
        counters: {
            scanned: Number(result?.scanned || 0),
            invalidAccounts: Array.isArray(result?.invalidAccounts) ? result.invalidAccounts.length : 0,
            terminal: Number(result?.terminal || 0),
            events: Array.isArray(result?.events) ? result.events.length : 0,
            inserted: Number(result?.inserted || 0),
            reconciled: Number(result?.reconciled || 0),
            missingEvidence
        },
        error: error ? String(error.message || error) : (missingEvidence ? `${missingEvidence} terminal proposal(s) lack source evidence` : null)
    };
}

export function writeRunStatsAtomic(file, value) {
    if (!file) throw new Error('run-stats file is required');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempFile, file);
}

export function readRunStats(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}
