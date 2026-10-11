#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const MAX_REQUESTS = 300;
const MAX_FEATURES = 10_000;
const MAX_RESPONSE_MS = 45_000;
const MAX_SAMPLE_IDS = 5;
const CELL_OFFSETS = [[-1,-1],[0,-1],[1,-1],[-1,0],[0,0],[1,0],[-1,1],[0,1],[1,1],[0,-2],[0,2],[-2,0],[2,0]];
const SENSITIVE_FIELD = /owner|propriet|address|holder|title.?name|person|company|organization|organisation/i;

export function cellsForPoint([longitude, latitude], step) {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90
        || !Number.isFinite(step) || step <= 0 || step > 0.05) throw new TypeError('Invalid WGS84 point or cell size.');
    const baseX = Math.floor(longitude / step) * step;
    const baseY = Math.floor(latitude / step) * step;
    return CELL_OFFSETS.map(([dx, dy], index) => ({
        index, dx, dy,
        bbox: [baseX + dx * step, baseY + dy * step, baseX + (dx + 1) * step, baseY + (dy + 1) * step]
            .map(value => Number(value.toFixed(10)))
    }));
}

export function canonicalSafeFeature(feature, sourceId) {
    const properties = feature?.properties || {};
    const id = typeof properties.parcelId === 'string' ? properties.parcelId : feature?.id;
    const featureSourceId = properties.sourceId || feature?.sourceId;
    const sourceParcelId = typeof properties.sourceParcelId === 'string' ? properties.sourceParcelId : null;
    if (typeof id !== 'string' || !id || featureSourceId !== sourceId || !sourceParcelId
        || !feature?.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
        throw new Error('Malformed, foreign, or non-polygon source feature.');
    }
    return { type: 'Feature', id, properties: { parcelId: id, sourceId, sourceParcelId }, geometry: feature.geometry };
}

export function addCanonicalFeature(byId, feature, sourceId) {
    const clean = canonicalSafeFeature(feature, sourceId);
    const previous = byId.get(clean.id);
    if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(clean.geometry)) {
        throw new Error(`Conflicting geometry for canonical parcel ID ${clean.id}.`);
    }
    if (!previous) byId.set(clean.id, clean);
    return clean;
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function epsgCode(value) {
    const match = /^(?:EPSG:)?(\d{4,6})$/.exec(String(value ?? ''));
    if (!match) throw new Error('metricEpsg must be an EPSG code.');
    return `EPSG:${match[1]}`;
}
function safeFailure(error) {
    return {
        errorType: typeof error?.name === 'string' ? error.name : 'Error',
        ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        ...(Number.isSafeInteger(error?.status) ? { httpStatus: error.status } : {}),
        ...(Number.isSafeInteger(error?.upstreamStatus) ? { upstreamHttpStatus: error.upstreamStatus } : {})
    };
}
function checkRecord(passed, details = {}) { return { passed: Boolean(passed), ...details }; }
function checkWithDetails(passed, previous, details = {}) {
    const { passed: _ignored, ...oldDetails } = previous || {};
    return checkRecord(passed, { ...oldDetails, ...details });
}

export function assessForcedQueryEvidence({ requests, expectedIds, returnedIds, complete, mode }) {
    const expected = [...expectedIds].sort();
    const returned = [...returnedIds].sort();
    const sameIds = JSON.stringify(expected) === JSON.stringify(returned);
    const records = Array.isArray(requests) ? requests : [];
    if (mode === 'object-ids') {
        const objectIdRequests = records.filter(request => request.idListParam === 'objectIds' && request.idListCount === 1);
        const distinctQueries = new Set(objectIdRequests.map(request => request.queryHash)).size;
        return { passed: complete === true && sameIds && distinctQueries >= 2 && distinctQueries === objectIdRequests.length, kind: 'object-ids-manifest',
            completeManifest: complete === true, returnedIdsMatch: sameIds, singletonObjectIdRequests: objectIdRequests.length,
            distinctSingletonObjectIdQueries: distinctQueries, duplicateObjectIdRequests: objectIdRequests.length - distinctQueries };
    }
    const featureRequests = records.filter(request => request.pageLimit === 1 && request.queryHash);
    const identities = featureRequests.map(request => `${request.queryHash}:${Number.isFinite(request.offset) ? request.offset : 'none'}`);
    const distinctFeatureQueries = new Set(identities).size;
    return { passed: complete === true && sameIds && distinctFeatureQueries >= 2 && distinctFeatureQueries === identities.length, kind: 'feature-queries',
        completeManifest: complete === true, returnedIdsMatch: sameIds, featurePageRequests: featureRequests.length,
        distinctFeatureQueries, duplicatePageRequests: identities.length - distinctFeatureQueries };
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (!['--candidate', '--output', '--metric-script'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
            throw new Error('Usage: qualify-parcel-source.mjs --candidate <JSON> --output <dir> --metric-script <path>');
        }
        if (args[key]) throw new Error(`Duplicate argument ${key}.`);
        args[key] = argv[++i];
    }
    if (!args['--candidate'] || !args['--output'] || !args['--metric-script']) {
        throw new Error('Usage: qualify-parcel-source.mjs --candidate <JSON> --output <dir> --metric-script <path>');
    }
    return { candidatePath: path.resolve(args['--candidate']), outputDir: path.resolve(args['--output']), metricScript: path.resolve(args['--metric-script']) };
}

