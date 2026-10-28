// Pure transactional flight authoring with bounded undo history. Route points own their
// orientation, holds and turns; mid-segment looks and view cues stay anchored to route points.
(function (root, factory) {
    const api = factory(typeof module === 'object' && module.exports ? require('./camera-flight.js') : root.CameraFlight);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlightEdit = api;
})(typeof window !== 'undefined' ? window : null, function (Flight) {
    'use strict';
    const HISTORY_LIMIT = 100, DEFAULT_TURN_HOLD = 6;
    const clone = value => JSON.parse(JSON.stringify(value));
    const finite = value => typeof value === 'number' && Number.isFinite(value);

    function quaternion(value) {
        if (!Array.isArray(value) || value.length !== 4 || !Array.from(value).every(finite)) throw new Error('Invalid look quaternion.');
        const magnitude = Math.hypot(...value);
        if (!finite(magnitude) || magnitude < 1e-10) throw new Error('Invalid look quaternion.');
        return value.map(x => x / magnitude);
    }

    function validate(record) {
        const error = Flight.validate(record, { draft: true });
        if (error) throw new Error(error);
    }

    // The first point never travels; looks cannot follow the last point, and a hold of zero has no turn.
    function normalizeRoute(record) {
        const last = record.route[record.route.length - 1];
        record.route.forEach((point, index) => {
            if (!index) point.travelSeconds = null;
            if (!point.holdSeconds) point.turn = null;
        });
        record.looks = record.looks.filter(look => look.after !== last.id);
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
            setSpeed(speedMps) {
                if (!finite(speedMps)) throw new Error('Invalid flight cruise speed.');
                return transact(record => { record.speedMps = speedMps; });
            },
            addView(pose, { holdSeconds = 0 } = {}) {
                if (!pose || !Array.isArray(pose.position)) throw new Error('Invalid camera position.');
                const q = quaternion(pose.quaternion);
                return transact(record => {
                    record.route.push({ id: nextId('route'), position: pose.position.slice(), quaternion: q, travelSeconds: null, holdSeconds, turn: null });
                    normalizeRoute(record);
                });
            },
            updatePoint(id, patch) {
                if (!patch || typeof patch !== 'object' || Array.isArray(patch)
                    || Object.keys(patch).some(key => !['position', 'quaternion', 'travelSeconds', 'holdSeconds', 'turn'].includes(key))) throw new Error('Invalid route point edit.');
                const next = { ...patch };
                if (next.quaternion !== undefined) next.quaternion = quaternion(next.quaternion);
                return transact(record => {
                    const point = record.route[requirePoint(record, id)];
                    Object.assign(point, next);
                    // A turn added to a view without a hold gets a default hold; a hold set to zero drops the turn.
                    if (next.turn && !('holdSeconds' in next) && !point.holdSeconds) point.holdSeconds = DEFAULT_TURN_HOLD;
                    normalizeRoute(record);
                });
            },
            removePoint(id) {
                return transact(record => {
                    const index = requirePoint(record, id);
                    if (record.route.length <= 1) throw new Error('Keep at least one flight route point.');
                    record.route.splice(index, 1);
                    record.looks = record.looks.filter(look => look.after !== id);
                    record.cues = record.cues.filter(cue => cue.at !== id);
                    normalizeRoute(record);
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
            // A look part-way along the segment that departs `after`; the same anchor replaces its key.
            setLook(after, fraction, value) {
                const q = quaternion(value);
                if (!finite(fraction) || fraction <= 0 || fraction >= 1) throw new Error('A look needs a position strictly between two views.');
                return transact(record => {
                    const index = requirePoint(record, after);
                    if (index === record.route.length - 1) throw new Error('A look needs a following view.');
                    const existing = record.looks.find(look => look.after === after && look.fraction === fraction);
                    const entry = { id: existing ? existing.id : nextId('look'), after, fraction, quaternion: q };
                    record.looks = record.looks.filter(look => look !== existing).concat(entry);
                });
            },
            removeLook(id) {
                return transact(record => {
                    const index = record.looks.findIndex(look => look.id === id);
                    if (index < 0) throw new Error('Flight look key not found.');
                    record.looks.splice(index, 1);
                });
            },
            setCue(at, settings) {
                return transact(record => {
                    requirePoint(record, at);
                    const existing = record.cues.find(cue => cue.at === at);
                    const entry = { id: existing ? existing.id : nextId('cue'), at, settings: clone(settings) };
                    record.cues = record.cues.filter(cue => cue !== existing).concat(entry);
                });
            },
            removeCue(id) {
                return transact(record => {
                    const index = record.cues.findIndex(cue => cue.id === id);
                    if (index < 0) throw new Error('Flight view cue not found.');
                    record.cues.splice(index, 1);
                });
            }
        });
    }
    return Object.freeze({ HISTORY_LIMIT, DEFAULT_TURN_HOLD, create });
});
