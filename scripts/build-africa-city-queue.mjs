#!/usr/bin/env node
// Build a finite Africa-only WUP 2025 queue. No output is written without --run.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { parseWup2025Fields } from './overnight-city-queue-classification.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE = path.join(ROOT, 'tmp/overnight-cities-2026-10-09/WUP2025-DB-DEGURBA-Cities-Population-Surface-Data.csv.gz');
const DEFAULT_OUTPUT = path.join(ROOT, 'world-parcels/research/africa-wup-top1000-2026-10-14');
const BULK_FILE = 'WUP2025-DB-DEGURBA-Cities-Population-Surface-Data.csv.gz';
const DOWNLOAD_URL = 'https://population.un.org/wup/assets/Download/Cities/WUP2025-DB-DEGURBA-Cities-Population-Surface-Data.csv.gz';
// UN member states in the UN African States regional group (54 ISO 3166-1 alpha-2 codes).
export const AFRICAN_UN_MEMBER_CODES = Object.freeze([
    'DZ','AO','BJ','BW','BF','BI','CV','CM','CF','TD','KM','CG','CD','CI','DJ','EG','GQ','ER','SZ','ET',
    'GA','GM','GH','GN','GW','KE','LS','LR','LY','MG','MW','ML','MR','MU','MA','MZ','NA','NE','NG','RW',
    'ST','SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG','ZM','ZW'
]);
const AFRICAN_CODES = new Set(AFRICAN_UN_MEMBER_CODES);
const USAGE = `Usage: node scripts/build-africa-city-queue.mjs --run [--source /path/to/${BULK_FILE}] [--output /path/to/cohort] [--limit 1000]\nWithout --run, the command prints this help and does not write.`;

export function parseCsvLine(line) {
    const values = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') { value += '"'; i += 1; }
            else if (ch === '"') quoted = false;
            else value += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { values.push(value); value = ''; }
        else value += ch;
    }
    values.push(value);
    return values;
}

