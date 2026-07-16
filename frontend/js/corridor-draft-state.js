// Canonical, dependency-free state and compiler for corridor drawings. The interactive editor may
// keep Leaflet objects while the pen is down, but persistence and proposal creation cross this
// boundary as plain data with aligned segments/ids and one deterministic definition shape.
(function attachCorridorDraftState(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CorridorDraftState = api;
})(typeof window !== 'undefined' ? window : globalThis, function corridorDraftStateFactory() {
    'use strict';

    const SCHEMA_VERSION = 1;

    class CorridorDraftValidationError extends Error {
        constructor(errors) {
            super(`Invalid corridor draft: ${errors.map(error => error.message).join('; ')}`);
            this.name = 'CorridorDraftValidationError';
            this.errors = errors;
        }
    }

    function clone(value) {
        if (value === undefined || value === null) return value;
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) { /* JSON fallback */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function normalizeKind(value) {
        return String(value || '').toLowerCase() === 'track' ? 'track' : 'road';
    }

    function normalizePoint(point) {
        if (!point) return null;
        const lat = Number(Array.isArray(point) ? point[1] : point.lat);
        const lng = Number(Array.isArray(point) ? point[0] : point.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat, lng };
    }

    function normalizeSegments(value) {
        if (!Array.isArray(value) || value.length === 0) return [];
        const rawSegments = normalizePoint(value[0]) ? [value] : value;
        return rawSegments
            .filter(Array.isArray)
            .map(segment => segment.map(normalizePoint).filter(Boolean));
    }

    function alignSegmentIds(rawIds, segmentCount) {
        const ids = Array.isArray(rawIds) ? rawIds : [];
        const used = new Set();
        return Array.from({ length: segmentCount }, (_, index) => {
            const requested = ids[index] === undefined || ids[index] === null
                ? ''
                : String(ids[index]).trim();
            const base = requested || `s${index + 1}`;
            let candidate = base;
            let suffix = 2;
            while (used.has(candidate)) candidate = `${base}-${suffix++}`;
            used.add(candidate);
            return candidate;
        });
    }

    function profileWidth(profile) {
        const strips = Array.isArray(profile) ? profile : profile && profile.strips;
        if (!Array.isArray(strips)) return 0;
        return strips.reduce((sum, strip) => {
            const width = Number(strip && strip.width);
            return Number.isFinite(width) && width > 0 ? sum + width : sum;
        }, 0);
    }

    function finiteNumberOrNull(value) {
        if (value === undefined || value === null || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function createCorridorDraftState(seed = {}) {
        const segments = normalizeSegments(seed.segments || seed.centerline || seed.points || []);
        const segmentIds = alignSegmentIds(seed.segmentIds, segments.length);
        const activeIndexCandidate = Number(seed.activeIndex);
        const hasStarted = seed.hasStarted === true
            && Number.isInteger(activeIndexCandidate)
            && activeIndexCandidate >= 0
            && activeIndexCandidate < segments.length;
        const profile = clone(seed.profile || null);
        const derivedWidth = profileWidth(profile);
        const explicitWidth = finiteNumberOrNull(seed.width);
        const sidewalkWidth = finiteNumberOrNull(seed.sidewalkWidth);
        const trackSpeed = finiteNumberOrNull(seed.trackSpeed ?? seed.metadata?.trackSpeed);
        const trackMinRadius = finiteNumberOrNull(seed.trackMinRadius ?? seed.metadata?.trackMinRadius);

        return {
            schemaVersion: SCHEMA_VERSION,
            kind: normalizeKind(seed.kind || seed.metadata?.type),
            segments,
            segmentIds,
            activeIndex: hasStarted ? activeIndexCandidate : -1,
            hasStarted,
            strokeBaseCount: hasStarted ? Math.max(0, Number(seed.strokeBaseCount) || 0) : 0,
            profile,
            width: derivedWidth > 0 ? derivedWidth : explicitWidth,
            sidewalkWidth,
            segmentProfiles: clone(seed.segmentProfiles || {}),
            tunnels: clone(seed.tunnels || []),
            demolishedBuildings: clone(seed.demolishedBuildings || []),
            polygon: clone(seed.polygon || null),
            surfaceFootprint: clone(seed.surfaceFootprint || null),
            latLngPairs: clone(seed.latLngPairs || null),
            trackSpeed,
            trackMinRadius,
            metadata: clone(seed.metadata || {}),
            revision: Math.max(0, Number(seed.revision) || 0),
            dirty: seed.dirty !== false
        };
    }

    function validateCorridorDraftState(input, options = {}) {
        const state = input && input.schemaVersion === SCHEMA_VERSION ? input : createCorridorDraftState(input);
        const errors = [];
        const add = (code, message) => errors.push({ code, message });

        if (!Array.isArray(state.segments) || !Array.isArray(state.segmentIds)) {
            add('segments-invalid', 'segments and segmentIds must be arrays');
        } else {
            if (state.segments.length !== state.segmentIds.length) {
                add('segment-id-misalignment', 'every segment must have exactly one segment id');
            }
            if (new Set(state.segmentIds.map(String)).size !== state.segmentIds.length) {
                add('segment-id-duplicate', 'segment ids must be unique');
            }
            state.segments.forEach((segment, index) => {
                if (!Array.isArray(segment) || segment.some(point => !normalizePoint(point))) {
                    add('segment-point-invalid', `segment ${index + 1} contains an invalid point`);
                }
            });
        }

        if (state.hasStarted && (state.activeIndex < 0 || state.activeIndex >= state.segments.length)) {
            add('active-index-invalid', 'an active stroke must reference an existing segment');
        }
        if (!state.hasStarted && state.activeIndex !== -1) {
            add('inactive-index-invalid', 'an inactive stroke cannot reference a segment');
        }
        if (state.width !== null && (!Number.isFinite(Number(state.width)) || Number(state.width) <= 0)) {
            add('width-invalid', 'corridor width must be positive');
        }
        if (options.requireDrawable === true && state.width === null) {
            add('width-required', 'a finishable corridor must have a positive width');
        }
        if (options.requireDrawable === true && !state.segments.some(segment => segment.length >= 2)) {
            add('centerline-empty', 'at least one two-point segment is required');
        }

        return { ok: errors.length === 0, errors, state };
    }

    function assertCorridorDraftState(input, options = {}) {
        const validation = validateCorridorDraftState(input, options);
        if (!validation.ok) throw new CorridorDraftValidationError(validation.errors);
        return validation.state;
    }

    function reduceCorridorDraft(input, action) {
        const state = createCorridorDraftState(input);
        const next = clone(state);
        const type = String(action && action.type || '').toUpperCase();
        let changed = false;

        if (type === 'ADD_SEGMENT') {
            const points = normalizeSegments(action.points || [])[0] || [];
            const alignedIds = alignSegmentIds([...next.segmentIds, action.segmentId], next.segments.length + 1);
            const id = alignedIds[alignedIds.length - 1];
            next.segments.push(points);
            next.segmentIds.push(id);
            if (action.activate !== false) {
                next.activeIndex = next.segments.length - 1;
                next.hasStarted = true;
                next.strokeBaseCount = Math.max(0, Number(action.strokeBaseCount) || 0);
            }
            changed = true;
        } else if (type === 'APPEND_POINT') {
            const point = normalizePoint(action.point);
            const index = Number.isInteger(action.segmentIndex) ? action.segmentIndex : next.activeIndex;
            if (point && index >= 0 && index < next.segments.length) {
                next.segments[index].push(point);
                next.activeIndex = index;
                next.hasStarted = true;
                changed = true;
            }
        } else if (type === 'END_STROKE') {
            next.activeIndex = -1;
            next.hasStarted = false;
            next.strokeBaseCount = 0;
            changed = true;
        } else if (type === 'SET_PROFILE') {
            next.profile = clone(action.profile || null);
            const width = profileWidth(next.profile);
            if (width > 0) next.width = width;
            changed = true;
        } else if (type === 'SET_OBSTACLES') {
            next.tunnels = clone(action.tunnels || []);
            next.demolishedBuildings = clone(action.demolishedBuildings || []);
            changed = true;
        } else if (type === 'UNDO' || type === 'CANCEL_STROKE') {
            const activeIndex = next.hasStarted ? next.activeIndex : next.segments.length - 1;
            const segment = activeIndex >= 0 ? next.segments[activeIndex] : null;
            if (Array.isArray(segment)) {
                const stopAt = type === 'UNDO'
                    ? Math.max(1, segment.length - 1)
                    : Math.max(0, next.strokeBaseCount);
                if (segment.length > stopAt) {
                    segment.splice(stopAt);
                    changed = true;
                }
                if (type === 'CANCEL_STROKE' && segment.length < 2) {
                    const removedId = next.segmentIds[activeIndex];
                    next.segments.splice(activeIndex, 1);
                    next.segmentIds.splice(activeIndex, 1);
                    if (removedId) delete next.segmentProfiles[String(removedId)];
                    changed = true;
                }
            }
            if (type === 'CANCEL_STROKE') {
                const wasActive = next.hasStarted || next.activeIndex !== -1 || next.strokeBaseCount !== 0;
                next.activeIndex = -1;
                next.hasStarted = false;
                next.strokeBaseCount = 0;
                changed = changed || wasActive;
            } else if (changed && activeIndex >= 0 && activeIndex < next.segments.length) {
                next.activeIndex = activeIndex;
                next.hasStarted = true;
            }
        }

        if (changed) {
            next.revision = state.revision + 1;
            next.dirty = true;
        }
        return assertCorridorDraftState(next);
    }

    function compileCorridorDefinition(input, options = {}) {
        const state = assertCorridorDraftState(input, { requireDrawable: options.requireDrawable === true });
        const entries = state.segments
            .map((segment, index) => ({
                points: segment.map(normalizePoint).filter(Boolean),
                id: state.segmentIds[index]
            }))
            .filter(entry => entry.points.length >= 2);
        if (options.requireDrawable === true && entries.length === 0) {
            throw new CorridorDraftValidationError([{ code: 'centerline-empty', message: 'at least one two-point segment is required' }]);
        }

        const segmentIds = entries.map(entry => entry.id);
        const segmentProfiles = {};
        segmentIds.forEach(id => {
            if (state.segmentProfiles && state.segmentProfiles[String(id)]) {
                segmentProfiles[String(id)] = clone(state.segmentProfiles[String(id)]);
            }
        });
        const kind = normalizeKind(options.kind || state.kind);
        const metadata = {
            ...(clone(options.previousDefinition?.metadata || {})),
            ...(clone(state.metadata || {})),
            ...(clone(options.metadata || {})),
            isCorridor: true,
            isTrack: kind === 'track',
            isRoad: kind !== 'track',
            type: kind
        };
        if (kind === 'track') {
            if (state.trackSpeed !== null) metadata.trackSpeed = state.trackSpeed;
            if (state.trackMinRadius !== null) metadata.trackMinRadius = state.trackMinRadius;
        } else {
            delete metadata.trackSpeed;
            delete metadata.trackMinRadius;
        }

        const points = entries.map(entry => clone(entry.points));
        return {
            ...(clone(options.previousDefinition || {})),
            points,
            segments: clone(points),
            segmentIds,
            profile: clone(state.profile),
            width: state.width,
            sidewalkWidth: state.sidewalkWidth,
            tunnels: clone(state.tunnels),
            demolishedBuildings: clone(state.demolishedBuildings),
            segmentProfiles,
            polygon: clone(state.polygon),
            surfaceFootprint: clone(state.surfaceFootprint),
            latLngPairs: clone(state.latLngPairs),
            metadata
        };
    }

    return {
        SCHEMA_VERSION,
        CorridorDraftValidationError,
        createCorridorDraftState,
        validateCorridorDraftState,
        assertCorridorDraftState,
        reduceCorridorDraft,
        compileCorridorDefinition
    };
});
