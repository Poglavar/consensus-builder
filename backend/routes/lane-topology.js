// Dedicated lane-topology manager API: raw OSM evidence, deterministic graph versions, CLI model
// recognition jobs, immutable solution history and canonical promotion.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
    TOPOLOGY_PROMPT_VERSION,
    providerAvailability,
    runCliTopologyProvider
} from '../lane-topology/cli-providers.js';

const require = createRequire(import.meta.url);
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');
const DDL = readFileSync(new URL('./lane-topology-ddl.sql', import.meta.url), 'utf8');

const STREET_RAILWAYS = ['tram', 'light_rail'];
const DRIVEABLE_HIGHWAYS = [
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
    'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
    'unclassified', 'residential', 'living_street', 'service', 'road'
];
const MAX_FEATURES = 5000;
const MAX_BBOX_SPAN_DEG = 0.08;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const schemaPromises = new WeakMap();

function ensureSchema(pool) {
    if (!schemaPromises.has(pool)) {
        const promise = pool.query(DDL).catch(error => {
            schemaPromises.delete(pool);
            throw error;
        });
        schemaPromises.set(pool, promise);
    }
    return schemaPromises.get(pool);
}

export function parseTopologyBbox(raw) {
    const parts = Array.isArray(raw)
        ? raw.map(Number)
        : String(raw || '').split(',').map(part => Number(part.trim()));
    if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))) return null;
    const [west, south, east, north] = parts;
    if (west >= east || south >= north) return null;
    if (west < -180 || east > 180 || south < -90 || north > 90) return null;
    if (east - west > MAX_BBOX_SPAN_DEG || north - south > MAX_BBOX_SPAN_DEG) return null;
    return parts;
}

function bboxAreaKey(city, bbox) {
    const normalized = bbox.map(value => Number(value).toFixed(7)).join(',');
    return createHash('sha256').update(`${city}:${normalized}`).digest('hex');
}

function bboxPolygon(bbox) {
    const [west, south, east, north] = bbox;
    return {
        type: 'Polygon',
        coordinates: [[
            [west, south], [east, south], [east, north], [west, north], [west, south]
        ]]
    };
}

function graphBuildOptions(snapshotAt) {
    return {
        snapshotAt,
        profileFromTags: CorridorProfile.corridorProfileFromOsmTags,
        orientProfile: OsmProfile.orientForRightHandTraffic
    };
}

export async function fetchTopologyOsm(pool, bbox, city = 'zagreb') {
    const [west, south, east, north] = bbox;
    const { rows } = await pool.query(
        `SELECT
            ST_AsGeoJSON(COALESCE(w.geom, r.geom))::json AS geometry,
            jsonb_build_object(
                'osm_id', r.osm_id,
                'highway_type', COALESCE(w.tags->>'highway', r.highway_type),
                'railway_type', COALESCE(w.tags->>'railway', r.railway_type),
                'name', COALESCE(w.tags->>'name', r.name),
                'width_meters', r.width_meters,
                'city', r.city,
                'tags', COALESCE(w.tags, r.tags),
                'osm_node_ids', COALESCE(to_jsonb(w.node_ids), to_jsonb(r)->'osm_node_ids'),
                'osm_snapshot_id', to_jsonb(r)->'osm_snapshot_id',
                'source', CASE WHEN w.osm_id IS NULL THEN 'osm_road' ELSE 'osm_topology_way' END
            ) AS properties,
            COALESCE(s.source_timestamp, r.date_added) AS date_added
         FROM osm_road r
         LEFT JOIN public.osm_topology_way w
           ON w.snapshot_id=(to_jsonb(r)->>'osm_snapshot_id')::bigint
          AND w.osm_id=r.osm_id
         LEFT JOIN public.osm_snapshot s
           ON s.id=(to_jsonb(r)->>'osm_snapshot_id')::bigint
          AND s.status='complete'
         WHERE r.current
           AND r.city = $1
           AND r.geom IS NOT NULL
           AND (
                COALESCE(w.tags->>'highway', r.highway_type) = ANY($2)
                OR COALESCE(w.tags->>'railway', r.railway_type) = ANY($3)
           )
           AND r.geom && ST_MakeEnvelope($4, $5, $6, $7, 4326)
         ORDER BY r.osm_id
         LIMIT ${MAX_FEATURES}`,
        [city, DRIVEABLE_HIGHWAYS, STREET_RAILWAYS, west, south, east, north]
    );
    const snapshotAt = rows.reduce((latest, row) => {
        const value = row.date_added ? new Date(row.date_added) : null;
        return value && (!latest || value > latest) ? value : latest;
    }, null);
    return {
        type: 'FeatureCollection',
        features: rows.map(row => ({
            type: 'Feature',
            geometry: row.geometry,
            properties: row.properties || {}
        })),
        snapshotAt: snapshotAt ? snapshotAt.toISOString() : null,
        truncated: rows.length >= MAX_FEATURES,
        limit: MAX_FEATURES
    };
}