function validateCandidate(candidate) {
    const d = candidate?.descriptor, city = candidate?.city;
    if (!city || typeof city.code !== 'string' || !city.code || typeof city.name !== 'string' || !city.name
        || !Array.isArray(city.point) || city.point.length !== 2
        || !city.point.every(Number.isFinite) || city.point[0] < -180 || city.point[0] > 180 || city.point[1] < -90 || city.point[1] > 90) {
        throw new Error('candidate.city must contain code, name, and explicit WGS84 [longitude, latitude] point.');
    }
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id || typeof d.adapter !== 'string' || !d.adapter) {
        throw new Error('candidate.descriptor must be a production parcel source descriptor.');
    }
    if (!Array.isArray(candidate.sampleIds) || !candidate.sampleIds.length || candidate.sampleIds.length > MAX_SAMPLE_IDS
        || candidate.sampleIds.some(id => typeof id !== 'string' || !id) || new Set(candidate.sampleIds).size !== candidate.sampleIds.length) {
        throw new Error(`candidate.sampleIds must contain 1-${MAX_SAMPLE_IDS} unique canonical IDs.`);
    }
    if (typeof candidate.absentId !== 'string' || !candidate.absentId || candidate.sampleIds.includes(candidate.absentId)) {
        throw new Error('candidate.absentId must be a known-format, unobserved canonical parcel ID.');
    }
    if (candidate.sourceClassification?.isParcel !== true || !Array.isArray(candidate.sourceClassification.evidence)
        || !candidate.sourceClassification.evidence.length || candidate.sourceClassification.evidence.some(x => typeof x !== 'string' || !x.trim())) {
        // Keep processing useful checks where possible, but final status cannot qualify.
    }
    if (!Number.isSafeInteger(Number(String(candidate.metricEpsg).replace(/^EPSG:/, '')))) throw new Error('candidate.metricEpsg must be an EPSG integer.');
    const step = candidate.cellSizeDegrees ?? 0.001;
    if (!Number.isFinite(step) || step <= 0 || step > 0.05) throw new Error('candidate.cellSizeDegrees is out of bounds.');
    const fields = [...(Array.isArray(d.outFields) ? d.outFields : []), d.idField, d.objectIdField].filter(Boolean);
    if (fields.some(field => SENSITIVE_FIELD.test(String(field)))) throw new Error('Candidate descriptor requests a sensitive attribute field; reduce outFields before qualification.');
    const declaredAreaEnumeration = d.capabilities?.areaEnumeration ?? d.areaEnumeration ?? !['msda-point', 'tkgm-point'].includes(d.adapter);
    if (candidate.areaEnumeration === false && declaredAreaEnumeration === true) throw new Error('Candidate cannot disable descriptor-declared area enumeration.');
    return { step, areaEnumeration: declaredAreaEnumeration };
}

function findRepoRoot(scriptFile) {
    const scriptDir = path.dirname(scriptFile);
    const adjacent = path.resolve(scriptDir, '..');
    // The deliverable is intended to live at scripts/qualify-parcel-source.mjs. While staged in
    // /private/tmp, run from the repo root and resolve the same ../backend paths from cwd.
    const root = path.basename(scriptDir) === 'scripts' ? adjacent : process.cwd();
    return root;
}

