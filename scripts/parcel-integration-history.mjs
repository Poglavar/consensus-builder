// City-scoped integration history from the saved qualification outcome ledgers.
// Shared provider attempts cannot identify a city, so they are deliberately not joined here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const OUTCOMES_DIR = 'world-parcels/research/qualification-outcomes';
const EVIDENCE_BASE = 'https://github.com/Poglavar/consensus-builder/blob/colosseum-worlds-fair/';
const OUTCOMES = new Set(['held', 'qualified', 'unchecked']);
const cityCode = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? String(Number(value)) : null;

function evidenceUrl(file) {
    if (typeof file !== 'string' || !file.startsWith('world-parcels/research/')
        || file.split('/').some(part => !part || part === '.' || part === '..') || !file.endsWith('.json')) {
        throw new Error(`Invalid integration evidence path: ${file}`);
    }
    return EVIDENCE_BASE + file.split('/').map(encodeURIComponent).join('/');
}

function recordedTime(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
    const time = Date.parse(value);
    const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(time) || Number.isNaN(day.valueOf()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
    return value;
}

export function readIntegrationOutcomeBatches(repoRoot) {
    const directory = path.join(repoRoot, OUTCOMES_DIR);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => ({
        evidenceFile: `${OUTCOMES_DIR}/${name}`,
        data: JSON.parse(readFileSync(path.join(directory, name), 'utf8'))
    }));
}

export function indexIntegrationHistory(batches, sourceNames = new Map()) {
    const byCity = new Map();
    for (const { evidenceFile, data } of batches) {
        const outcomeUrl = evidenceUrl(evidenceFile);
        if (data.schemaVersion !== 1 || !Array.isArray(data.cities)) throw new Error(`Invalid qualification ledger: ${evidenceFile}`);
        for (const [index, record] of data.cities.entries()) {
            const code = cityCode(record.cityCode);
            if (!code || !/^[A-Z]{2,3}$/.test(record.countryCode) || !OUTCOMES.has(record.outcome)) {
                throw new Error(`Invalid city outcome at ${evidenceFile}:cities[${index}]`);
            }
            const key = `${record.countryCode}:${code}`;
            const checkedAt = recordedTime(record.finishedAt);
            const attempt = {
                outcome: record.outcome,
                summary: typeof record.summary === 'string' ? record.summary.trim() || null : null,
                checkedAt,
                sources: [...new Set(record.sourceIds || [])].map(id => ({ id, name: sourceNames.get(id) || id })),
                evidenceUrl: outcomeUrl,
                diagnosticsUrl: record.diagnosticsEvidenceFile ? evidenceUrl(record.diagnosticsEvidenceFile) : null,
                checkedDateEvidence: checkedAt ? { date: checkedAt.slice(0, 10), path: evidenceFile, field: `$.cities[${index}].finishedAt` } : null
            };
            if (!byCity.has(key)) byCity.set(key, []);
            byCity.get(key).push(attempt);
        }
    }
    for (const attempts of byCity.values()) attempts.sort((a, b) =>
        (b.checkedAt ? Date.parse(b.checkedAt) : -Infinity) - (a.checkedAt ? Date.parse(a.checkedAt) : -Infinity)
        || a.evidenceUrl.localeCompare(b.evidenceUrl));
    return byCity;
}

export function integrationCityKey(city) {
    // An explicit demographic identity takes precedence. Otherwise require one unambiguous
    // WUP identity; names, proximity and shared source IDs never attach another city's failure.
    const explicitCode = cityCode(city.wupCityCode);
    const referencedCodes = [...new Set([city.id, ...(city.registryCityIds || [])]
        .map(id => typeof id === 'string' ? cityCode(/^wup2025:(\d+)$/.exec(id)?.[1]) : null).filter(Boolean))];
    const code = explicitCode || (referencedCodes.length === 1 ? referencedCodes[0] : null);
    return code ? `${city.countryCode}:${code}` : null;
}

export function integrationHistoryForCity(city, byCity) {
    return byCity.get(integrationCityKey(city)) || [];
}
