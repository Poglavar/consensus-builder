import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { loadTrafficNetwork } from '../traffic/network-source.mjs';

const NETWORK_PATH = '/promet/simulator/network';
const STATUS_PATH = '/promet/simulator/status';
const UNAVAILABLE = { error: 'Simulator prometa trenutačno nije dostupan.' };

function acceptedGzip(header = '') {
    return String(header).split(',').some(token => {
        const [encoding, ...params] = token.trim().split(';');
        return encoding.toLowerCase() === 'gzip'
            && !params.some(param => /^q\s*=\s*0(?:\.0*)?\s*$/i.test(param.trim()));
    });
}

function networkCounts(network) {
    const sourceCounts = network.source?.counts || {};
    return {
        surfaceLanes: sourceCounts.surfaceLanes ?? network.surfaceLanes?.length ?? 0,
        tramWays: sourceCounts.tramWays ?? 0,
        tramTrackPaths: sourceCounts.tramTrackPaths ?? 0,
        simulatedLanes: sourceCounts.simulatedLanes ?? network.lanes?.length ?? 0,
        connections: sourceCounts.connections ?? network.connections?.length ?? 0,
        signals: sourceCounts.signals ?? network.signals?.length ?? 0,
        controlledSignals: sourceCounts.controlledSignals
            ?? network.signals?.filter(signal => signal.controls?.length).length ?? 0,
        savedJunctions: sourceCounts.savedJunctions ?? network.source?.savedJunctions?.length ?? 0,
        partialJunctions: sourceCounts.partialJunctions
            ?? network.source?.savedPartialJunctions?.length ?? 0,
        unresolvedNodes: sourceCounts.unresolvedNodes
            ?? network.nodes?.filter(node => node.unresolved).length ?? 0
    };
}

function statusSummary(network) {
    const source = network.source || {};
    return {
        source: {
            osmSnapshotId: source.osmSnapshotId ?? null,
            osmTimestamp: source.osmTimestamp ?? null,
            osmSha256: source.osmSha256 ?? null,
            updatedAt: source.updatedAt ?? null,
            exportedAt: source.exportedAt ?? null,
            selectedSolutions: source.selectedSolutions ?? 0,
            liveDecisions: source.liveDecisions ?? 0,
            blockedRestrictions: source.blockedRestrictions ?? 0,
            unsupportedRestrictionWays: source.unsupportedRestrictionWays ?? 0,
            signalSource: source.signalSource ?? null,
            tramSource: source.tramSource ?? null,
            note: source.note ?? null
        },
        bbox: network.bbox,
        counts: networkCounts(network)
    };
}

export function setupTrafficSimulatorRoute(app, pool, {
    env = process.env,
    loadNetwork = loadTrafficNetwork,
    cacheMs = 120000,
    now = Date.now
} = {}) {
    let cached = null;
    let inFlight = null;

    async function getNetwork() {
        const time = now();
        if (cached && time < cached.expiresAt) return cached;
        if (inFlight) return inFlight;
        cached = null;

        const task = (async () => {
            const topologyRoot = env.TRAFFIC_TOPOLOGY_ROOT;
            const roadsApi = env.TRAFFIC_ROADS_API;
            if (!topologyRoot || !roadsApi) throw new Error('Traffic simulator source is not configured.');
            const network = await loadNetwork({ pool, topologyRoot, roadsApi });
            if (!network || typeof network !== 'object' || !network.source || !Array.isArray(network.bbox)) {
                throw new Error('Traffic simulator source returned an invalid network.');
            }
            const body = Buffer.from(JSON.stringify(network));
            const etag = `W/"${createHash('sha256').update(body).digest('hex')}"`;
            return {
                network,
                body,
                gzip: gzipSync(body),
                etag,
                expiresAt: now() + Math.max(0, Number(cacheMs) || 0)
            };
        })();
        inFlight = task;
        try {
            cached = await task;
            return cached;
        } finally {
            if (inFlight === task) inFlight = null;
        }
    }

    function rejectCustomBbox(req, res, next) {
        if (Object.hasOwn(req.query, 'bbox')) {
            return res.status(400).json({ error: 'Područje simulatora određeno je unaprijed.' });
        }
        next();
    }

    async function respond(req, res, summary) {
        res.set('Cache-Control', 'no-cache');
        res.vary('Accept-Encoding');
        try {
            const entry = await getNetwork();
            const body = summary ? Buffer.from(JSON.stringify(statusSummary(entry.network))) : entry.body;
            const etag = summary
                ? `W/"${createHash('sha256').update(body).digest('hex')}"`
                : entry.etag;
            res.set('ETag', etag);
            if (req.fresh) return res.status(304).end();
            res.status(200).type('json');
            if (acceptedGzip(req.get('Accept-Encoding'))) {
                res.set('Content-Encoding', 'gzip');
                return res.send(summary ? gzipSync(body) : entry.gzip);
            }
            return res.send(body);
        } catch (_) {
            return res.status(503).json(UNAVAILABLE);
        }
    }

    app.get(NETWORK_PATH, rejectCustomBbox, (req, res) => respond(req, res, false));
    app.get(STATUS_PATH, rejectCustomBbox, (req, res) => respond(req, res, true));
}
