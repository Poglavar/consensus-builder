// Pure transactional flight authoring with bounded undo history and independent look timelines.
(function (root, factory) {
    const api = factory(typeof module === 'object' && module.exports ? require('./camera-flight.js') : root.CameraFlight);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlightEdit = api;
})(typeof window !== 'undefined' ? window : null, function (Flight) {
    'use strict';
    const HISTORY_LIMIT = 100;
    const clone = value => JSON.parse(JSON.stringify(value));
    const finite = value => typeof value === 'number' && Number.isFinite(value);

    function quaternion(value) {
        if (!Array.isArray(value) || value.length !== 4 || !Array.from(value).every(finite)) throw new Error('Invalid look quaternion.');
        const magnitude = Math.hypot(...value);
        if (!finite(magnitude) || magnitude < 1e-10) throw new Error('Invalid look quaternion.');
        return value.map(x => x / magnitude);
    }

    function multiply(a, b) {
        const [x, y, z, w] = a, [bx, by, bz, bw] = b;
        return quaternion([w * bx + x * bw + y * bz - z * by, w * by - x * bz + y * bw + z * bx,
            w * bz + x * by - y * bx + z * bw, w * bw - x * bx - y * by - z * bz]);
    }

    function validate(record) {
        const error = Flight.validate(record, { draft: true });
        if (error) throw new Error(error);
    }

    function cropTimelines(record) {
        const end = Flight.duration(record);
        if (!finite(end) || end < 0) throw new Error('Invalid flight route timing.');
        for (const field of ['looks', 'cues']) {
            const byTime = new Map();
            for (const key of record[field]) {
                key.time = Math.min(key.time, end);
                byTime.set(key.time, key);
            }
            record[field] = [...byTime.values()].sort((a, b) => a.time - b.time);
        }
    }

    function normalizeRoute(record) {
        record.route.forEach((point, index) => {
            if (!index) point.travelSeconds = 0;
            else if (point.travelSeconds === 0) point.travelSeconds = 5;
        });
        cropTimelines(record);
    }

    function create(input) {
        validate(input);
        let current = clone(input), past = [], future = [], serial = 0;
        const snapshot = () => clone(current);
        const nextId = prefix => {
            let candidate;
            do { candidate = `${prefix}-${++serial}`; }
            while (['route', 'looks', 'cues', 'interiors'].some(field => current[field].some(item => item.id === candidate)));
            return candidate;
        };
        function commit(candidate) {
            validate(candidate);
            if (JSON.stringify(candidate) !== JSON.stringify(current)) {
                past.push(current);
                if (past.length > HISTORY_LIMIT) past.shift();
                current = clone(candidate); future = [];
            }
            return snapshot();
        }
        function transact(fn) {
            if (typeof fn !== 'function') throw new Error('A flight transaction needs an edit function.');
            const draft = snapshot(); fn(draft); return commit(draft);
        }
        function requirePoint(record, id) {
            const index = record.route.findIndex(point => point.id === id);
            if (index < 0) throw new Error('Flight route point not found.');
            return index;
        }
        function setKey(record, field, time, values) {
            const existing = record[field].find(key => key.time === time);
            const entry = { id: existing ? existing.id : nextId(field === 'looks' ? 'look' : 'cue'), time, ...values };
            record[field] = record[field].filter(key => key.time !== time).concat(entry).sort((a, b) => a.time - b.time);
        }
        return Object.freeze({
            get record() { return snapshot(); },
            get canUndo() { return past.length > 0; },
            get canRedo() { return future.length > 0; },
            snapshot,
            transact,
            replace(record) { validate(record); return commit(record); },
            undo() {
                if (past.length) { future.push(current); current = past.pop(); }
                return snapshot();
            },
            redo() {
                if (future.length) { past.push(current); current = future.pop(); }
                return snapshot();
            },
            rename(title) {
                if (typeof title !== 'string') throw new Error('Invalid flight name.');
                return transact(record => { record.title = title.trim(); });
            },
            addView(pose, { travelSeconds = 5, holdSeconds = 0 } = {}) {
                if (!pose || !Array.isArray(pose.position)) throw new Error('Invalid camera position.');
                const q = quaternion(pose.quaternion);
                return transact(record => {
                    record.route.push({ id: nextId('route'), position: pose.position.slice(), travelSeconds, holdSeconds });
                    const times = Flight.arrivals(record);
                    setKey(record, 'looks', times[times.length - 1], { quaternion: q });
                });
            },
            updatePoint(id, patch) {
                if (!patch || typeof patch !== 'object' || Array.isArray(patch)
                    || Object.keys(patch).some(key => !['position', 'travelSeconds', 'holdSeconds'].includes(key))) throw new Error('Invalid route point edit.');
                return transact(record => {
                    Object.assign(record.route[requirePoint(record, id)], patch);
                    cropTimelines(record);
                });
            },
            removePoint(id) {
                return transact(record => {
                    const index = requirePoint(record, id);
                    if (record.route.length <= 1) throw new Error('Keep at least one flight route point.');
                    record.route.splice(index, 1); normalizeRoute(record);
                });
            },
            movePoint(id, deltaIndex) {
                if (!Number.isInteger(deltaIndex)) throw new Error('Invalid route point move.');
                return transact(record => {
                    const index = requirePoint(record, id), target = Math.max(0, Math.min(record.route.length - 1, index + deltaIndex));
                    if (index === target) return;
                    const [point] = record.route.splice(index, 1); record.route.splice(target, 0, point);
                    normalizeRoute(record);
                });
            },
            setLook(time, value) {
                const q = quaternion(value);
                return transact(record => setKey(record, 'looks', time, { quaternion: q }));
            },
            removeLook(id) {
                return transact(record => {
                    const index = record.looks.findIndex(look => look.id === id);
                    if (index < 0) throw new Error('Flight look key not found.');
                    if (record.looks.length <= 1) throw new Error('Keep at least one flight look key.');
                    record.looks.splice(index, 1);
                });
            },
            setCue(time, settings) {
                return transact(record => setKey(record, 'cues', time, { settings }));
            },
            spin(time, seconds, axis = 'yaw', turns = 1) {
                if (!finite(time) || time < 0 || !finite(seconds) || seconds <= 0
                    || time + seconds <= time || time + seconds > Flight.duration(current)
                    || !['yaw', 'pitch', 'roll'].includes(axis) || !finite(turns) || turns === 0 || Math.abs(turns) > 16) {
                    throw new Error('A spin needs a valid axis and a positive interval inside the flight (up to 16 turns).');
                }
                const base = Flight.compile(current).evaluate(time).quaternion;
                return transact(record => {
                    const end = time + seconds, original = record.looks;
                    record.looks = original.filter(look => look.time < time || look.time > end);
                    const count = Math.max(8, Math.ceil(Math.abs(turns) * 8));
                    for (let i = 0; i <= count; i++) {
                        const keyTime = i === count ? end : time + seconds * i / count;
                        const halfAngle = Math.PI * turns * i / count, rotation = [0, 0, 0, Math.cos(halfAngle)];
                        rotation[axis === 'pitch' ? 0 : 2] = Math.sin(halfAngle) * (axis === 'roll' ? -1 : 1);
                        const q = axis === 'yaw' ? multiply(rotation, base) : multiply(base, rotation);
                        const old = original.find(look => look.time === keyTime);
                        record.looks.push({ id: old ? old.id : nextId('look'), time: keyTime, quaternion: q });
                    }
                    record.looks.sort((a, b) => a.time - b.time);
                });
            }
        });
    }
    return Object.freeze({ HISTORY_LIMIT, create });
});