function makeSafeFetch({ state, stage }) {
    return async (input, init = {}) => {
        if (state.requests.length >= MAX_REQUESTS) throw Object.assign(new Error('Request budget exceeded.'), { code: 'qualification-request-budget' });
        const started = Date.now();
        let host = null, method = String(init.method || input?.method || 'GET').toUpperCase();
        try {
            const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
            host = url.hostname;
            const values = new Map([...url.searchParams.entries()]);
            if (typeof init.body === 'string') {
                try {
                    const body = JSON.parse(init.body);
                    if (body && typeof body === 'object' && !Array.isArray(body)) {
                        for (const [key, value] of Object.entries(body)) if (/^(where|cql_filter|filter|featureID|resourceId|resultRecordCount|maxRecordCount|pageSize|limit|count|maxFeatures|resultOffset|startIndex|offset|objectIds|ids)$/i.test(key)
                            && (typeof value === 'string' || typeof value === 'number')) values.set(key, String(value));
                    }
                } catch {
                    try { for (const [key, value] of new URLSearchParams(init.body)) {
                        if (/^(where|cql_filter|filter|featureID|resourceId|resultRecordCount|maxRecordCount|pageSize|limit|count|maxFeatures|resultOffset|startIndex|offset|objectIds|ids)$/i.test(key)) values.set(key, value);
                    } } catch { /* Do not inspect arbitrary request bodies. */ }
                }
            }
            const limitKey = ['resultRecordCount', 'maxRecordCount', 'pageSize', 'limit', 'count'].find(key => values.has(key));
            const offsetKey = ['resultOffset', 'startIndex', 'offset'].find(key => values.has(key));
            const idsKey = ['objectIds', 'ids'].find(key => values.has(key));
            const queryIdentityParams = [...values.entries()]
                .filter(([key]) => /^(where|cql_filter|filter|featureID|resourceId|objectIds|ids|resultRecordCount|maxRecordCount|pageSize|limit|count|maxFeatures|resultOffset|startIndex|offset)$/i.test(key))
                .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
            const queryHash = sha256(JSON.stringify({ host, pathname: url.pathname, params: queryIdentityParams }));
            const requestRecord = { stage, host, method, startedAt: new Date(started).toISOString(),
                queryHash,
                safeParamNames: [...new Set(queryIdentityParams.map(([key]) => key))].sort(),
                ...(limitKey ? { pageLimitParam: limitKey, pageLimit: /^\d+$/.test(values.get(limitKey)) ? Number(values.get(limitKey)) : null } : {}),
                ...(offsetKey ? { offsetParam: offsetKey, offset: /^\d+$/.test(values.get(offsetKey)) ? Number(values.get(offsetKey)) : null } : {}),
                ...(idsKey ? { idListParam: idsKey,
                    idListCount: String(values.get(idsKey)).split(',').filter(Boolean).length } : {}) };
            state.requests.push(requestRecord);
            const timeout = AbortSignal.timeout(MAX_RESPONSE_MS);
            const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
            try {
                const response = await globalThis.__qualificationOriginalFetch(input, { ...init, signal });
                requestRecord.httpStatus = response.status;
                requestRecord.elapsedMs = Date.now() - started;
                return response;
            } catch (error) {
                requestRecord.elapsedMs = Date.now() - started;
                requestRecord.timeout = signal.aborted;
                requestRecord.errorType = typeof error?.name === 'string' ? error.name : 'Error';
                if (typeof error?.code === 'string') requestRecord.errorCode = error.code;
                throw error;
            }
        } catch (error) {
            if (error?.code === 'qualification-request-budget') throw error;
            if (!state.requests.length || state.requests.at(-1)?.stage !== stage || state.requests.at(-1)?.startedAt !== new Date(started).toISOString()) {
                state.requests.push({ stage, host, method, elapsedMs: Date.now() - started, ...safeFailure(error) });
            }
            throw error;
        }
    };
}

function requestStage(state, stage) { state.stage = stage; }
function maxUnique(byId) {
    if (byId.size > MAX_FEATURES) throw Object.assign(new Error(`Feature cache exceeds ${MAX_FEATURES} unique IDs.`), { code: 'qualification-feature-budget' });
}

