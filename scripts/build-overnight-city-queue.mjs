#!/usr/bin/env node
// Build an evidence-audited largest-city parcel research queue from UN WUP 2025.
// Usage: node scripts/build-overnight-city-queue.mjs --source /path/to/WUP2025-cities.csv.gz
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { applyCrosswalkDecision, candidateNames, classifyNameCoordinateMatch, distanceKm, hasAttemptSignal, isSearchableEvidenceFile, nameVariants, normalizeName, parseWup2025Fields } from './overnight-city-queue-classification.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'world-parcels/research/overnight-cities-2026-10-08');
const WUP_DOWNLOAD_PAGE = 'https://population.un.org/wup/downloads?tab=Cities';
const WUP_BULK_FILE = 'WUP2025-DB-DEGURBA-Cities-Population-Surface-Data.csv.gz';
const WUP_BULK_URL = 'https://population.un.org/wup/assets/Download/Cities/WUP2025-DB-DEGURBA-Cities-Population-Surface-Data.csv.gz';
const USAGE = `Usage: node scripts/build-overnight-city-queue.mjs --run --source /path/to/${WUP_BULK_FILE} [--output /path/to/output]\nWithout --run, this command only prints help.`;
function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : null;
}

function parseCsvLine(line) {
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

function walkJsonFiles(dir, relativeTo, files = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkJsonFiles(full, relativeTo, files);
        else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path.relative(relativeTo, full));
    }
    return files;
}

