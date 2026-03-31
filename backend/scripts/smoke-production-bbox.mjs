import { performance } from 'node:perf_hooks';

function getStringEnv(name, fallback) {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function getNumberEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must be a finite number.`);
    }
    return parsed;
}

function median(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function formatMs(value) {
    return `${value.toFixed(1)}ms`;
}

const config = {
    baseUrl: getStringEnv('PROD_SMOKE_BASE_URL', 'https://api.urbangametheory.xyz'),
    origin: getStringEnv('PROD_SMOKE_ORIGIN', 'https://urbangametheory.xyz'),
    bbox: getStringEnv('PROD_SMOKE_BBOX', '458500,5073000,459000,5073500'),
    timeoutMs: getNumberEnv('PROD_SMOKE_TIMEOUT_MS', 8000),
    warmupRuns: getNumberEnv('PROD_SMOKE_WARMUP_RUNS', 1),
    sequentialRuns: getNumberEnv('PROD_SMOKE_SEQUENTIAL_RUNS', 4),
    concurrentRuns: getNumberEnv('PROD_SMOKE_CONCURRENT_RUNS', 4),
    minFeatures: getNumberEnv('PROD_SMOKE_MIN_FEATURES', 1),
    maxSequentialHeaderMs: getNumberEnv('PROD_SMOKE_MAX_SEQUENTIAL_HEADER_MS', 2000),
    maxSequentialTotalMs: getNumberEnv('PROD_SMOKE_MAX_SEQUENTIAL_TOTAL_MS', 3000),
    maxConcurrentHeaderMs: getNumberEnv('PROD_SMOKE_MAX_CONCURRENT_HEADER_MS', 3000),
    maxConcurrentTotalMs: getNumberEnv('PROD_SMOKE_MAX_CONCURRENT_TOTAL_MS', 5000),
};

const healthUrl = new URL('/health', config.baseUrl);
const parcelsUrl = new URL('/parcels', config.baseUrl);
parcelsUrl.searchParams.set('bbox', config.bbox);

async function fetchJson(url, { expectFeatureCollection = false } = {}) {
    const startedAt = performance.now();
    const response = await fetch(url, {
        headers: {
            Accept: 'application/json',
            Origin: config.origin,
        },
        signal: AbortSignal.timeout(config.timeoutMs),
    });
    const headerMs = performance.now() - startedAt;

    const allowOrigin = response.headers.get('access-control-allow-origin');
    if (allowOrigin !== config.origin) {
        throw new Error(`Unexpected Access-Control-Allow-Origin header: ${allowOrigin || '<missing>'}`);
    }

    if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} from ${url.toString()} ${bodyText ? `body=${bodyText.slice(0, 160)}` : ''}`.trim());
    }

    const payload = await response.json();
    const totalMs = performance.now() - startedAt;

    if (expectFeatureCollection) {
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload?.features)) {
            throw new Error('Parcel bbox response is not a GeoJSON FeatureCollection.');
        }
        if (payload.features.length < config.minFeatures) {
            throw new Error(`Expected at least ${config.minFeatures} features, got ${payload.features.length}.`);
        }
    }

    return {
        headerMs,
        totalMs,
        payload,
        contentLength: Number(response.headers.get('content-length') || 0),
    };
}

async function runScenario(label, runs) {
    const results = [];
    for (let index = 0; index < runs; index += 1) {
        const result = await fetchJson(parcelsUrl, { expectFeatureCollection: true });
        results.push(result);
        console.log(`${label}#${index + 1}: header=${formatMs(result.headerMs)} total=${formatMs(result.totalMs)} features=${result.payload.features.length} bytes=${result.contentLength}`);
    }
    return results;
}

async function runConcurrent(runs) {
    const tasks = Array.from({ length: runs }, async (_, index) => {
        const result = await fetchJson(parcelsUrl, { expectFeatureCollection: true });
        console.log(`concurrent#${index + 1}: header=${formatMs(result.headerMs)} total=${formatMs(result.totalMs)} features=${result.payload.features.length} bytes=${result.contentLength}`);
        return result;
    });
    return Promise.all(tasks);
}

function summarize(results) {
    return {
        medianHeaderMs: median(results.map((entry) => entry.headerMs)),
        maxHeaderMs: Math.max(...results.map((entry) => entry.headerMs)),
        medianTotalMs: median(results.map((entry) => entry.totalMs)),
        maxTotalMs: Math.max(...results.map((entry) => entry.totalMs)),
        minFeatures: Math.min(...results.map((entry) => entry.payload.features.length)),
        maxFeatures: Math.max(...results.map((entry) => entry.payload.features.length)),
    };
}

function assertThresholds(summary, { maxHeaderMs, maxTotalMs }, label) {
    if (summary.maxHeaderMs > maxHeaderMs) {
        throw new Error(`${label} max header time ${formatMs(summary.maxHeaderMs)} exceeded threshold ${formatMs(maxHeaderMs)}.`);
    }
    if (summary.maxTotalMs > maxTotalMs) {
        throw new Error(`${label} max total time ${formatMs(summary.maxTotalMs)} exceeded threshold ${formatMs(maxTotalMs)}.`);
    }
}

console.log(`Checking health at ${healthUrl.toString()}`);
await fetchJson(healthUrl);

for (let index = 0; index < config.warmupRuns; index += 1) {
    const result = await fetchJson(parcelsUrl, { expectFeatureCollection: true });
    console.log(`warmup#${index + 1}: header=${formatMs(result.headerMs)} total=${formatMs(result.totalMs)} features=${result.payload.features.length}`);
}

console.log(`Running ${config.sequentialRuns} sequential bbox checks against ${parcelsUrl.toString()}`);
const sequentialResults = await runScenario('sequential', config.sequentialRuns);
const sequentialSummary = summarize(sequentialResults);

console.log(`Running ${config.concurrentRuns} concurrent bbox checks against ${parcelsUrl.toString()}`);
const concurrentResults = await runConcurrent(config.concurrentRuns);
const concurrentSummary = summarize(concurrentResults);

assertThresholds(sequentialSummary, {
    maxHeaderMs: config.maxSequentialHeaderMs,
    maxTotalMs: config.maxSequentialTotalMs,
}, 'Sequential');
assertThresholds(concurrentSummary, {
    maxHeaderMs: config.maxConcurrentHeaderMs,
    maxTotalMs: config.maxConcurrentTotalMs,
}, 'Concurrent');

console.log('Smoke summary:');
console.log(JSON.stringify({
    config,
    sequential: sequentialSummary,
    concurrent: concurrentSummary,
}, null, 2));