async function runMetric({ metricScript, outputDir, cachePath, metricEpsg, sourceHash, expectedFeatures }) {
    const reportPath = path.join(outputDir, 'metric-report.json');
    await fs.rm(reportPath, { force: true });
    const run = spawnSync('python3', [metricScript, cachePath, reportPath, '--source-crs', 'EPSG:4326', '--metric-epsg', String(Number(metricEpsg.slice(5)))], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 120_000, maxBuffer: 1_000_000
    });
    if (run.error || run.status !== 0) throw Object.assign(new Error('Independent metric script failed.'), { code: 'metric-script-failed' });
    let report;
    try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')); }
    catch { throw Object.assign(new Error('Independent metric script returned no JSON report file.'), { code: 'metric-report-invalid' }); }
    const featureCount = Number(report?.featureCount);
    const metricSrid = report?.metricCrs;
    const invalidCount = Number(report?.invalidCount);
    const duplicateIdCount = Number(report?.duplicateIdCount);
    const conflictingSameIdGeometryCount = Number(report?.conflictingSameIdGeometryCount);
    const exactGeometryDuplicateCount = Number(report?.exactGeometryDuplicateCount);
    const overlapPairCount = Number(report?.overlapPairCount);
    const operationErrorCount = Number(report?.operationErrorCount);
    if (!report || typeof report !== 'object' || Array.isArray(report) || report.geometryPass !== true
        || !Number.isSafeInteger(featureCount) || featureCount <= 0 || featureCount !== expectedFeatures
        || report.inputSha256 !== sourceHash || report.sourceCrs !== 'EPSG:4326' || metricSrid !== metricEpsg
        || report.geometryChangedOrRepaired !== false
        || ![invalidCount, duplicateIdCount, conflictingSameIdGeometryCount, exactGeometryDuplicateCount, overlapPairCount, operationErrorCount].every(Number.isSafeInteger)
        || [invalidCount, duplicateIdCount, conflictingSameIdGeometryCount, exactGeometryDuplicateCount, overlapPairCount, operationErrorCount].some(value => value !== 0)) {
        throw Object.assign(new Error('Metric report failed geometry, feature-count, or cached-input hash verification.'), { code: 'metric-report-failed' });
    }
    return { reportPath, inputSha256: report.inputSha256, featureCount, sourceCrs: report.sourceCrs, metricCrs: metricSrid,
        invalidCount, duplicateIdCount, conflictingSameIdGeometryCount, exactGeometryDuplicateCount, overlapPairCount, operationErrorCount,
        geometryChangedOrRepaired: false, geometryPass: true };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const candidateBytes = await fs.readFile(args.candidatePath);
    const candidate = JSON.parse(candidateBytes.toString('utf8'));
    const { step, areaEnumeration } = validateCandidate(candidate);
    const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
    const { createParcelSource } = await import(pathToFileURL(path.join(repoRoot, 'backend/parcels/sources.js')));
    const { computeSourceBinding, computeSourceParcelActBinding } = await import(pathToFileURL(path.join(repoRoot, 'backend/parcels/source-binding.js')));
    const require = createRequire(path.join(repoRoot, 'backend/package.json'));
    const turf = require('@turf/turf');
    const outputDir = args.outputDir;
    await fs.mkdir(outputDir, { recursive: true });
    const cachePath = path.join(outputDir, 'full-safe.geojson');
    const metricReportPath = path.join(outputDir, 'metric-report.json');
    const state = { requests: [], stage: 'initializing' };
    const all = new Map();
    const checks = {
        classification: checkRecord(candidate.sourceClassification?.isParcel === true && candidate.sourceClassification.evidence?.length > 0,
            { evidenceCount: candidate.sourceClassification?.evidence?.length || 0 }),
        exactIds: checkRecord(false), stableGeometry: checkRecord(false), explicitAbsence: checkRecord(false),
        sampling: checkRecord(false), completeness: checkRecord(false), binding: checkRecord(false), metric: checkRecord(false)
    };
    const sampledCells = [];
    const samplingPoints = [];
    const failures = {};
    const metricCrs = epsgCode(candidate.metricEpsg);
    const sourceId = candidate.descriptor.id;
    const makeAdapter = stage => {
        requestStage(state, stage);
        const fetchImpl = makeSafeFetch({ state, stage });
        const descriptor = { ...candidate.descriptor };
        if (stage === 'forced-page-size-one') { descriptor.pageSize = 1; descriptor.idBatchSize = 1; }
        const options = descriptor.adapter === 'gml-snapshot' ? {} : { fetchImpl };
        if (descriptor.adapter === 'gml-snapshot') {
            const previous = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            const adapter = createParcelSource(descriptor, options);
            // Keep the wrapper installed until this source operation completes. Caller restores it.
            return { adapter, restore: () => { globalThis.fetch = previous; } };
        }
        return { adapter: createParcelSource(descriptor, options), restore: () => {} };
    };
    const recordFailure = (name, error) => { failures[name] = safeFailure(error); };
    const runSource = async (stage, operation) => {
        const { adapter, restore } = makeAdapter(stage);
        const observed = { ...adapter };
        if (typeof adapter.queryGeometry === 'function') observed.queryGeometry = async geometry => {
            const result = await adapter.queryGeometry(geometry);
            if (Array.isArray(result?.features)) ingest(result.features);
            return result;
        };
        try { return await operation(observed); } finally { restore(); }
    };
    const ingest = features => {
        if (!Array.isArray(features)) throw new Error('Adapter feature list is missing.');
        for (const feature of features) addCanonicalFeature(all, feature, sourceId);
        maxUnique(all);
    };
    const getExact = async (adapter, ids) => {
        const result = await adapter.queryIds(ids);
        if (result?.complete !== true || !Array.isArray(result.features) || !Array.isArray(result.absentIds)) throw new Error('Exact-ID result is incomplete.');
        const found = new Map();
        for (const feature of result.features) {
            const clean = canonicalSafeFeature(feature, sourceId);
            if (found.has(clean.id)) throw new Error(`Duplicate response row for exact canonical parcel ID ${clean.id}.`);
            found.set(clean.id, clean);
        }
        if (found.size !== ids.length || ids.some(id => !found.has(id)) || result.absentIds.length) throw new Error('Exact-ID result did not return precisely all requested IDs.');
        return found;
    };

    // Preserve normal global fetch behavior outside each GML adapter call.
    const originalFetch = globalThis.fetch;
    globalThis.__qualificationOriginalFetch = originalFetch;
    try {
        let firstExact, secondExact;
        try {
            firstExact = await runSource('exact-id-first-read', async adapter => getExact(adapter, candidate.sampleIds));
            ingest([...firstExact.values()]);
            checks.exactIds = checkRecord(true, { requestedCount: candidate.sampleIds.length, returnedCount: firstExact.size });
        } catch (error) { recordFailure('exactIds', error); checks.exactIds = checkRecord(false); }
        try {
            secondExact = await runSource('exact-id-independent-read', async adapter => getExact(adapter, candidate.sampleIds));
            ingest([...secondExact.values()]);
            const stable = firstExact && candidate.sampleIds.every(id => createHash('sha256').update(JSON.stringify(firstExact.get(id).geometry)).digest('hex') === createHash('sha256').update(JSON.stringify(secondExact.get(id).geometry)).digest('hex'));
            checks.stableGeometry = checkRecord(Boolean(stable), { independentRead: true, comparedCount: secondExact.size });
            if (!stable) throw new Error('Repeated exact-ID geometry hashes changed.');
        } catch (error) { recordFailure('stableGeometry', error); checks.stableGeometry = checkRecord(false); }
        try {
            const result = await runSource('explicit-absence', async adapter => adapter.queryIds([candidate.absentId]));
            const clean = Array.isArray(result?.features) ? result.features : null;
            const absent = Array.isArray(result?.absentIds) ? result.absentIds : [];
            checks.explicitAbsence = checkRecord(result?.complete === true && clean?.length === 0 && absent.length === 1 && absent[0] === candidate.absentId,
                { returnedCount: clean?.length ?? null, absentCount: absent.length });
            if (!checks.explicitAbsence.passed) throw new Error('Known-format absent ID did not produce explicit complete absence.');
        } catch (error) { recordFailure('explicitAbsence', error); checks.explicitAbsence = checkRecord(false); }

        if (areaEnumeration) {
            const cells = cellsForPoint(candidate.city.point, step);
            const pass1 = [];
            let complete1 = true, rowCount = 0;
            try {
                const { adapter, restore } = makeAdapter('13-cell-pass-one');
                try {
                    for (const cell of cells) {
                        const r = await adapter.queryBounds(cell.bbox);
                        const features = Array.isArray(r?.features) ? r.features : [];
                        if (r?.complete !== true || !Array.isArray(r?.features)) complete1 = false;
                        rowCount += features.length;
                        if (rowCount > MAX_FEATURES) throw Object.assign(new Error('13-cell row budget exceeded.'), { code: 'qualification-feature-budget' });
                        ingest(features);
                        pass1.push({ ...cell, complete: r?.complete === true, featureCount: features.length, ids: features.map(f => f.id || f.properties?.parcelId) });
                    }
                } finally { restore(); }
                sampledCells.push(...pass1);
                const pass2 = [];
                const second = makeAdapter('13-cell-pass-two');
                try {
                    for (const cell of cells) {
                        const r = await second.adapter.queryBounds(cell.bbox);
                        const features = Array.isArray(r?.features) ? r.features : [];
                        if (r?.complete !== true || !Array.isArray(r?.features)) complete1 = false;
                        rowCount += features.length;
                        if (rowCount > MAX_FEATURES * 2) throw Object.assign(new Error('Repeated 13-cell row budget exceeded.'), { code: 'qualification-feature-budget' });
                        ingest(features);
                        pass2.push({ index: cell.index, complete: r?.complete === true, featureCount: features.length, ids: features.map(f => f.id || f.properties?.parcelId) });
                    }
                } finally { second.restore(); }
                let stable = pass1.every((a, i) => a.complete && pass2[i]?.complete
                    && JSON.stringify([...a.ids].sort()) === JSON.stringify([...pass2[i].ids].sort()));
                const point = candidate.city.point;
                const pointHasParcel = pass1.some(cell => {
                    const matching = cell.ids.map(id => all.get(id)).filter(Boolean);
                    return matching.some(feature => {
                        try { return turf.booleanPointInPolygon(turf.point(point), turf.feature(feature.geometry)); }
                        catch { return false; }
                    });
                });
                let centroidCell = null;
                if (!pointHasParcel) {
                    const known = firstExact?.get(candidate.sampleIds[0]) || secondExact?.get(candidate.sampleIds[0]);
                    if (known) {
                        const center = turf.centroid(turf.feature(known.geometry)).geometry.coordinates;
                        const extra = cellsForPoint(center, step)[4];
                        centroidCell = { ...extra, reason: 'WUP point had no containing sampled parcel; sample centroid cell added.' };
                        const one = await runSource('sample-centroid-cell-pass-one', async adapter => adapter.queryBounds(extra.bbox));
                        const two = await runSource('sample-centroid-cell-pass-two', async adapter => adapter.queryBounds(extra.bbox));
                        const idsOne = (one.features || []).map(f => f.id || f.properties?.parcelId).sort();
                        const idsTwo = (two.features || []).map(f => f.id || f.properties?.parcelId).sort();
                        const centroidStable = one.complete === true && two.complete === true
                            && JSON.stringify(idsOne) === JSON.stringify(idsTwo);
                        if (one.complete !== true || two.complete !== true) complete1 = false;
                        ingest(one.features || []); ingest(two.features || []);
                        centroidCell.complete = centroidStable;
                        centroidCell.featureCount = idsOne.length;
                        centroidCell.ids = idsOne;
                        sampledCells.push(centroidCell);
                        stable = stable && centroidStable;
                    }
                }
                checks.sampling = checkRecord(stable, { capability: 'bbox-13-cell', cellCount: cells.length, passCount: 2, rowCount });
                if (centroidCell) checks.sampling = checkWithDetails(stable, checks.sampling, { sampleCentroidCell: centroidCell });
                checks.completeness = checkRecord(complete1 && stable, { completePasses: complete1 ? 2 : 0, cellCount: cells.length });
                if (!stable || !complete1) throw new Error('13-cell results were incomplete or changed between passes.');
                if (['geojson-snapshot', 'gml-snapshot'].includes(candidate.descriptor.adapter)) {
                    checks.completeness = checkWithDetails(checks.completeness.passed, checks.completeness, { pagingRequired:false, reason:'Complete immutable snapshot loader; pagination is not part of the source protocol.' });
                } else if (candidate.descriptor.adapter === 'catastro-wfs') {
                    const manifestComplete = complete1 && pass1.length === cells.length && pass1.every(cell => cell.complete);
                    checks.completeness = checkWithDetails(checks.completeness.passed && manifestComplete, checks.completeness,
                        { pagingRequired:false, completeNativeQueries: manifestComplete, reason:'Bounded GetFeature returns a production completeness signal; this protocol does not paginate.' });
                    if (!manifestComplete) throw new Error('Catastro bounded GetFeature did not report complete results for every cell.');
                } else if (candidate.descriptor.idsQueryMode === 'distinct-ids') {
                    // This production protocol checks full distinct-ID membership itself, including
                    // repeated manifests; generic resultOffset requirements would misread that as paging failure.
                    const manifestComplete = complete1 && firstExact && secondExact
                        && candidate.sampleIds.every(id => firstExact.has(id) && secondExact.has(id));
                    checks.completeness = checkWithDetails(checks.completeness.passed && manifestComplete, checks.completeness,
                        { pagingRequired:false, completeNativeManifest: manifestComplete, reason:'Production distinct-ID manifest is complete and sample IDs were independently repeated.' });
                    if (!manifestComplete) throw new Error('Distinct-ID manifest or repeated sample-ID verification was incomplete.');
                } else try {
                    const forcedIds = [...all.keys()].sort().slice(0, MAX_SAMPLE_IDS);
                    if (forcedIds.length < 2) throw new Error('At least two known IDs are required to demonstrate forced page-size-one behavior.');
                    const before = state.requests.length;
                    const forced = await runSource('forced-page-size-one', async adapter => getExact(adapter, forcedIds));
                    const returnedIds = [...forced.keys()].sort();
                    const observed = state.requests.slice(before).filter(request => request.stage === 'forced-page-size-one');
                    const evidence = assessForcedQueryEvidence({ requests: observed, expectedIds: forcedIds, returnedIds,
                        // getExact returns only after verifying the production adapter's complete flag,
                        // exact cardinality, absence list, and exact requested ID set.
                        complete: true, mode: candidate.descriptor.idsQueryMode });
                    checks.completeness = checkWithDetails(checks.completeness.passed && evidence.passed, checks.completeness,
                        { forcedPageSize: 1, forcedKnownIdCount: forcedIds.length, ...evidence });
                    ingest([...forced.values()]);
                    if (!evidence.passed) throw new Error('Adapter did not provide complete, distinct page-size-one native-query evidence for the exact returned IDs.');
                } catch (error) { recordFailure('forcedPaging', error); checks.completeness = checkWithDetails(false, checks.completeness, { forcedPageSize: 1 }); }
            } catch (error) {
                recordFailure('sampling', error);
                checks.sampling = checkRecord(false, { capability: 'bbox-13-cell', cellCount: sampledCells.length, attemptedCellCount: cells.length });
                checks.completeness = checkRecord(false, { capability: 'bbox-13-cell' });
            }
        } else {
            checks.completeness = checkRecord(true, { capability: 'areaEnumeration:false', reason: 'Adapter contract is point/exact-ID only; no area coverage claim.' });
            try {
                const centers = cellsForPoint(candidate.city.point, step).slice(0, 12).map(cell =>
                    [(cell.bbox[0] + cell.bbox[2]) / 2, (cell.bbox[1] + cell.bbox[3]) / 2]);
                const points = [candidate.city.point, ...centers];
                const first = await runSource('13-point-pass-one', async adapter => {
                    if (typeof adapter.queryPoint !== 'function') throw new Error('Point-only adapter has no queryPoint support; qualification pattern is insufficient.');
                    const results = [];
                    for (const [index, point] of points.entries()) {
                        const r = await adapter.queryPoint(point);
                        if (r?.complete !== true || !Array.isArray(r.features)) throw new Error('Point query result is incomplete.');
                        ingest(r.features); results.push({ index, point, count: r.features.length, unchangedWupPoint: index === 0 });
                    }
                    return results;
                });
                samplingPoints.push(...first);
                checks.sampling = checkRecord(first.length === 13, { capability: '13-point-sample', pointCount: first.length, includesUnchangedWupPoint: first[0]?.unchangedWupPoint === true, areaCompleteness: false });
            } catch (error) { recordFailure('sampling', error); checks.sampling = checkRecord(false, { capability: '13-point-sample' }); }
        }

        try {
            const sampleFeature = (firstExact || secondExact)?.get(candidate.sampleIds[0]);
            if (!sampleFeature) throw new Error('No known sample geometry is available for binding.');
            const act = await runSource('parcel-act-binding', adapter => computeSourceParcelActBinding(adapter, candidate.sampleIds, { sourceId }));
            if (!act.binding || act.binding.coverage !== 'complete' || !act.binding.parcels.length) throw new Error('Declared parcel-act binding is incomplete.');
            if (areaEnumeration) {
                const geometryBinding = await runSource('geometry-binding', async adapter => computeSourceBinding(adapter, { site: sampleFeature.geometry, sourceId, toleranceM: 0 }));
                const bindingCovered = geometryBinding.binding?.coverage === 'complete'
                    || (Number.isFinite(geometryBinding.binding?.unsurveyedM2) && geometryBinding.binding.unsurveyedM2 <= 0.01);
                if (!geometryBinding.binding || !bindingCovered
                    || !geometryBinding.binding.parcels.some(p => p.parcelId === sampleFeature.id)) throw new Error('Sample geometry did not produce a source binding.');
                checks.binding = checkRecord(true, { geometryBindingCoverage: geometryBinding.binding.coverage,
                    unsurveyedM2: geometryBinding.binding.unsurveyedM2 ?? null, acceptedNoiseAllowanceM2: 0.01, actParcelCount: act.binding.parcels.length });
            } else {
                checks.binding = checkRecord(true, { geometryBinding: 'unsupported-area-query', actParcelCount: act.binding.parcels.length });
            }
        } catch (error) { recordFailure('binding', error); checks.binding = checkRecord(false); }

        // Binding queries can add features, so reread all collected IDs only after binding.
        try {
            const collectedIds = [...all.keys()].sort();
            if (!collectedIds.length) throw new Error('No collected IDs are available for independent reread.');
            const reread = new Map();
            const fresh = makeAdapter('fresh-read-all-collected-ids');
            try {
                for (let offset = 0; offset < collectedIds.length; offset += 80) {
                    const batch = collectedIds.slice(offset, offset + 80);
                    const result = await getExact(fresh.adapter, batch);
                    for (const [id, feature] of result) reread.set(id, feature);
                }
            } finally { fresh.restore(); }
            const stable = reread.size === collectedIds.length && collectedIds.every(id =>
                createHash('sha256').update(JSON.stringify(all.get(id).geometry)).digest('hex') ===
                createHash('sha256').update(JSON.stringify(reread.get(id)?.geometry)).digest('hex'));
            checks.stableGeometry = checkRecord(stable, { independentRead: true, comparedCount: reread.size, collectedUniqueCount: collectedIds.length });
            checks.exactIds = checkWithDetails(checks.exactIds.passed && stable, checks.exactIds,
                { freshCollectedIds: collectedIds.length, freshBatchSize: 80 });
            if (!stable) throw new Error('Fresh exact-ID reread changed or omitted collected geometry.');
        } catch (error) {
            recordFailure('freshCollectedIdRead', error);
            checks.stableGeometry = checkRecord(false, { independentRead: true });
            checks.exactIds = checkWithDetails(false, checks.exactIds, { freshCollectedIds: 0 });
        }
    } finally {
        globalThis.fetch = originalFetch;
        delete globalThis.__qualificationOriginalFetch;
    }

    // Never publish provider properties beyond these canonical identifiers and the unchanged geometry.
    const features = [...all.values()].sort((a, b) => a.id.localeCompare(b.id));
    const cache = { type: 'FeatureCollection', features };
    const cacheBytes = Buffer.from(`${JSON.stringify(cache)}\n`);
    await fs.writeFile(cachePath, cacheBytes);
    const cacheHash = sha256(cacheBytes);
    try {
        const metric = await runMetric({ metricScript: args.metricScript, outputDir, cachePath, metricEpsg: metricCrs, sourceHash: cacheHash, expectedFeatures: features.length });
        checks.metric = checkRecord(true, metric);
    } catch (error) { recordFailure('metric', error); checks.metric = checkRecord(false, safeFailure(error)); }

    const passed = Object.values(checks).every(check => check.passed);
    const status = passed ? 'technical-qualified' : candidate.sourceClassification?.isParcel === false ? 'excluded' : 'held';
    const report = {
        schemaVersion: 1,
        status,
        cityCode: candidate.city.code,
        cityName: candidate.city.name,
        sourceId,
        candidateSha256: sha256(candidateBytes),
        checks,
        ...(checks.metric.passed ? { geometryReport: path.basename(metricReportPath) } : {}),
        cacheFile: path.basename(cachePath),
        cacheSha256: cacheHash,
        featureCount: features.length,
        sampleIds: candidate.sampleIds,
        cellSizeDegrees: step,
        sampledCells: sampledCells.map(({ index, dx, dy, bbox, complete, featureCount, ids }) => ({ index, dx, dy, bbox, complete, featureCount, ids })),
        sampledPoints: samplingPoints,
        requestCount: state.requests.length,
        requestLimit: MAX_REQUESTS,
        requests: state.requests,
        failures,
        limitations: [
            'Local bounded source qualification is not citywide completeness, legal title, survey accuracy, or currentness.',
            ...(!areaEnumeration ? ['Area enumeration is unsupported by descriptor; point/exact-ID checks do not imply area completeness.'] : [])
        ]
    };
    await fs.writeFile(path.join(outputDir, 'qualification.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: report.status, cityCode: report.cityCode, sourceId, checks: Object.fromEntries(Object.entries(checks).map(([k,v]) => [k,v.passed])), featureCount: report.featureCount, requestCount: report.requestCount, outputDir })}\n`);
    if (!passed) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
    main().catch(async error => {
        const failure = safeFailure(error);
        try {
            const args = parseArgs(process.argv.slice(2));
            await fs.mkdir(args.outputDir, { recursive: true });
            let cityCode = null, candidateSha256 = null;
            try {
                const bytes = await fs.readFile(args.candidatePath);
                candidateSha256 = sha256(bytes);
                cityCode = JSON.parse(bytes.toString('utf8'))?.city?.code ?? null;
            } catch { /* Keep failure output data-free. */ }
            const checks = Object.fromEntries(['classification','exactIds','stableGeometry','explicitAbsence','sampling','completeness','binding','metric'].map(key => [key, { passed: false }]));
            await fs.writeFile(path.join(args.outputDir, 'qualification.json'), `${JSON.stringify({ schemaVersion:1, status:'held', cityCode, candidateSha256, checks, failure }, null, 2)}\n`);
        } catch { /* CLI or output-path errors have no report destination. */ }
        process.stderr.write(`${JSON.stringify({ status: 'held', ...failure })}\n`);
        process.exitCode = 2;
    });
}