function readJson(relativePath) {
    try { return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8')); }
    catch { return null; }
}

function cityCodeOf(row) {
    return row?.wupCityCode ?? row?.cityCode ?? row?.cityId?.match(/^wup2025:(\d+)$/)?.[1] ?? null;
}

function registryEvidence(candidates) {
    const registry = readJson('world-parcels/registry.json')?.cities || [];
    const codeMap = new Map();
    const rows = registry.map(row => {
        const code = cityCodeOf(row);
        const evidenceFiles = [row.researchFile, row.previousResearchFile, row.retryFile, row.latestAssessmentFile,
            row.regionalResearch?.evidenceFile, row.regionalResearch?.assessmentFile,
            row.capitalResearch?.evidenceFile, row.growthResearch?.evidenceFile].filter(Boolean)
            .map(file => file.startsWith('world-parcels/') ? file : `world-parcels/${file}`);
        const record = { row, code: code == null ? null : String(code), evidenceFiles, attempted: hasAttemptSignal(row, () => evidenceFiles.some(file => existsSync(path.join(ROOT, file)))) };
        if (record.code && record.attempted) {
            const list = codeMap.get(record.code) || [];
            list.push(record);
            codeMap.set(record.code, list);
        }
        return record;
    });

    // The saved demographics audit preserves high-confidence, code-based crosswalks from
    // WUP queue records to legacy registry IDs whose registry row lacks wupCityCode.
    const demographics = readJson('world-parcels/report/city-demographics.json');
    for (const item of demographics?.cities || []) {
        const code = item.wupCityCode ?? item.id?.match(/^wup2025:(\d+)$/)?.[1];
        if (!code || item.populationMatch?.confidence !== 'high') continue;
        for (const registryId of item.registryCityIds || []) {
            const record = rows.find(candidate => candidate.row.cityId === registryId && candidate.attempted);
            if (!record) continue;
            const list = codeMap.get(String(code)) || [];
            if (!list.some(existing => existing.row.cityId === registryId)) list.push({ ...record, code: String(code), crosswalk: item.populationMatch });
            codeMap.set(String(code), list);
        }
    }

    const byCode = new Map();
    const byAlias = new Map();
    for (const candidate of candidates) {
        const exact = codeMap.get(String(candidate.cityCode)) || [];
        if (exact.length) byCode.set(candidate.cityCode, exact.map(record => ({
            kind: 'registry-exact-wup-code', evidenceFile: record.row.latestAssessmentFile || record.row.regionalResearch?.evidenceFile || record.row.researchFile || null,
            cityId: record.row.cityId, cityName: record.row.name, parcelStatus: record.row.parcelStatus || null,
            checked: record.row.checked ?? null, identityConfidence: 'high'
        })));

        const names = new Set(nameVariants(candidate.name));
        for (const alias of candidate.aliases || []) for (const variant of nameVariants(alias)) names.add(variant);
        const matches = [];
        for (const record of rows) {
            if (!record.attempted || record.code === String(candidate.cityCode)) continue;
            const row = record.row;
            if (String(row.countryCode || '').toUpperCase() !== candidate.iso2) continue;
            const identity = classifyNameCoordinateMatch(candidate, { countryCode: row.countryCode, name: row.name, aliases: row.aliases, centerLatLon: row.centerLatLon });
            if (!identity) continue;
            const distance = identity.distanceKm;
            const direct = distance !== null && distance <= 40;
            matches.push({
                kind: identity.kind,
                evidenceFile: row.latestAssessmentFile || row.regionalResearch?.evidenceFile || row.researchFile || null,
                cityId: row.cityId, cityName: row.name, parcelStatus: row.parcelStatus || null,
                checked: row.checked ?? null, distanceKm: distance === null ? null : Number(distance.toFixed(2)),
                identityConfidence: direct ? 'probable-review-required' : 'ambiguous'
            });
        }
        if (matches.length) byAlias.set(candidate.cityCode, matches);
    }
    return { byCode, byAlias };
}

function capitalRosterEvidence(candidates) {
    const roster = readJson('world-parcels/research/world-capitals-2026-10-08/roster.json');
    const prior = (roster?.cities || []).filter(city => city.checked === true && city.researchStatus === 'previously_checked');
    const byCode = new Map();
    const byAlias = new Map();
    for (const candidate of candidates) {
        const names = new Set(candidateNames(candidate));
        for (const item of prior) {
            if (String(item.countryCode || '').toUpperCase() !== candidate.iso2) continue;
            const code = item.cityId?.match(/^wup2025:(\d+)$/)?.[1];
            const evidenceFile = item.manualCityEvidence?.[0]?.path || item.evidenceFiles?.[0] || item.capitalRosterMatch?.path || null;
            const record = {
                kind: 'previous-capital-city-attempt', source: 'world-capitals prior-check roster', evidenceFile,
                cityId: item.cityId || null, cityName: item.name, researchStatus: item.researchStatus,
                manualCityEvidence: item.manualCityEvidence || [], identityConfidence: code ? 'high' : 'review-required'
            };
            if (code === String(candidate.cityCode)) {
                const list = byCode.get(candidate.cityCode) || [];
                list.push(record);
                byCode.set(candidate.cityCode, list);
                continue;
            }
            const itemNames = [item.name, ...(item.aliases || [])].flatMap(nameVariants);
            if (!itemNames.some(name => names.has(name))) continue;
            const point = Array.isArray(item.centerLatLon) && item.centerLatLon.length === 2 ? item.centerLatLon : null;
            const distance = point ? distanceKm(candidate.point, point) : null;
            const list = byAlias.get(candidate.cityCode) || [];
            list.push({ ...record, kind: 'previous-capital-city-name-coordinate-candidate', distanceKm: distance === null ? null : Number(distance.toFixed(2)), identityConfidence: 'review-required' });
            byAlias.set(candidate.cityCode, list);
        }
    }
    return { byCode, byAlias, priorCount: prior.length, totalCount: (roster?.cities || []).length };
}

function runtimeConfigEvidence(candidates) {
    const source = readFileSync(path.join(ROOT, 'frontend/js/city-config.js'), 'utf8');
    const starts = [...source.matchAll(/^\s{8}([a-z0-9_-]+):\s*\{/gim)];
    const entries = starts.map((match, index) => {
        const start = match.index + match[0].length;
        const end = starts[index + 1]?.index ?? source.indexOf('\n    };', start);
        const block = source.slice(start, end < 0 ? source.length : end);
        const id = match[1];
        const directLabel = block.match(/\blabel:\s*['"]([^'"]+)['"]/);
        const translatedLabel = block.match(/\blabel:\s*translateCityText\([^,]+,\s*['"]([^'"]+)['"]/);
        const label = directLabel?.[1] || translatedLabel?.[1] || null;
        const activeParcelConfig = /\bparcels\s*:\s*\{/.test(block) && /\b(?:sourceId|liveSource\s*:|source\s*:)\s*:/.test(block);
        return { id, label, activeParcelConfig };
    }).filter(entry => entry.id !== 'explore');
    const matches = new Map();
    const countryAliases = {
        US: ['united states', 'united states of america', 'usa'], GB: ['united kingdom', 'uk', 'great britain'],
        KR: ['republic of korea', 'south korea', 'korea'], RU: ['russian federation', 'russia'],
        TR: ['turkiye', 'turkey', 'türkiye'], CN: ['china'], TW: ['taiwan', 'taiwan province of china'],
        VN: ['viet nam', 'vietnam'], IR: ['iran', 'iran, islamic republic of'], BO: ['bolivia', 'bolivia (plurinational state of)'],
        VE: ['venezuela', 'venezuela (bolivarian republic of)'], TZ: ['tanzania', 'united republic of tanzania']
    };
    for (const city of candidates) {
        const names = new Set(candidateNames(city));
        const countryNames = new Set([normalizeName(city.country), ...(countryAliases[city.iso2] || []).map(normalizeName)]);
        const cityMatches = entries.filter(entry => {
            if (!entry.label) return false;
            const parts = entry.label.split(',').map(part => normalizeName(part.trim()));
            return parts.length >= 2 && names.has(parts[0]) && parts.slice(1).some(part => countryNames.has(part));
        });
        if (cityMatches.length) matches.set(city.cityCode, cityMatches);
    }
    return { entries, matches };
}

function researchFileEvidenceIndexed(candidates) {
    const searchRoots = ['world-parcels/research', 'world-parcels/batches'];
    const files = searchRoots.flatMap(dir => walkJsonFiles(path.join(ROOT, dir), ROOT));
    const eligibleFile = file => isSearchableEvidenceFile(file) && !/(^|\/)(queue|index|outcomes?|summary|manifest|provenance|roster|city-growth[^/]*)\.json$/i.test(file)
        && !/country-queue|queue-(top|growth|india-africa)|city-demographics/i.test(file);
    const isEvidenceArtifact = file => /(?:^|\/)(?:city-\d+(?:-[^/]+)?|[^/]*(?:sample|response|attempt|failed|failure|runtime|assessment|acceptance|diagnostic|audit|service|access|probe|bounded|result)[^/]*)\.json$/i.test(file)
        || /(?:^|\/)research\/[^/]+\.json$/i.test(file);
    const fileRecords = files.filter(eligibleFile).map(file => ({ file, value: readJson(file) })).filter(item => item.value !== null)
        .map(item => ({ ...item, text: JSON.stringify(item.value) }));
    const direct = new Map();
    const aliases = new Map();
    const candidateByNameCountry = new Map();
    const evidenceByCode = new Map();
    const reviewByCode = new Map();
    const addDirect = (city, file) => {
        const list = evidenceByCode.get(city.cityCode) || [];
        list.push(file);
        evidenceByCode.set(city.cityCode, list);
    };
    for (const city of candidates) for (const name of candidateNames(city)) {
        const key = `${city.iso2}|${name}`;
        const list = candidateByNameCountry.get(key) || [];
        list.push(city);
        candidateByNameCountry.set(key, list);
    }
    const visit = (value, file) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { for (const child of value) visit(child, file); return; }
        const countryCode = String(value.countryCode || value.iso2 || value.ISO2_Code || '').toUpperCase();
        const hasAttempt = Boolean(value.status || value.checkedAt || value.verifiedParcelResponse || value.requests || value.requestsAndEndpointChecks || value.executedQueries || value.verifiedSample);
        if (countryCode && hasAttempt) {
            const listFields = ['cities', 'cityNames', 'attemptedCities', 'checkedCities'];
            for (const key of ['name', 'cityName', ...listFields, 'subregionsVerified', 'city']) {
                const entries = Array.isArray(value[key]) ? value[key] : value[key] ? [value[key]] : [];
                for (const entry of entries) {
                    const name = typeof entry === 'string' ? entry : entry?.name || entry?.cityName || entry?.label || '';
                    for (const variant of nameVariants(name)) for (const city of candidateByNameCountry.get(`${countryCode}|${variant}`) || []) {
                        const sample = value.verifiedParcelResponse;
                        const boundedSubregion = key === 'subregionsVerified' && sample && (sample.spatialTestAreaLonLat || Number(sample.parcelRecordCount) > 0);
                        const directIdentityField = ['name', 'cityName', 'city'].includes(key);
                        const explicitQueryEvidence = Boolean(value.requests || value.requestsAndEndpointChecks || value.executedQueries || value.verifiedSample || value.verifiedParcelResponse);
                        const explicitCity = directIdentityField && explicitQueryEvidence;
                        if (boundedSubregion || explicitCity) addDirect(city, file);
                        else {
                            const list = reviewByCode.get(city.cityCode) || [];
                            list.push({ evidenceFile: file, matchedName: name, field: key, identityConfidence: 'review-required' });
                            reviewByCode.set(city.cityCode, list);
                        }
                    }
                }
            }
        }
        for (const [key, child] of Object.entries(value)) {
            if (['features', 'geometry', 'coordinates', 'rings'].includes(key)) continue;
            visit(child, file);
        }
    };
    for (const item of fileRecords) {
        if (isEvidenceArtifact(item.file)) {
            const codes = new Set();
            for (const match of item.text.matchAll(/wup2025:(\d+)/gi)) codes.add(Number(match[1]));
            for (const match of item.text.matchAll(/wupCityCode["'\s:=]+(?:")?(\d+)(?:")?/gi)) codes.add(Number(match[1]));
            const base = path.basename(item.file);
            const fileCode = base.match(/(?:^|(?:india|africa-ws)-)city-?(\d+)(?:-[^/]*)?\.json$/i)?.[1]
                || base.match(/^city-(\d+)(?:-[^/]*)?\.json$/i)?.[1];
            if (fileCode) codes.add(Number(fileCode));
            for (const code of codes) {
                const city = candidates.find(candidate => candidate.cityCode === code);
                if (city) addDirect(city, item.file);
            }
        }
        visit(item.value, item.file);
    }
    for (const city of candidates) {
        const exactEvidence = evidenceByCode.get(city.cityCode) || [];
        if (exactEvidence.length) direct.set(city.cityCode, [...new Set(exactEvidence)].slice(0, 20));
        const variants = new Set(candidateNames(city));
        const folderCandidates = fileRecords.filter(item => {
            if (!isEvidenceArtifact(item.file)) return false;
            const base = path.basename(item.file).replace(/\.json$/i, '').replace(/[-_](live|sample|response|assessment|attempts?|requests?|failure|failed|runtime|acceptance|diagnostic|audit|verification|outcomes?|initial|final|bounded|exact|safe|adapter|parcel).*$/i, '');
            return variants.has(normalizeName(base));
        });
        if (folderCandidates.length) aliases.set(city.cityCode, [...new Set(folderCandidates.map(item => item.file))].slice(0, 20));
    }
    const structuredReview = new Map([...reviewByCode].map(([code, evidence]) => [code, evidence]));
    return { direct, aliases, structuredReview, scannedFiles: fileRecords.length };
}

function fileSha256(filePath) {
    const hash = createHash('sha256');
    const data = readFileSync(filePath);
    hash.update(data);
    return hash.digest('hex');
}

async function readPopulationRows(sourcePath) {
    const input = createReadStream(sourcePath).pipe(createGunzip());
    const lines = createInterface({ input, crlfDelay: Infinity });
    let header = null;
    let rows2025 = [];
    for await (const rawLine of lines) {
        const line = rawLine.replace(/^\uFEFF/, '');
        if (!header) { header = parseCsvLine(line); continue; }
        if (!line) continue;
        const cells = parseCsvLine(line);
        const row = Object.fromEntries(header.map((key, i) => [key, cells[i] ?? '']));
        if (row.Year !== '2025') continue;
        const parsed = parseWup2025Fields(row);
        if (!parsed) continue;
        const { cityCode, pop2025k, point: [lat, lon] } = parsed;
        rows2025.push({
            cityCode, name: row.City_Name, country: row.Location, iso2: row.ISO2_Code,
            iso3: row.ISO3_Code, locId: Number(row.LocID), capital: row.Capital === '1',
            pop2025k, plausibility: row.Pop_plausibility || null,
            point: [lat, lon], year: 2025, timeMid: Number(row.TimeMid),
            populationUnit: 'thousands', notes: row.Notes || null
        });
    }
    const unique = new Map();
    for (const row of rows2025) {
        if (unique.has(row.cityCode)) throw new Error(`Duplicate WUP City_Code in 2025 rows: ${row.cityCode}`);
        unique.set(row.cityCode, row);
    }
    return [...unique.values()].sort((a, b) => b.pop2025k - a.pop2025k || a.cityCode - b.cityCode);
}

function writeJson(filePath, value) {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
    if (process.argv.includes('--help') || !process.argv.includes('--run')) { console.log(USAGE); return; }
    const sourcePath = argValue('--source');
    if (!sourcePath) throw new Error('Pass --source pointing to the official UN WUP 2025 bulk city CSV.gz file.');
    if (!existsSync(sourcePath)) throw new Error(`Population source does not exist: ${sourcePath}`);
    const outputDir = path.resolve(argValue('--output') || DEFAULT_OUTPUT);
    const all = await readPopulationRows(path.resolve(sourcePath));
    const top = all.slice(0, 1000).map((row, i) => ({ rank: i + 1, ...row, aliases: nameVariants(row.name) }));
    const { byCode: registryByCode, byAlias: registryByAlias } = registryEvidence(top);
    const capital = capitalRosterEvidence(top);
    const research = researchFileEvidenceIndexed(top);
    const runtime = runtimeConfigEvidence(top);
    const crosswalkDocument = readJson('world-parcels/research/overnight-cities-2026-10-08/attempt-crosswalks.json');
    const crosswalkByCode = new Map((crosswalkDocument?.decisions || []).map(item => [Number(item.wupCityCode), item]));

    const roster = top.map(city => {
        const decision = crosswalkByCode.get(city.cityCode) || null;
        const exact = [
            ...(registryByCode.get(city.cityCode) || []).map(signal => ({ ...signal, source: 'registry' })),
            ...(capital.byCode.get(city.cityCode) || []),
            ...(research.direct.get(city.cityCode) || []).map(evidenceFile => ({ kind: 'wup-code-or-explicit-city-evidence', source: 'research-file', evidenceFile, identityConfidence: 'high' }))
        ];
        const ambiguous = [
            ...(registryByAlias.get(city.cityCode) || []).map(signal => ({ ...signal, source: 'registry' })),
            ...(capital.byAlias.get(city.cityCode) || []),
            ...(research.structuredReview.get(city.cityCode) || []).map(signal => ({ ...signal, kind: 'structured-city-name-candidate', source: 'research-file' })),
            ...(research.aliases.get(city.cityCode) || []).map(evidenceFile => ({ kind: 'city-name-file-candidate', source: 'research-file', evidenceFile, identityConfidence: 'review-required' })),
            ...(runtime.matches.get(city.cityCode) || []).map(entry => ({ kind: entry.activeParcelConfig ? 'runtime-city-config-with-parcel-source' : 'runtime-city-config-name-match', source: 'frontend/js/city-config.js', cityId: entry.id, label: entry.label, identityConfidence: 'review-required' }))
        ];
        const resolution = applyCrosswalkDecision(city, ambiguous, decision);
        if (decision?.decision === 'confirmed_attempt') exact.push({ kind: 'reviewed-attempt-crosswalk', source: 'attempt-crosswalks.json', evidenceFile: decision.evidenceFile, reviewedCityName: decision.reviewedCityName, distanceKm: decision.distanceKm, reason: decision.reason, identityConfidence: 'confirmed' });
        const uniqueExact = exact.filter((signal, i, arr) => arr.findIndex(other => other.evidenceFile === signal.evidenceFile && other.kind === signal.kind) === i);
        const uniqueAmbiguous = resolution.activeMatches.filter((signal, i, arr) => arr.findIndex(other => other.evidenceFile === signal.evidenceFile && other.cityId === signal.cityId && other.kind === signal.kind) === i);
        const resolvedPriorMatches = resolution.resolvedMatches;
        const attemptState = uniqueExact.length || resolution.attempted ? 'attempted' : resolution.holdForReview ? 'identity_review_required' : 'pending';
        return { ...city, attemptState, attemptEvidence: uniqueExact, possiblePriorMatches: uniqueAmbiguous, resolvedPriorMatches, identityDecision: decision };
    });
    const pending = roster.filter(city => city.attemptState === 'pending');
    const review = roster.filter(city => city.attemptState === 'identity_review_required');
    const attempted = roster.filter(city => city.attemptState === 'attempted');
    const output = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        scope: 'Top 1,000 UN WUP 2025 Degree of Urbanization city settlements by mid-year population, including source plausibility flags.',
        source: {
            organization: 'United Nations, Department of Economic and Social Affairs, Population Division',
            publication: 'World Urbanization Prospects: The 2025 Revision, Online Edition',
            downloadPage: WUP_DOWNLOAD_PAGE, bulkFile: WUP_BULK_FILE, downloadUrl: WUP_BULK_URL,
            localSourceSha256: fileSha256(path.resolve(sourcePath)),
            retrievedAt: '2026-10-08',
            populationField: 'Pop for Year=2025; units are thousands; ranking does not remove low-plausibility rows.',
            identity: 'City_Code is the WUP settlement identity; coordinates use the Year=2025 PWCent fields and are settlement points, not municipal boundaries or cadastral coverage claims. Some older normalized queue coordinates differ; e.g. Dighwara old point 25.969189,84.824243 vs this source point 25.9220863,84.8502742.'
        },
        counts: { full2025CityRows: all.length, rankedRows: roster.length, attempted: attempted.length, identityReviewRequired: review.length, pending: pending.length, reviewedAttemptCrosswalks: crosswalkDocument?.decisions?.filter(item => item.decision === 'confirmed_attempt').length || 0, reviewedDifferentSettlements: crosswalkDocument?.decisions?.filter(item => item.decision === 'different_settlement').length || 0, capitalPriorChecksScanned: capital.priorCount, capitalRosterRowsScanned: capital.totalCount, runtimeCityConfigsScanned: runtime.entries.length },
        method: {
            ranking: 'Sort all unique 2025 City_Code rows by Pop descending; numeric City_Code breaks equal-population ties.',
            exactAttempt: 'Skip when a registry row or non-queue research artifact carries the same WUP city code, or when an explicit reviewed decision in attempt-crosswalks.json confirms the prior city attempt.',
            identityReview: 'Unresolved same-country name/alias and coordinate proximity or named artifacts remain review candidates. Decisions in attempt-crosswalks.json preserve resolved candidate evidence; rejected evidence paths are scoped to the listed artifacts so later evidence can still count.',
            queueOnly: 'Largest-city and batch queue membership by itself does not count as an attempt. Explicit checked:false placeholders without attempt evidence are not skipped.',
            runtimeConfigs: 'All runtime city configurations were parsed and recorded as identity-review candidates; configuration presence alone is not treated as a city research attempt.',
            priorCapitalChecks: 'All 156 checked=true, previously_checked records in the 225-entry world-capitals roster are matched; exact WUP IDs count directly and same-country name/centroid aliases remain identity-review candidates.',
            scopeCaveat: 'WUP DEGURBA settlements can differ from municipalities and metropolitan governance units; review crosswalks before treating a match as identical.'
        },
        roster
    };

    mkdirSync(outputDir, { recursive: true });
    writeJson(path.join(outputDir, 'ranked-top1000.json'), output);
    writeJson(path.join(outputDir, 'skip-ledger.json'), {
        schemaVersion: 1,
        attempted: attempted.map(city => ({ rank: city.rank, cityCode: city.cityCode, name: city.name, country: city.country, iso2: city.iso2, pop2025k: city.pop2025k, plausibility: city.plausibility, evidence: city.attemptEvidence, resolvedPriorMatches: city.resolvedPriorMatches, identityDecision: city.identityDecision })),
        identityReviewRequired: review.map(city => ({ rank: city.rank, cityCode: city.cityCode, name: city.name, country: city.country, iso2: city.iso2, pop2025k: city.pop2025k, plausibility: city.plausibility, possiblePriorMatches: city.possiblePriorMatches }))
    });
    writeJson(path.join(outputDir, 'pending-queue.json'), {
        schemaVersion: 1,
        sourceRoster: 'ranked-top1000.json',
        selectionMethod: 'WUP 2025 population descending; remove confirmed prior attempts and hold identity-review candidates for manual resolution.',
        cityCount: pending.length,
        cities: pending.map(({ attemptState, attemptEvidence, possiblePriorMatches, resolvedPriorMatches, identityDecision, ...city }) => city)
    });
    writeJson(path.join(outputDir, 'identity-review.json'), {
        schemaVersion: 1,
        cityCount: review.length,
        cities: review.map(city => ({ rank: city.rank, cityCode: city.cityCode, name: city.name, country: city.country, iso2: city.iso2, point: city.point, pop2025k: city.pop2025k, plausibility: city.plausibility, possiblePriorMatches: city.possiblePriorMatches }))
    });
    writeJson(path.join(outputDir, 'provenance.json'), {
        ...output.source,
        sourceDescription: 'Official WUP 2025 downloadable bulk city table; includes annual population, settlement centroid, city code, and source-reported population plausibility.',
        downloadPageObservation: 'Official UN download page lists WUP2025 F21 city population and the bulk CSV format for DEGURBA city statistics.',
        priorCoordinatesComparison: 'New queue coordinates use official Year=2025 PWCent fields. Older normalized coordinates are historical and not reused; Dighwara example: old 25.969189,84.824243; current source 25.9220863,84.8502742.',
        localFileBytes: readFileSync(path.resolve(sourcePath)).byteLength,
        localFileSha256: fileSha256(path.resolve(sourcePath)),
        sourceRows2025: all.length,
        outputFiles: ['ranked-top1000.json', 'skip-ledger.json', 'pending-queue.json', 'identity-review.json', 'attempt-crosswalks.json']
    });
    console.log(JSON.stringify(output.counts));
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
