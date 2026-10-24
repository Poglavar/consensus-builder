// Immutable model-view flight records and deterministic metric-position/quaternion playback.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlight = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const SCHEMA = 'camera-flight/v1';
    const LIMITS = Object.freeze({ route: 256, looks: 4096, cues: 256, interiors: 64, designs: 1000, seconds: 600, radiusM: 60000 });
    const CID = /^baf(?:krei[a-z2-7]{52}|ybei[a-z2-7]{52})$/;
    const SETTINGS = ['existing', 'permitted', 'proposed', 'existingScope', 'proposedForm', 'permittedForm',
        'permittedMap', 'zoningAreas', 'planningSource', 'planningScenario', 'xray', 'suggested', 'suggestedExisting', 'cutaway'];
    const CUE_SETTINGS = ['xray', 'suggested', 'suggestedExisting', 'cutaway'];
    const CAMERA = ['targetLat', 'targetLng', 'headingDeg', 'pitchRad', 'range'];
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
        if (v.language !== undefined && v.language !== null && !['en', 'hr', 'es', 'sr'].includes(v.language)) return true;
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

    function arrivals(record) {
        let time = 0;
        return record.route.map((point, i) => {
            if (i) time += record.route[i - 1].holdSeconds + point.travelSeconds;
            return time;
        });
    }

    function duration(record) {
        const times = arrivals(record);
        return times.length ? times[times.length - 1] + record.route[record.route.length - 1].holdSeconds : 0;
    }

    function validate(record, { draft = false } = {}) {
        if (!keys(record, ['schema', 'title', 'designCids', 'view', 'frame', 'fov', 'route', 'looks', 'interiors', 'cues'])
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
        for (const name of ['route', 'looks', 'interiors', 'cues']) {
            const entries = record[name];
            if (!Array.isArray(entries) || entries.length > LIMITS[name]
                || Array.from(entries).some(entry => !object(entry) || !id(entry.id))
                || new Set(entries.map(entry => entry.id)).size !== entries.length) return `Invalid flight ${name}.`;
        }
        if (!record.route.length || record.route.some((point, i) => !keys(point, ['id', 'position', 'travelSeconds', 'holdSeconds'])
            || !vector(point.position, 3) || point.position.some(x => Math.abs(x) > 1e7)
            || Math.hypot(point.position[0], point.position[1]) > LIMITS.radiusM
            || !finite(point.travelSeconds) || (i === 0 ? point.travelSeconds !== 0 : point.travelSeconds <= 0)
            || !finite(point.holdSeconds) || point.holdSeconds < 0)) return 'Invalid flight route or timing.';
        const seconds = duration(record);
        if (!finite(seconds) || seconds > LIMITS.seconds || (!draft && seconds <= 0)) return 'A flight must last up to 600 seconds.';
        if ((!draft && !record.looks.length) || record.looks.some((look, i) => !keys(look, ['id', 'time', 'quaternion'])
            || !finite(look.time) || look.time < 0 || look.time > seconds || (i > 0 && record.looks[i - 1].time >= look.time)
            || !vector(look.quaternion, 4) || Math.abs(length(look.quaternion) - 1) > 1e-5)) return 'Invalid flight look keys.';
        if (record.cues.some((cue, i) => !keys(cue, ['id', 'time', 'settings']) || !finite(cue.time)
            || cue.time < 0 || cue.time > seconds || (i > 0 && record.cues[i - 1].time >= cue.time)
            || settingsError(cue.settings, CUE_SETTINGS) || !Object.keys(cue.settings).length)) return 'Invalid flight view cues.';
        if (record.interiors.some(interiorError)) return 'Invalid flight interior snapshot.';
        return null;
    }

    function create({ title = 'Camera flight', designCids = [], view, frame, pose }) {
        if (!object(pose) || !vector(pose.position, 3) || !vector(pose.quaternion, 4)
            || length(pose.quaternion) < 1e-10) throw new Error('Invalid initial camera pose.');
        const record = { schema: SCHEMA, title: title.trim(), designCids: [...new Set(designCids)].sort(),
            view: clone(view), frame: clone(frame), fov: pose.fov === undefined ? 45 : pose.fov,
            route: [{ id: 'route-1', position: pose.position.slice(), travelSeconds: 0, holdSeconds: 0 }],
            looks: [{ id: 'look-1', time: 0, quaternion: normalized(pose.quaternion) }], interiors: [], cues: [] };
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
        return fraction => {
            if (total < 1e-9 || fraction <= 0) return curve(0);
            if (fraction >= 1) return curve(1);
            const target = fraction * total;
            let lo = 0, hi = count;
            while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid] < target) lo = mid; else hi = mid; }
            const step = samples[hi] - samples[lo];
            const point = curve((lo + (step ? (target - samples[lo]) / step : 0)) / count);
            if (Math.hypot(point[0], point[1]) > LIMITS.radiusM) throw new Error('Flight curve leaves the 60 km metric frame domain.');
            return point;
        };
    }

    function compile(input) {
        const error = validate(input, { draft: true });
        if (error) throw new Error(error);
        const record = clone(input), times = arrivals(record), seconds = duration(record);
        const positions = record.route.map(point => point.position);
        const segments = positions.map((_, i) => i ? distanceSampler(segmentCurve(positions, i)) : null);
        function evaluate(time) {
            if (!finite(time)) throw new Error('Invalid flight playhead.');
            time = clamp(time, 0, seconds);
            let position = positions[positions.length - 1].slice();
            for (let i = 0; i < positions.length; i++) {
                const depart = times[i] + record.route[i].holdSeconds;
                if (time <= depart) { position = positions[i].slice(); break; }
                if (i + 1 < positions.length && time < times[i + 1]) {
                    position = segments[i + 1]((time - depart) / record.route[i + 1].travelSeconds); break;
                }
            }
            let quaternion = record.looks.length ? record.looks[record.looks.length - 1].quaternion.slice() : [0, 0, 0, 1];
            for (let i = 0; i < record.looks.length; i++) {
                if (time <= record.looks[i].time) {
                    quaternion = i ? slerp(record.looks[i - 1].quaternion, record.looks[i].quaternion,
                        (time - record.looks[i - 1].time) / (record.looks[i].time - record.looks[i - 1].time))
                        : record.looks[0].quaternion.slice(); break;
                }
            }
            const settings = { ...record.view.settings };
            for (const cue of record.cues) { if (cue.time > time) break; Object.assign(settings, cue.settings); }
            return { position, quaternion, fov: record.fov, settings };
        }
        return Object.freeze({ duration: seconds, evaluate });
    }
    return Object.freeze({ SCHEMA, LIMITS, validate, create, duration, arrivals, compile, slerp });
});