async function insertProblems(client, solutionId, problems) {
    if (!Array.isArray(problems) || !problems.length) return;
    const keys = [];
    const types = [];
    const severities = [];
    const lons = [];
    const lats = [];
    const details = [];
    problems.forEach((problem, index) => {
        const point = Array.isArray(problem?.point) ? problem.point : null;
        keys.push(String(problem?.id || `problem:${index}`));
        types.push(String(problem?.type || 'unknown').slice(0, 80));
        severities.push(['info', 'warning', 'error'].includes(problem?.severity) ? problem.severity : 'warning');
        lons.push(Number.isFinite(Number(point?.[0])) ? Number(point[0]) : null);
        lats.push(Number.isFinite(Number(point?.[1])) ? Number(point[1]) : null);
        details.push(JSON.stringify(problem || {}));
    });
    await client.query(
        `INSERT INTO public.lane_topology_problem
            (solution_id, problem_key, problem_type, severity, point, details)
         SELECT $1, p.problem_key, p.problem_type, p.severity,
            CASE WHEN p.lon IS NOT NULL AND p.lat IS NOT NULL
                THEN ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)
                ELSE NULL
            END,
            p.details
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::double precision[],
                     $6::double precision[], $7::jsonb[])
              AS p(problem_key, problem_type, severity, lon, lat, details)`,
        [solutionId, keys, types, severities, lons, lats, details]
    );
}

