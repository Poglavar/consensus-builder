// Immutable model-view flight records: route points own their orientation, timing derives from a
// cruise speed, and playback evaluates deterministic metric positions and quaternions.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlight = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const SCHEMA = 'camera-flight/v2';
    const LIMITS = Object.freeze({ route: 256, looks: 4096, cues: 256, interiors: 64, designs: 1000, seconds: 600, radiusM: 60000,
        minSpeedMps: .1, maxSpeedMps: 200, minTravelSeconds: .5, maxTurns: 16 });
    const AXES = ['yaw', 'pitch', 'roll'];
    const CID = /^baf(?:krei[a-z2-7]{52}|ybei[a-z2-7]{52})$/;
    const SETTINGS = ['existing', 'permitted', 'proposed', 'existingScope', 'proposedForm', 'permittedForm',
        'permittedMap', 'zoningAreas', 'planningSource', 'planningScenario', 'xray', 'suggested', 'suggestedExisting', 'cutaway'];
    const CUE_SETTINGS = ['xray', 'suggested', 'suggestedExisting', 'cutaway'];
    const CAMERA = ['targetLat', 'targetLng', 'headingDeg', 'pitchRad', 'range'];
    // The app's languages, as plan-record.js accepts them.
    const LANGUAGES = ['en', 'hr', 'es', 'sr', 'ar', 'fr', 'pt'];
    const finite = x => typeof x === 'number' && Number.isFinite(x);
    const object = x => !!x && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
    const keys = (x, allowed) => object(x) && Object.keys(x).every(key => allowed.includes(key));
    const text = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max;
    const vector = (x, count) => Array.isArray(x) && x.length === count && Array.from(x).every(finite);
    const id = x => text(x, 100) && x === x.trim();
    const clone = x => JSON.parse(JSON.stringify(x));
    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
    const length = a => Math.hypot(...a);
    const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
    const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
    const normalized = q => q.map(x => x / length(q));
    const unit = q => vector(q, 4) && Math.abs(length(q) - 1) <= 1e-5;

    function multiply(a, b) {
        const [x, y, z, w] = a, [bx, by, bz, bw] = b;
        return normalized([w * bx + x * bw + y * bz - z * by, w * by - x * bz + y * bw + z * bx,
            w * bz + x * by - y * bx + z * bw, w * bw - x * bx - y * by - z * bz]);
    }

    // Yaw turns about the world vertical; pitch and roll turn about the camera's own axes.
    function turned(base, axis, halfAngle) {
        const rotation = [0, 0, 0, Math.cos(halfAngle)];
        rotation[axis === 'pitch' ? 0 : 2] = Math.sin(halfAngle) * (axis === 'roll' ? -1 : 1);
        return axis === 'yaw' ? multiply(rotation, base) : multiply(base, rotation);
    }

    function settingsError(settings, allowed) {
        if (!keys(settings, allowed) || Object.values(settings).some(x => !text(x, 200))) return true;
        for (const flag of ['xray', 'suggested', 'suggestedExisting']) {
            if (settings[flag] !== undefined && !['0', '1'].includes(settings[flag])) return true;
        }
        return settings.cutaway !== undefined && !/^(?:all|-?(?:0|[1-9]\d{0,5}))$/.test(settings.cutaway);
    }

    function viewError(v) {
        if (!keys(v, ['at', 'mode', 'city', 'language', 'camera', 'settings']) || v.mode !== 'model') return true;
        const parts = typeof v.at === 'string' ? v.at.split(',') : [];
        const at = parts.map(Number);
        if (parts.length !== 3 || parts.some(x => !x.trim()) || !at.every(finite)
            || Math.abs(at[0]) > 85.0511 || Math.abs(at[1]) > 180 || at[2] < 3 || at[2] > 22) return true;
        if (v.city !== undefined && v.city !== null && !text(v.city, 100)) return true;
        if (v.language !== undefined && v.language !== null && !LANGUAGES.includes(v.language)) return true;
        if (v.camera !== undefined && v.camera !== null && (!keys(v.camera, CAMERA)
            || !CAMERA.every(key => finite(v.camera[key])) || Math.abs(v.camera.targetLat) > 85.0511
            || Math.abs(v.camera.targetLng) > 180 || v.camera.pitchRad < -Math.PI / 2
            || v.camera.pitchRad > 0 || v.camera.range < 1 || v.camera.range > 1e7)) return true;
        return settingsError(v.settings, SETTINGS);
    }

    // Bound nested snapshots too: only finite JSON values, no cycles or unbounded geometry trees.
    function jsonValue(value, budget, depth = 0) {
        if (--budget.remaining < 0 || depth > 40) return false;
        if (value === null || typeof value === 'boolean') return true;
        if (typeof value === 'string') return value.length <= 100000;
        if (typeof value === 'number') return finite(value);
        if (Array.isArray(value)) return Array.from(value).every(x => jsonValue(x, budget, depth + 1));
        return object(value) && Object.keys(value).every(key => key.length <= 200 && jsonValue(value[key], budget, depth + 1));
    }

    function interiorError(interior) {
        if (!keys(interior, ['id', 'feature', 'buildingId', 'revision']) || !id(interior.id)) return true;
        if (['buildingId', 'revision'].some(key => interior[key] !== undefined && !text(interior[key], 200))) return true;
        const f = interior.feature;
        if (!keys(f, ['type', 'geometry', 'properties', 'id', 'bbox']) || f.type !== 'Feature'
            || !object(f.properties) || !object(f.properties.floorPlans)
            || !keys(f.geometry, ['type', 'coordinates']) || !['Polygon', 'MultiPolygon'].includes(f.geometry.type)) return true;
        const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        if (!Array.isArray(polygons) || !polygons.length || Array.from(polygons).some(polygon => !Array.isArray(polygon)
            || !polygon.length || Array.from(polygon).some(ring => !Array.isArray(ring) || ring.length < 4
                || Array.from(ring).some(p => !Array.isArray(p) || ![2, 3].includes(p.length) || !Array.from(p).every(finite)
                    || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)
                || distance(ring[0], ring[ring.length - 1]) !== 0))) return true;
        return !jsonValue(f, { remaining: 100000 });
    }

    function pointError(point, index, count) {
        if (!keys(point, ['id', 'position', 'quaternion', 'travelSeconds', 'holdSeconds', 'turn'])) return true;
        if (!vector(point.position, 3) || point.position.some(x => Math.abs(x) > 1e7)
            || Math.hypot(point.position[0], point.position[1]) > LIMITS.radiusM || !unit(point.quaternion)) return true;
        if (index === 0 ? point.travelSeconds !== null : point.travelSeconds !== null && !(finite(point.travelSeconds) && point.travelSeconds > 0)) return true;
        if (!finite(point.holdSeconds) || point.holdSeconds < 0) return true;
        if (point.turn === null) return false;
        return !keys(point.turn, ['axis', 'turns']) || !AXES.includes(point.turn.axis) || !Number.isInteger(point.turn.turns)
            || point.turn.turns === 0 || Math.abs(point.turn.turns) > LIMITS.maxTurns || point.holdSeconds <= 0 || count < 1;
    }

    // Shape checks only; timing errors surface from the timeline, which needs valid positions first.
    function shapeError(record) {
        if (!keys(record, ['schema', 'title', 'designCids', 'view', 'frame', 'fov', 'speedMps', 'route', 'looks', 'interiors', 'cues'])
            || record.schema !== SCHEMA) return 'Invalid camera flight.';
        if (!text(record.title, 160) || record.title !== record.title.trim()) return 'Enter a flight name of up to 160 characters.';
        const cids = record.designCids;
        if (!Array.isArray(cids) || cids.length > LIMITS.designs || Array.from(cids).some((cid, i) => typeof cid !== 'string'
            || !CID.test(cid) || (i > 0 && cids[i - 1] >= cid))) return 'Invalid published flight designs.';
        if (viewError(record.view)) return 'Invalid flight map view.';
        const frame = record.frame;
        if (!keys(frame, ['lat', 'lng', 'datum']) || !finite(frame.lat) || Math.abs(frame.lat) > 85
            || !finite(frame.lng) || frame.lng < -180 || frame.lng >= 180
            || [frame.lat, frame.lng].some(n => Math.round(n * 1e6) / 1e6 !== n)
            || frame.datum !== 'model-ground') return 'Invalid flight metric frame: use a canonical six-decimal anchor within the supported latitude band.';
        if (!finite(record.fov) || record.fov < 20 || record.fov > 100) return 'Invalid flight field of view.';
        if (!finite(record.speedMps) || record.speedMps < LIMITS.minSpeedMps || record.speedMps > LIMITS.maxSpeedMps) return 'Invalid flight cruise speed.';
        for (const name of ['route', 'looks', 'interiors', 'cues']) {
            const entries = record[name];
            if (!Array.isArray(entries) || entries.length > LIMITS[name]
                || Array.from(entries).some(entry => !object(entry) || !id(entry.id))
                || new Set(entries.map(entry => entry.id)).size !== entries.length) return `Invalid flight ${name}.`;
        }
        if (!record.route.length || record.route.some((point, i) => pointError(point, i, record.route.length))) return 'Invalid flight route or timing.';
        const index = new Map(record.route.map((point, i) => [point.id, i])), last = record.route.length - 1;
        if (record.looks.some(look => !keys(look, ['id', 'after', 'fraction', 'quaternion']) || !index.has(look.after)
            || index.get(look.after) === last || !finite(look.fraction) || look.fraction <= 0 || look.fraction >= 1 || !unit(look.quaternion))
            || new Set(record.looks.map(look => look.after + '@' + look.fraction)).size !== record.looks.length) return 'Invalid flight look keys.';
        if (record.cues.some(cue => !keys(cue, ['id', 'at', 'settings']) || !index.has(cue.at)
            || settingsError(cue.settings, CUE_SETTINGS) || !Object.keys(cue.settings).length)
            || new Set(record.cues.map(cue => cue.at)).size !== record.cues.length) return 'Invalid flight view cues.';
        if (record.interiors.some(interiorError)) return 'Invalid flight interior snapshot.';
        return null;
    }

    function validate(record, { draft = false } = {}) {
        const error = shapeError(record);
        if (error) return error;
        let seconds;
        try { seconds = timeline(record).duration; }
        catch (failure) { return failure.message; }
        if (!finite(seconds) || seconds > LIMITS.seconds || (!draft && seconds <= 0)) return 'A flight must last up to 600 seconds.';
        return null;
    }

    function create({ title = 'Camera flight', designCids = [], view, frame, pose, speedMps = 15 }) {
        if (!object(pose) || !vector(pose.position, 3) || !vector(pose.quaternion, 4)
            || length(pose.quaternion) < 1e-10) throw new Error('Invalid initial camera pose.');
        const record = { schema: SCHEMA, title: title.trim(), designCids: [...new Set(designCids)].sort(),
            view: clone(view), frame: clone(frame), fov: pose.fov === undefined ? 45 : pose.fov, speedMps,
            route: [{ id: 'route-1', position: pose.position.slice(), quaternion: normalized(pose.quaternion), travelSeconds: null, holdSeconds: 0, turn: null }],
            looks: [], interiors: [], cues: [] };
        const error = validate(record, { draft: true });
        if (error) throw new Error(error);
        return record;
    }

    function slerp(a, b, t) {
        let target = normalized(b);
        const start = normalized(a);
        let dot = start.reduce((sum, x, i) => sum + x * target[i], 0);
        if (dot < 0) { target = target.map(x => -x); dot = -dot; }
        t = clamp(t, 0, 1);
        if (dot > 0.9995) return normalized(mix(start, target, t));
        const angle = Math.acos(clamp(dot, -1, 1)), sin = Math.sin(angle);
        return start.map((x, i) => (x * Math.sin((1 - t) * angle) + target[i] * Math.sin(t * angle)) / sin);
    }

    function segmentCurve(points, i) {
        const b = points[i - 1], c = points[i];
        if (distance(b, c) < 1e-9) return () => b.slice();
        if (points.length === 2) return t => mix(b, c, t);
        let before = i - 2, after = i + 1;
        while (before >= 0 && distance(points[before], b) < 1e-9) before--;
        while (after < points.length && distance(points[after], c) < 1e-9) after++;
        const a = before >= 0 ? points[before] : b.map((x, axis) => 2 * x - c[axis]);
        const d = after < points.length ? points[after] : c.map((x, axis) => 2 * x - b[axis]);
        // Centripetal knots are separated by sqrt(chord length), avoiding loops at uneven nodes.
        const t0 = 0, t1 = Math.sqrt(distance(a, b)), t2 = t1 + Math.sqrt(distance(b, c)), t3 = t2 + Math.sqrt(distance(c, d));
        const blend = (p, q, left, right, t) => mix(p, q, (t - left) / (right - left));
        return u => {
            if (u <= 0) return b.slice();
            if (u >= 1) return c.slice();
            const t = t1 + (t2 - t1) * u;
            const ab = blend(a, b, t0, t1, t), bc = blend(b, c, t1, t2, t), cd = blend(c, d, t2, t3, t);
            return blend(blend(ab, bc, t0, t2, t), blend(bc, cd, t1, t3, t), t1, t2, t);
        };
    }

    function distanceSampler(curve) {
        const count = 160, samples = [0];
        let previous = curve(0), total = 0;
        for (let i = 1; i <= count; i++) {
            const point = curve(i / count);
            if (Math.hypot(point[0], point[1]) > LIMITS.radiusM) throw new Error('Flight curve leaves the 60 km metric frame domain.');
            total += distance(previous, point); samples.push(total); previous = point;
        }
        function at(fraction) {
            if (total < 1e-9 || fraction <= 0) return curve(0);
            if (fraction >= 1) return curve(1);
            const target = fraction * total;
            let lo = 0, hi = count;
            while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid] < target) lo = mid; else hi = mid; }
            const step = samples[hi] - samples[lo];
            const point = curve((lo + (step ? (target - samples[lo]) / step : 0)) / count);
            if (Math.hypot(point[0], point[1]) > LIMITS.radiusM) throw new Error('Flight curve leaves the 60 km metric frame domain.');
            return point;
        }
        return { length: total, at };
    }

    // Absolute times derive from the route: arc length over cruise speed unless a point overrides
    // its travel time. Every orientation key, turn, mid-segment look and cue resolves to a time here.
    function timeline(record) {
        const route = record.route, positions = route.map(point => point.position);
        const segments = positions.map((_, i) => i ? distanceSampler(segmentCurve(positions, i)) : null);
        const travel = route.map((point, i) => !i ? 0 : point.travelSeconds ?? Math.max(LIMITS.minTravelSeconds, segments[i].length / record.speedMps));
        const arrivals = [], departures = [];
        route.forEach((point, i) => {
            arrivals.push(i ? departures[i - 1] + travel[i] : 0);
            departures.push(arrivals[i] + point.holdSeconds);
        });
        const duration = route.length ? departures[route.length - 1] : 0;
        const looks = [];
        route.forEach((point, i) => {
            looks.push({ id: point.id, time: arrivals[i], quaternion: point.quaternion.slice(), kind: 'view', point: point.id });
            if (!point.holdSeconds) return;
            if (!point.turn) { looks.push({ id: point.id + ':hold', time: departures[i], quaternion: point.quaternion.slice(), kind: 'hold', point: point.id }); return; }
            const { axis, turns } = point.turn, count = Math.max(8, Math.ceil(Math.abs(turns) * 8));
            for (let step = 1; step <= count; step++) {
                looks.push({ id: `${point.id}:turn-${step}`, time: arrivals[i] + point.holdSeconds * step / count,
                    quaternion: turned(point.quaternion, axis, Math.PI * turns * step / count), kind: 'turn', point: point.id });
            }
        });
        const index = new Map(route.map((point, i) => [point.id, i]));
        for (const look of record.looks) {
            const i = index.get(look.after);
            looks.push({ id: look.id, time: departures[i] + look.fraction * travel[i + 1], quaternion: look.quaternion.slice(), kind: 'look', point: look.after });
        }
        looks.sort((a, b) => a.time - b.time);
        const cues = record.cues.map(cue => ({ id: cue.id, time: arrivals[index.get(cue.at)], settings: { ...cue.settings }, point: cue.at }))
            .sort((a, b) => a.time - b.time);
        return { arrivals, departures, travel, duration, looks, cues, segments };
    }

    const arrivals = record => timeline(record).arrivals;
    const duration = record => timeline(record).duration;

    function compile(input) {
        const error = validate(input, { draft: true });
        if (error) throw new Error(error);
        const record = clone(input), times = timeline(record), seconds = times.duration;
        const positions = record.route.map(point => point.position), { segments, looks, cues } = times;
        function evaluate(time) {
            if (!finite(time)) throw new Error('Invalid flight playhead.');
            time = clamp(time, 0, seconds);
            let position = positions[positions.length - 1].slice();
            for (let i = 0; i < positions.length; i++) {
                if (time <= times.departures[i]) { position = positions[i].slice(); break; }
                if (i + 1 < positions.length && time < times.arrivals[i + 1]) {
                    position = segments[i + 1].at((time - times.departures[i]) / times.travel[i + 1]); break;
                }
            }
            let quaternion = looks[looks.length - 1].quaternion.slice();
            for (let i = 0; i < looks.length; i++) {
                if (time <= looks[i].time) {
                    const span = i ? looks[i].time - looks[i - 1].time : 0;
                    quaternion = span > 0 ? slerp(looks[i - 1].quaternion, looks[i].quaternion, (time - looks[i - 1].time) / span) : looks[i].quaternion.slice();
                    break;
                }
            }
            const settings = { ...record.view.settings };
            for (const cue of cues) { if (cue.time > time) break; Object.assign(settings, cue.settings); }
            return { position, quaternion, fov: record.fov, settings };
        }
        return Object.freeze({ duration: seconds, evaluate });
    }
    return Object.freeze({ SCHEMA, LIMITS, AXES, validate, create, duration, arrivals, timeline, compile, slerp, multiply });
});