function sha256(filePath) {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function codeFromExplicitWupId(value) {
    const match = /^wup2025:(\d+)$/.exec(String(value ?? ''));
    return match ? Number(match[1]) : null;
}

function evidenceFilesOf(row) {
    return [...new Set([
        row.researchFile, row.previousResearchFile, row.latestAssessmentFile, row.qualificationEvidenceFile,
        row.metricReportFile, row.regionalResearch?.evidenceFile,
        row.regionalResearch?.assessmentFile, row.capitalResearch?.evidenceFile,
        row.growthResearch?.evidenceFile, row.researchEvidenceFile
    ].filter(value => typeof value === 'string' && value.trim()).map(value =>
        value.startsWith('world-parcels/') ? value : `world-parcels/${value}`))];
}

function exactWupCode(row) {
    const explicit = row?.wupCityCode ?? codeFromExplicitWupId(row?.cityId) ?? codeFromExplicitWupId(row?.id);
    return Number.isSafeInteger(Number(explicit)) && Number(explicit) > 0 ? Number(explicit) : null;
}

function joinKey(iso2, cityCode) { return `${String(iso2 || '').toUpperCase()}:${Number(cityCode)}`; }

function makeEvidenceIndex({ registry = [], demographics = [], coverage = [], capitals = [], candidates = [] }) {
    const byKey = new Map();
    const add = (city, record) => {
        const key = joinKey(city.iso2, city.cityCode);
        const list = byKey.get(key) || [];
        list.push(record);
        byKey.set(key, list);
    };
    const cityByKey = new Map(candidates.map(row => [joinKey(row.iso2, row.cityCode), { iso2: row.iso2, cityCode: row.cityCode }]));
    const demographicsByKey = new Map();
    for (const row of demographics) {
        const code = exactWupCode(row);
        const iso2 = String(row.countryCode || '').toUpperCase();
        if (!code || !AFRICAN_CODES.has(iso2) || row.id !== `wup2025:${code}`) continue;
        if (row.wupCityCode != null && Number(row.wupCityCode) !== code) continue;
        if (row.populationMatch?.confidence && row.populationMatch.confidence !== 'high') continue;
        demographicsByKey.set(joinKey(iso2, code), row);
        if (!cityByKey.has(joinKey(iso2, code))) cityByKey.set(joinKey(iso2, code), { iso2, cityCode: code });
    }

    for (const row of registry) {
        const code = exactWupCode(row);
        const iso2 = String(row.countryCode || '').toUpperCase();
        if (!code || !AFRICAN_CODES.has(iso2)) continue;
        const city = cityByKey.get(joinKey(iso2, code));
        if (!city) continue;
        add(city, {
            source: 'registry', identityBasis: 'exact_country_code_and_wup_city_code',
            cityId: row.cityId || null, cityName: row.name || null, parcelStatus: row.parcelStatus ?? null,
            checked: row.checked ?? null, sourceIds: Array.isArray(row.sourceIds) ? row.sourceIds : [],
            evidenceFiles: evidenceFilesOf(row)
        });
    }
    for (const [key, row] of demographicsByKey) {
        const city = cityByKey.get(key);
        const evidenceFiles = [row.evidenceFile, row.researchFile, row.latestAssessmentFile]
            .filter(file => typeof file === 'string' && file.trim())
            .map(file => file.startsWith('world-parcels/') ? file : `world-parcels/${file}`);
        if (evidenceFiles.length || row.registryCityIds?.length || row.appCityIds?.length) {
            add(city, {
                source: 'city-demographics-report', identityBasis: 'exact_country_code_and_wup_city_code',
                reportId: row.id, registryCityIds: Array.isArray(row.registryCityIds) ? row.registryCityIds : [],
                appCityIds: Array.isArray(row.appCityIds) ? row.appCityIds : [],
                populationMatch: row.populationMatch?.confidence === 'high' ? row.populationMatch : null,
                evidenceFiles: [...new Set(evidenceFiles)]
            });
        }
        if (row.populationMatch?.confidence === 'high') {
            const linkedIds = new Set(row.registryCityIds || []);
            for (const linked of registry) {
                if (!linkedIds.has(linked.cityId) || String(linked.countryCode || '').toUpperCase() !== String(row.countryCode || '').toUpperCase()) continue;
                add(city, {
                    source: 'city-demographics-registry-crosswalk',
                    identityBasis: 'exact_country_and_wup_report_row_with_explicit_registry_city_id',
                    cityId: linked.cityId, cityName: linked.name || null,
                    parcelStatus: linked.parcelStatus ?? null,
                    sourceIds: Array.isArray(linked.sourceIds) ? linked.sourceIds : [],
                    evidenceFiles: evidenceFilesOf(linked)
                });
            }
        }
    }
    for (const row of coverage) {
        const code = exactWupCode(row);
        const iso2 = String(row.countryCode || '').toUpperCase();
        if (!code || !AFRICAN_CODES.has(iso2) || row.id !== `wup2025:${code}`) continue;
        if (row.wupCityCode != null && Number(row.wupCityCode) !== code) continue;
        const city = cityByKey.get(joinKey(iso2, code));
        if (!city) continue;
        const attempts = Array.isArray(row.integrationAttempts) ? row.integrationAttempts : [];
        const evidenceFiles = [
            ...(Array.isArray(row.evidenceFiles) ? row.evidenceFiles : []),
            ...attempts.map(item => item?.checkedDateEvidence?.path)
        ].filter(file => typeof file === 'string' && file.trim() && !path.isAbsolute(file))
            .map(file => file.startsWith('world-parcels/') ? file : `world-parcels/${file}`);
        if (attempts.length || evidenceFiles.length) {
            add(city, {
                source: 'parcel-coverage-report-integration-attempts',
                identityBasis: 'exact_country_code_and_wup_city_code',
                reportId: row.id,
                integrationAttempts: attempts.map(item => ({
                    outcome: item.outcome ?? null, summary: item.summary ?? null, checkedAt: item.checkedAt ?? null,
                    sources: Array.isArray(item.sources) ? item.sources.map(source => ({ id: source.id ?? null, name: source.name ?? null })) : [],
                    evidenceUrl: item.evidenceUrl ?? null, diagnosticsUrl: item.diagnosticsUrl ?? null,
                    checkedDateEvidence: item.checkedDateEvidence ? {
                        date: item.checkedDateEvidence.date ?? null,
                        path: typeof item.checkedDateEvidence.path === 'string' && !path.isAbsolute(item.checkedDateEvidence.path)
                            ? item.checkedDateEvidence.path : null,
                        field: item.checkedDateEvidence.field ?? null
                    } : null
                })),
                sourceIds: Array.isArray(row.sourceIds) ? row.sourceIds : [],
                appCityIds: Array.isArray(row.appCityIds) ? row.appCityIds : [],
                evidenceFiles: [...new Set(evidenceFiles)]
            });
        }
    }
    for (const row of capitals) {
        const iso2 = String(row.countryCode || '').toUpperCase();
        if (!AFRICAN_CODES.has(iso2) || row.checked !== true || row.researchStatus !== 'previously_checked') continue;
        const explicitIds = [row.cityId, ...(Array.isArray(row.registryMatches) ? row.registryMatches.map(item => item?.cityId) : [])];
        const codes = [...new Set(explicitIds.map(codeFromExplicitWupId).filter(Boolean))];
        const evidenceFiles = [...(row.evidenceFiles || []), ...(row.manualCityEvidence || []).map(item => item?.path),
            ...(Array.isArray(row.registryMatches) ? row.registryMatches.map(item => item?.researchFile) : [])]
            .filter(file => typeof file === 'string' && file.trim() && !path.isAbsolute(file))
            .map(file => file.startsWith('world-parcels/') ? file : `world-parcels/${file}`);
        for (const code of codes) {
            const city = cityByKey.get(joinKey(iso2, code));
            if (!city) continue;
            add(city, {
                source: 'world-capitals-prior-check-roster', identityBasis: 'exact_country_code_and_explicit_wup_city_id',
                cityId: row.cityId || null, matchedWupCityId: `wup2025:${code}`, cityName: row.name || null,
                researchStatus: row.researchStatus,
                evidenceFiles: [...new Set(evidenceFiles)]
            });
        }
    }
    const entries = new Map();
    for (const [key, records] of byKey) {
        const priorEvidence = [...new Map(records.map(record => {
            const value = { ...record };
            return [JSON.stringify(value), value];
        })).values()];
        const report = demographicsByKey.get(key);
        const coverageReport = coverage.find(row => exactWupCode(row) === Number(key.split(':')[1])
            && String(row.countryCode || '').toUpperCase() === key.split(':')[0] && row.id === `wup2025:${key.split(':')[1]}`);
        const registryMatches = registry.filter(row => exactWupCode(row) === Number(key.split(':')[1])
            && String(row.countryCode || '').toUpperCase() === key.split(':')[0]);
        const appCityIds = new Set([...(report?.appCityIds || []), ...(coverageReport?.appCityIds || []), ...registryMatches.map(row => row.appCityId).filter(Boolean)]);
        const appBindings = [...appCityIds].sort().map(appCityId => {
            const rows = registryMatches.filter(row => row.appCityId === appCityId);
            return {
                appCityId, evidenceReuseOnly: true, researchQueueRetained: true,
                sourceIds: [...new Set(rows.flatMap(row => Array.isArray(row.sourceIds) ? row.sourceIds : []))].sort(),
                parcelStatuses: [...new Set(rows.map(row => row.parcelStatus).filter(Boolean))].sort()
            };
        });
        entries.set(key, { priorEvidence, appBindings });
    }
    return entries;
}

export function buildAfricaPopulationRanking(rows, { limit = 1000, sourceSha256, evidenceInputs = {} } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('--limit must be a positive integer.');
    const byCode = new Map();
    for (const row of rows) {
        if (row.year !== 2025) continue;
        if (!Number.isSafeInteger(row.cityCode) || row.cityCode <= 0) throw new Error('WUP rows must have a positive integer cityCode.');
        if (byCode.has(row.cityCode)) throw new Error(`Duplicate WUP City_Code in 2025 rows: ${row.cityCode}`);
        if (!Number.isFinite(row.pop2025k) || row.pop2025k <= 0 || !Array.isArray(row.point) || row.point.length !== 2
            || !row.point.every(Number.isFinite) || row.point[0] < -90 || row.point[0] > 90 || row.point[1] < -180 || row.point[1] > 180) {
            throw new Error(`Invalid WUP population or point for City_Code ${row.cityCode}.`);
        }
        byCode.set(row.cityCode, row);
    }
    const all = [...byCode.values()].sort((a, b) => b.pop2025k - a.pop2025k || a.cityCode - b.cityCode);
    const globalRank = new Map(all.map((row, index) => [row.cityCode, index + 1]));
    const africa = all.filter(row => AFRICAN_CODES.has(String(row.iso2 || '').toUpperCase()));
    const selected = africa.slice(0, limit);
    const roster = selected.map((row, index) => {
        const iso2 = String(row.iso2 || '').toUpperCase();
        if (!AFRICAN_CODES.has(iso2)) throw new Error(`Non-African row selected: ${iso2}`);
        if (typeof row.name !== 'string' || !row.name.trim() || typeof row.country !== 'string' || !row.country.trim()) {
            throw new Error(`Missing city or country name for WUP City_Code ${row.cityCode}.`);
        }
        return {
            rank: index + 1,
            globalRank: globalRank.get(row.cityCode),
            cityCode: row.cityCode,
            name: row.name,
            country: row.country,
            iso2,
            iso3: row.iso3 || null,
            locId: Number.isFinite(row.locId) ? row.locId : null,
            capital: row.capital === true,
            pop2025k: row.pop2025k,
            plausibility: row.plausibility || null,
            point: [...row.point],
            year: 2025,
            populationUnit: 'thousands',
            priorEvidence: [],
            appBindings: [],
            researchPolicy: { retainInQueue: true, priorEvidenceReuseOnly: true }
        };
    });
    const evidence = makeEvidenceIndex({ ...evidenceInputs, candidates: roster });
    for (const row of roster) {
        const attached = evidence.get(joinKey(row.iso2, row.cityCode)) || { priorEvidence: [], appBindings: [] };
        row.priorEvidence = attached.priorEvidence;
        row.appBindings = attached.appBindings;
    }
    const source = {
        organization: 'United Nations, Department of Economic and Social Affairs, Population Division',
        publication: 'World Urbanization Prospects: The 2025 Revision, Online Edition',
        bulkFile: BULK_FILE,
        downloadUrl: DOWNLOAD_URL,
        sha256: sourceSha256 || null,
        localSourceSha256: sourceSha256 || null,
        full2025CityRows: all.length,
        populationField: 'Pop for Year=2025; units are thousands; ranking retains source plausibility flags.',
        pointField: 'Year=2025 PWCent_Latitude and PWCent_Longitude; point order is [latitude, longitude].'
    };
    const ranked = {
        schemaVersion: 1,
        scope: `Top ${selected.length} African settlements among the 54 UN African States member countries by UN WUP 2025 city population.`,
        countryScope: { basis: 'UN member countries in the UN African States regional group', iso2Codes: AFRICAN_UN_MEMBER_CODES },
        source,
        counts: { fullValid2025Rows: all.length, africaValid2025Rows: africa.length, selectedRows: selected.length,
            countriesRepresented: new Set(roster.map(row => row.iso2)).size,
            investigatedRetained: roster.filter(row => row.priorEvidence.length).length,
            appBindingsRetained: roster.filter(row => row.appBindings.length).length },
        method: {
            ranking: 'Sort all unique valid WUP 2025 city rows by Pop descending, then numeric City_Code ascending; globalRank is the all-country rank and rank is the Africa-only rank.',
            identity: 'City_Code is preserved as the WUP settlement identity. WUP centroid coordinates are retained exactly as [latitude, longitude]; they are settlement points, not municipal boundaries.',
            evidenceJoin: 'Attach only explicit countryCode+WUP City_Code matches from the registry, the city-demographics report, or a capital roster cityId formatted wup2025:<code>. No name, alias, or coordinate matching is used.',
            queuePolicy: 'Prior investigations and live app bindings are annotations for evidence reuse. Every selected settlement remains in pending-queue.json; no prior status skips or removes a city.',
            countryScope: 'The explicit 54-code set is the UN African States regional group member countries; disputed territories and non-member observers are excluded.'
        },
        roster
    };
    const pending = {
        schemaVersion: 1,
        sourceRoster: 'ranked-population.json',
        selectionMethod: ranked.method.ranking,
        cityCount: roster.length,
        cities: roster
    };
    return { ranked, pending };
}

async function readWupRows(sourcePath) {
    const input = createReadStream(sourcePath).pipe(createGunzip());
    const lines = createInterface({ input, crlfDelay: Infinity });
    let header = null;
    const rows = [];
    for await (const rawLine of lines) {
        const line = rawLine.replace(/^\uFEFF/, '');
        if (!header) { header = parseCsvLine(line); continue; }
        if (!line) continue;
        const cells = parseCsvLine(line);
        const row = Object.fromEntries(header.map((key, i) => [key, cells[i] ?? '']));
        if (row.Year !== '2025') continue;
        const parsed = parseWup2025Fields(row);
        if (!parsed) continue;
        const iso2 = String(row.ISO2_Code || '').toUpperCase();
        if (!/^[A-Z]{2}$/.test(iso2)) continue;
        const locId = Number(row.LocID);
        rows.push({
            cityCode: parsed.cityCode, name: row.City_Name, country: row.Location, iso2,
            iso3: row.ISO3_Code || null, locId: Number.isFinite(locId) ? locId : null,
            capital: row.Capital === '1', pop2025k: parsed.pop2025k,
            plausibility: row.Pop_plausibility || null, point: parsed.point, year: 2025
        });
    }
    if (!header) throw new Error('WUP source has no CSV header.');
    return rows;
}

function loadEvidenceInputs() {
    const read = relative => JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
    const registry = read('world-parcels/registry.json');
    const demographics = read('world-parcels/report/city-demographics.json');
    const capitals = read('world-parcels/research/world-capitals-2026-10-08/roster.json');
    if (!Array.isArray(registry.cities) || !Array.isArray(demographics.cities) || !Array.isArray(capitals.cities)) {
        throw new Error('Prior-evidence registry, demographics report, and capital roster must each contain a cities array.');
    }
    return {
        registry: registry.cities,
        demographics: demographics.cities,
        coverage: read('frontend/data/parcel-coverage-report.json')?.cities || [],
        capitals: capitals.cities
    };
}

export function writeCohort(outputDir, outputs) {
    const files = new Map([
        ['ranked-population.json', `${JSON.stringify(outputs.ranked, null, 2)}\n`],
        ['pending-queue.json', `${JSON.stringify(outputs.pending, null, 2)}\n`]
    ]);
    for (const [name, content] of files) {
        const filePath = path.join(outputDir, name);
        if (existsSync(filePath) && readFileSync(filePath, 'utf8') !== content) {
            throw new Error(`Refusing to overwrite different cohort artifact: ${name}`);
        }
    }
    mkdirSync(outputDir, { recursive: true });
    for (const [name, content] of files) {
        const filePath = path.join(outputDir, name);
        if (!existsSync(filePath)) writeFileSync(filePath, content, { flag: 'wx' });
        else if (readFileSync(filePath, 'utf8') !== content) throw new Error(`Cohort artifact changed during write: ${name}`);
    }
}

function argument(flag, fallback = null) {
    const index = process.argv.indexOf(flag);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    return value;
}

async function main() {
    if (process.argv.includes('--help') || !process.argv.includes('--run')) { console.log(USAGE); return; }
    const sourcePath = path.resolve(argument('--source', DEFAULT_SOURCE));
    if (!existsSync(sourcePath)) throw new Error(`Population source does not exist: ${sourcePath}`);
    const limit = Number(argument('--limit', '1000'));
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.');
    const outputDir = path.resolve(argument('--output', DEFAULT_OUTPUT));
    const rows = await readWupRows(sourcePath);
    const outputs = buildAfricaPopulationRanking(rows, {
        limit, sourceSha256: sha256(sourcePath), evidenceInputs: loadEvidenceInputs()
    });
    writeCohort(outputDir, outputs);
    console.log(JSON.stringify(outputs.ranked.counts));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