async function withTransaction(pool, callback) {
    if (typeof pool.connect !== 'function') return callback(pool);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function storeTopologySolution(pool, {
    parentId = null,
    city = 'zagreb',
    bbox,
    status = 'candidate',
    sourceKind,
    provider = null,
    model = null,
    promptVersion = null,
    snapshotAt = null,
    graph
}) {
    const areaKey = bboxAreaKey(city, bbox);
    return withTransaction(pool, async client => {
        const { rows } = await client.query(
            `INSERT INTO public.lane_topology_solution
                (parent_id, city, area_key, status, source_kind, provider, model, prompt_version,
                 graph_schema_version, osm_snapshot_at, coverage, selected_bbox, graph, stats)
             VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 ST_MakeEnvelope($11, $12, $13, $14, 4326), $15::numeric[], $16::jsonb, $17::jsonb)
             RETURNING id, created_at`,
            [
                parentId, city, areaKey, status, sourceKind, provider, model, promptVersion,
                Number(graph.schemaVersion) || LaneTopologyGraph.SCHEMA_VERSION,
                snapshotAt,
                bbox[0], bbox[1], bbox[2], bbox[3],
                bbox,
                JSON.stringify(graph),
                JSON.stringify(graph.stats || {})
            ]
        );
        const stored = rows[0];
        await insertProblems(client, stored.id, graph.problems || []);
        return {
            id: Number(stored.id),
            parentId: parentId ? Number(parentId) : null,
            city,
            areaKey,
            status,
            sourceKind,
            provider,
            model,
            promptVersion,
            snapshotAt,
            bbox,
            graph,
            createdAt: stored.created_at instanceof Date ? stored.created_at.toISOString() : stored.created_at
        };
    });
}

async function buildDeterministicSolution(pool, bbox, city, parentId = null) {
    const evidence = await fetchTopologyOsm(pool, bbox, city);
    const graph = LaneTopologyGraph.build(evidence, graphBuildOptions(evidence.snapshotAt));
    const solution = await storeTopologySolution(pool, {
        parentId,
        city,
        bbox,
        sourceKind: 'deterministic',
        snapshotAt: evidence.snapshotAt,
        graph
    });
    return { evidence, solution };
}

function parseLimit(raw) {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? Math.max(1, Math.min(MAX_LIMIT, value)) : DEFAULT_LIMIT;
}

function serializedSolution(row, includeGraph = false) {
    const result = {
        id: Number(row.id),
        parentId: row.parent_id == null ? null : Number(row.parent_id),
        city: row.city,
        areaKey: row.area_key,
        status: row.status,
        sourceKind: row.source_kind,
        provider: row.provider,
        model: row.model,
        promptVersion: row.prompt_version,
        graphSchemaVersion: row.graph_schema_version,
        snapshotAt: row.osm_snapshot_at instanceof Date ? row.osm_snapshot_at.toISOString() : row.osm_snapshot_at,
        bbox: row.selected_bbox?.map(Number) || [],
        coverage: row.coverage || null,
        stats: row.stats || {},
        problemCounts: row.problem_counts || {},
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    };
    if (includeGraph) result.graph = row.graph;
    return result;
}

async function updateJobFailure(pool, jobId, error) {
    await pool.query(
        `UPDATE public.lane_topology_job
         SET status='failed', error=$2, output_tail=$3, finished_at=now(), updated_at=now()
         WHERE id=$1`,
        [jobId, String(error?.message || error).slice(0, 12000), String(error?.stack || '').slice(-8000)]
    );
}

async function executeRecognitionJob(pool, job, evidence, deterministicSolution, options) {
    const runProvider = options.runProvider || runCliTopologyProvider;
    try {
        await pool.query(
            `UPDATE public.lane_topology_job SET status='running', started_at=now(), updated_at=now() WHERE id=$1`,
            [job.id]
        );
        const result = await runProvider(job.provider, {
            selection: {
                city: job.city,
                bbox: job.bbox,
                snapshotAt: evidence.snapshotAt
            },
            osmWays: evidence.features,
            deterministicGraph: deterministicSolution.graph
        }, {
            ...(options.providerOptions || {}),
            model: job.model || options.providerOptions?.model || null
        });
        const solution = await storeTopologySolution(pool, {
            parentId: deterministicSolution.id,
            city: job.city,
            bbox: job.bbox,
            sourceKind: job.provider,
            provider: job.provider,
            model: job.model,
            promptVersion: TOPOLOGY_PROMPT_VERSION,
            snapshotAt: evidence.snapshotAt,
            graph: result.graph
        });
        await pool.query(
            `UPDATE public.lane_topology_job
             SET status='completed', result_solution_id=$2, output_tail=$3,
                 finished_at=now(), updated_at=now()
             WHERE id=$1`,
            [job.id, solution.id, result.outputTail || result.summary || '']
        );
    } catch (error) {
        console.error(`[lane-topology] ${job.provider} job ${job.id} failed:`, error);
        await updateJobFailure(pool, job.id, error);
    }
}

export function setupLaneTopologyRoute(app, pool, options = {}) {
    const env = options.env || process.env;
    const cliEnabled = options.cliEnabled !== undefined
        ? !!options.cliEnabled
        : env.NODE_ENV !== 'production' && env.LANE_TOPOLOGY_CLI_ENABLED !== 'false';

    app.get('/lane-topology/providers', (_req, res) => {
        const availability = cliEnabled
            ? {
                codex: providerAvailability('codex', options.spawnSyncImpl),
                claude: providerAvailability('claude', options.spawnSyncImpl)
            }
            : {
                codex: { available: false, version: null },
                claude: { available: false, version: null }
            };
        res.json({ enabled: cliEnabled, providers: availability, promptVersion: TOPOLOGY_PROMPT_VERSION });
    });

    app.get('/lane-topology/osm', async (req, res) => {
        const bbox = parseTopologyBbox(req.query.bbox);
        if (!bbox) {
            return res.status(400).json({ error: `Invalid WGS84 bbox; maximum span is ${MAX_BBOX_SPAN_DEG}°.` });
        }
        try {
            const evidence = await fetchTopologyOsm(pool, bbox, String(req.query.city || 'zagreb'));
            return res.json(evidence);
        } catch (error) {
            console.error('[lane-topology] OSM fetch failed:', error);
            return res.status(500).json({ error: 'Failed to load OSM topology evidence.' });
        }
    });

    app.post('/lane-topology/build', async (req, res) => {
        const bbox = parseTopologyBbox(req.body?.bbox);
        if (!bbox) {
            return res.status(400).json({ error: `Invalid WGS84 bbox; maximum span is ${MAX_BBOX_SPAN_DEG}°.` });
        }
        const city = String(req.body?.city || 'zagreb').slice(0, 64);
        try {
            await ensureSchema(pool);
            const result = await buildDeterministicSolution(pool, bbox, city, req.body?.parentId || null);
            return res.status(201).json({
                solution: result.solution,
                evidence: {
                    featureCount: result.evidence.features.length,
                    snapshotAt: result.evidence.snapshotAt,
                    truncated: result.evidence.truncated
                }
            });
        } catch (error) {
            console.error('[lane-topology] deterministic build failed:', error);
            return res.status(500).json({ error: 'Failed to build the deterministic lane graph.' });
        }
    });

    app.get('/lane-topology/solutions', async (req, res) => {
        const bbox = req.query.bbox ? parseTopologyBbox(req.query.bbox) : null;
        if (req.query.bbox && !bbox) {
            return res.status(400).json({ error: `Invalid WGS84 bbox; maximum span is ${MAX_BBOX_SPAN_DEG}°.` });
        }
        const city = String(req.query.city || 'zagreb').slice(0, 64);
        try {
            await ensureSchema(pool);
            const params = [city, parseLimit(req.query.limit)];
            let spatial = '';
            if (bbox) {
                params.push(...bbox);
                spatial = `AND s.coverage && ST_MakeEnvelope($3,$4,$5,$6,4326)`;
            }
            const { rows } = await pool.query(
                `SELECT
                    s.id, s.parent_id, s.city, s.area_key, s.status, s.source_kind,
                    s.provider, s.model, s.prompt_version, s.graph_schema_version,
                    s.osm_snapshot_at, s.selected_bbox, s.stats, s.created_at, s.updated_at,
                    ST_AsGeoJSON(s.coverage)::json AS coverage,
                    jsonb_build_object(
                        'error', count(p.id) FILTER (WHERE p.severity='error'),
                        'warning', count(p.id) FILTER (WHERE p.severity='warning'),
                        'info', count(p.id) FILTER (WHERE p.severity='info')
                    ) AS problem_counts
                 FROM public.lane_topology_solution s
                 LEFT JOIN public.lane_topology_problem p ON p.solution_id=s.id
                 WHERE s.city=$1 ${spatial}
                 GROUP BY s.id
                 ORDER BY s.created_at DESC
                 LIMIT $2`,
                params
            );
            return res.json({ solutions: rows.map(row => serializedSolution(row)) });
        } catch (error) {
            console.error('[lane-topology] solution list failed:', error);
            return res.status(500).json({ error: 'Failed to list topology solutions.' });
        }
    });

    app.get('/lane-topology/solutions/:id', async (req, res) => {
        try {
            await ensureSchema(pool);
            const { rows } = await pool.query(
                `SELECT s.*, ST_AsGeoJSON(s.coverage)::json AS coverage
                 FROM public.lane_topology_solution s WHERE s.id=$1`,
                [req.params.id]
            );
            if (!rows.length) return res.status(404).json({ error: 'Topology solution not found.' });
            return res.json({ solution: serializedSolution(rows[0], true) });
        } catch (error) {
            console.error('[lane-topology] solution fetch failed:', error);
            return res.status(500).json({ error: 'Failed to fetch the topology solution.' });
        }
    });

    app.post('/lane-topology/solutions/:id/promote', async (req, res) => {
        try {
            await ensureSchema(pool);
            const promoted = await withTransaction(pool, async client => {
                const selected = await client.query(
                    `SELECT id, city, area_key FROM public.lane_topology_solution WHERE id=$1 FOR UPDATE`,
                    [req.params.id]
                );
                if (!selected.rows.length) return null;
                const row = selected.rows[0];
                await client.query(
                    `UPDATE public.lane_topology_solution
                     SET status='candidate', updated_at=now()
                     WHERE city=$1 AND area_key=$2 AND status='canonical' AND id<>$3`,
                    [row.city, row.area_key, row.id]
                );
                await client.query(
                    `UPDATE public.lane_topology_solution SET status='canonical', updated_at=now() WHERE id=$1`,
                    [row.id]
                );
                return Number(row.id);
            });
            if (!promoted) return res.status(404).json({ error: 'Topology solution not found.' });
            return res.json({ id: promoted, status: 'canonical' });
        } catch (error) {
            console.error('[lane-topology] promotion failed:', error);
            return res.status(500).json({ error: 'Failed to promote the topology solution.' });
        }
    });

    app.post('/lane-topology/process', async (req, res) => {
        if (!cliEnabled) return res.status(503).json({ error: 'CLI topology recognition is disabled.' });
        const provider = String(req.body?.provider || '');
        if (!['codex', 'claude'].includes(provider)) {
            return res.status(400).json({ error: 'Provider must be "codex" or "claude".' });
        }
        const availability = providerAvailability(provider, options.spawnSyncImpl);
        if (!availability.available) {
            return res.status(503).json({ error: `${provider} CLI is not available.` });
        }
        const bbox = parseTopologyBbox(req.body?.bbox);
        if (!bbox) {
            return res.status(400).json({ error: `Invalid WGS84 bbox; maximum span is ${MAX_BBOX_SPAN_DEG}°.` });
        }
        const city = String(req.body?.city || 'zagreb').slice(0, 64);
        try {
            await ensureSchema(pool);
            const { evidence, solution: deterministicSolution } = await buildDeterministicSolution(
                pool, bbox, city, req.body?.baseSolutionId || null
            );
            const areaKey = bboxAreaKey(city, bbox);
            const { rows } = await pool.query(
                `INSERT INTO public.lane_topology_job
                    (provider, status, city, area_key, selected_bbox, base_solution_id, model,
                     prompt_version, input_summary)
                 VALUES ($1, 'queued', $2, $3, $4::numeric[], $5, $6, $7, $8::jsonb)
                 RETURNING id, created_at`,
                [
                    provider, city, areaKey, bbox, deterministicSolution.id,
                    req.body?.model ? String(req.body.model).slice(0, 128) : null,
                    TOPOLOGY_PROMPT_VERSION,
                    JSON.stringify({
                        sourceWays: evidence.features.length,
                        deterministicStats: deterministicSolution.graph.stats
                    })
                ]
            );
            const job = {
                id: Number(rows[0].id),
                provider,
                city,
                bbox,
                model: req.body?.model ? String(req.body.model).slice(0, 128) : null
            };
            queueMicrotask(() => executeRecognitionJob(
                pool, job, evidence, deterministicSolution, options
            ));
            return res.status(202).json({
                job: {
                    ...job,
                    status: 'queued',
                    baseSolutionId: deterministicSolution.id,
                    createdAt: rows[0].created_at instanceof Date
                        ? rows[0].created_at.toISOString()
                        : rows[0].created_at
                }
            });
        } catch (error) {
            console.error('[lane-topology] process enqueue failed:', error);
            return res.status(500).json({ error: 'Failed to enqueue topology recognition.' });
        }
    });

    app.get('/lane-topology/jobs/:id', async (req, res) => {
        try {
            await ensureSchema(pool);
            const { rows } = await pool.query(
                `SELECT * FROM public.lane_topology_job WHERE id=$1`,
                [req.params.id]
            );
            if (!rows.length) return res.status(404).json({ error: 'Topology job not found.' });
            const row = rows[0];
            return res.json({
                job: {
                    id: Number(row.id),
                    provider: row.provider,
                    status: row.status,
                    city: row.city,
                    bbox: row.selected_bbox?.map(Number) || [],
                    baseSolutionId: row.base_solution_id == null ? null : Number(row.base_solution_id),
                    resultSolutionId: row.result_solution_id == null ? null : Number(row.result_solution_id),
                    model: row.model,
                    promptVersion: row.prompt_version,
                    error: row.error,
                    createdAt: row.created_at,
                    startedAt: row.started_at,
                    finishedAt: row.finished_at
                }
            });
        } catch (error) {
            console.error('[lane-topology] job fetch failed:', error);
            return res.status(500).json({ error: 'Failed to fetch the topology job.' });
        }
    });
}
