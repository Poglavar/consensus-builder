// Pedestrian crossings of non-pedestrian corridors can stay at grade, pass underneath, or bridge
// over them. This module owns detection and the persistent `gradeSeparations` record; road-drawing
// owns when records are committed, corridor-render/three-mode own their views.
(function attachCorridorGradeSeparation(global) {
    'use strict';

    const CROSSING_EPS = 1e-8;

    function pointOf(value) {
        if (!value) return null;
        const lat = Number(value.lat !== undefined ? value.lat : value[1]);
        const lng = Number(value.lng !== undefined ? value.lng : value[0]);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }

    function clone(value) {
        return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
    }

    function pedestrianOnlyProfile(profile) {
        const normalized = typeof global.normalizeCorridorProfile === 'function'
            ? global.normalizeCorridorProfile(profile)
            : profile;
        const strips = Array.isArray(normalized?.strips) ? normalized.strips : [];
        return strips.length > 0 && strips.every(strip => strip?.type === 'sidewalk');
    }

    function crossingDetail(a0, a1, b0, b1) {
        const a = pointOf(a0), a2 = pointOf(a1), b = pointOf(b0), b2 = pointOf(b1);
        if (!a || !a2 || !b || !b2) return null;
        const adx = a2.lng - a.lng;
        const ady = a2.lat - a.lat;
        const bdx = b2.lng - b.lng;
        const bdy = b2.lat - b.lat;
        const denominator = adx * bdy - ady * bdx;
        if (Math.abs(denominator) < 1e-18) return null;
        const t = ((b.lng - a.lng) * bdy - (b.lat - a.lat) * bdx) / denominator;
        const u = ((b.lng - a.lng) * ady - (b.lat - a.lat) * adx) / denominator;
        if (t <= CROSSING_EPS || t >= 1 - CROSSING_EPS || u < -CROSSING_EPS || u > 1 + CROSSING_EPS) return null;
        return { t, u, point: { lat: a.lat + t * ady, lng: a.lng + t * adx } };
    }

    function proposalKey(proposal) {
        try {
            const key = typeof global.getProposalKey === 'function' ? global.getProposalKey(proposal) : null;
            if (key !== undefined && key !== null) return String(key);
        } catch (_) { }
        const key = proposal?.proposalId ?? proposal?.id ?? proposal?.hash;
        return key === undefined || key === null ? '' : String(key);
    }

    function proposalTitle(proposal, key) {
        try {
            const label = global.getProposalDisplayTitle?.(proposal);
            if (label) return String(label);
        } catch (_) { }
        return proposal?.title || proposal?.name || proposal?.proposalName || `Road ${key}`;
    }

    function detectPedestrianRoadCrossings(from, to, drawingProfile, proposals) {
        if (!pedestrianOnlyProfile(drawingProfile)) return [];
        const source = Array.isArray(proposals)
            ? proposals
            : (global.proposalStorage?.getAllProposals?.() || []);
        const hits = [];
        const seen = new Set();
        source.forEach(proposal => {
            const sub = proposal?.roadProposal;
            const definition = sub?.definition;
            if (!definition) return;
            try {
                if (typeof global.isApplied === 'function' && !global.isApplied(proposal, sub)) return;
            } catch (_) { return; }
            const key = proposalKey(proposal);
            const fallbackProfile = global.corridorProfileOf?.(definition) || definition.profile || null;
            const entries = typeof global.corridorSegmentEntries === 'function'
                ? global.corridorSegmentEntries(definition)
                : (global.corridorCenterlineOf?.(definition) || []).map(points => ({
                    points,
                    profile: fallbackProfile,
                    width: Number(definition.width) || 10
                }));
            entries.forEach((entry, segmentIndex) => {
                const profile = entry.profile || fallbackProfile;
                if (pedestrianOnlyProfile(profile)) return;
                const points = Array.isArray(entry.points) ? entry.points : [];
                for (let edgeIndex = 0; edgeIndex < points.length - 1; edgeIndex += 1) {
                    const crossing = crossingDetail(from, to, points[edgeIndex], points[edgeIndex + 1]);
                    if (!crossing) continue;
                    const id = `${key}:${crossing.point.lat.toFixed(7)},${crossing.point.lng.toFixed(7)}`;
                    if (seen.has(id)) continue;
                    seen.add(id);
                    hits.push({
                        ...crossing,
                        proposalId: key,
                        title: proposalTitle(proposal, key),
                        segmentIndex,
                        edgeIndex,
                        width: Number(entry.width) || Number(definition.width) || 10
                    });
                }
            });
        });
        return hits.sort((a, b) => a.t - b.t);
    }

    function distanceMeters(a0, b0) {
        const a = pointOf(a0), b = pointOf(b0);
        if (!a || !b) return 0;
        const rad = degrees => degrees * Math.PI / 180;
        const dLat = rad(b.lat - a.lat);
        const dLng = rad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2
            + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function interpolate(a0, b0, t) {
        const a = pointOf(a0), b = pointOf(b0);
        return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }

    function buildGradeSeparationRecords(hits, mode, from, to, width) {
        if (mode !== 'underpass' && mode !== 'overpass') return [];
        const length = distanceMeters(from, to);
        if (!(length > 0.5)) return [];
        return (hits || []).map(hit => {
            // A compact game-scale ramp: long enough to read clearly in 3D, bounded so a crossing
            // near the end of a drawn edge never extends beyond that edge.
            const desiredHalfSpan = Math.max(10, Number(hit.width) / 2 + (mode === 'overpass' ? 10 : 7));
            const availableBefore = hit.t * length * 0.9;
            const availableAfter = (1 - hit.t) * length * 0.9;
            const halfSpan = Math.max(1, Math.min(desiredHalfSpan, availableBefore, availableAfter));
            const dt = halfSpan / length;
            const startT = Math.max(0, hit.t - dt);
            const endT = Math.min(1, hit.t + dt);
            const start = interpolate(from, to, startT);
            const end = interpolate(from, to, endT);
            return {
                id: `road-grade:${mode}:${hit.proposalId}:${hit.point.lat.toFixed(7)},${hit.point.lng.toFixed(7)}`,
                kind: 'road-grade-separation',
                mode,
                from: start,
                to: end,
                crossing: clone(hit.point),
                sourceEdge: { from: pointOf(from), to: pointOf(to) },
                sourceT: hit.t,
                startT,
                endT,
                elevation: mode === 'overpass' ? 5.2 : -3.2,
                width: Number(width) || 2,
                crossedWidth: Number(hit.width) || 10,
                otherProposalId: hit.proposalId,
                otherTitle: hit.title,
                edgeKeys: []
            };
        });
    }

    function gradeText(key, fallback, params = {}) {
        let output = fallback;
        try {
            const translated = global.i18n?.t?.(key, params);
            if (translated && translated !== key) output = translated;
        } catch (_) { }
        Object.entries(params).forEach(([name, value]) => {
            output = String(output).replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}|\\{${name}\\}`, 'g'), String(value));
        });
        return output;
    }

    function buildPedestrianCrossingPrompt(hits) {
        const names = [...new Set((hits || []).map(hit => hit.title).filter(Boolean))];
        const list = names.map(name => `• ${name}`).join('\n');
        const message = `${gradeText(
            'modal.corridorGrade.offer',
            'This pedestrian route crosses {{count}} non-pedestrian road(s). How should it cross?',
            { count: hits.length }
        )}${list ? `\n\n${list}` : ''}`;
        return {
            message,
            choices: [
                { value: 'at-grade', label: gradeText('modal.corridorGrade.atGrade', 'At-grade crossing'), primary: true },
                { value: 'underpass', label: gradeText('modal.corridorGrade.underpass', 'Underpass') },
                { value: 'overpass', label: gradeText('modal.corridorGrade.overpass', 'Overpass') },
                { value: 'cancel', label: gradeText('modal.corridorGrade.cancel', 'Choose another route') }
            ]
        };
    }

    async function resolvePedestrianRoadCrossings(from, to, drawingProfile, width, proposals) {
        const hits = detectPedestrianRoadCrossings(from, to, drawingProfile, proposals);
        if (!hits.length) return { action: 'none', hits: [], records: [] };
        const prompt = buildPedestrianCrossingPrompt(hits);
        let answer = 'at-grade';
        if (typeof global.showStyledChoice === 'function') {
            answer = (await global.showStyledChoice(prompt.message, prompt.choices)) || 'cancel';
        } else if (typeof global.confirm === 'function') {
            answer = global.confirm(prompt.message) ? 'at-grade' : 'cancel';
        }
        if (answer === 'cancel') return { action: 'cancel', hits, records: [] };
        return {
            action: answer,
            hits,
            records: buildGradeSeparationRecords(hits, answer, from, to, width)
        };
    }

    function near(a0, b0) {
        const a = pointOf(a0), b = pointOf(b0);
        return !!a && !!b && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;
    }

    function refreshGradeSeparationEdgeKeys(record, points) {
        if (!record || !Array.isArray(points) || points.length < 2) return record;
        const start = points.findIndex(point => near(point, record.from));
        const end = points.findIndex((point, index) => index > start && near(point, record.to));
        if (start < 0 || end <= start) {
            record.edgeKeys = [];
            return record;
        }
        record.edgeKeys = [];
        for (let index = start; index < end; index += 1) {
            const key = global.corridorTunnelEdgeKey?.(points[index], points[index + 1]);
            if (key) record.edgeKeys.push(key);
        }
        return record;
    }

    function gradeSeparationEdgeKeys(records) {
        const keys = [];
        (records || []).forEach(record => {
            if (record?.edgeKey) keys.push(record.edgeKey);
            (record?.edgeKeys || []).forEach(key => { if (key) keys.push(key); });
        });
        return [...new Set(keys)];
    }

    function gradeSeparationSpanRecords(records) {
        return gradeSeparationEdgeKeys(records).map(edgeKey => ({ edgeKey }));
    }

    function retainLiveGradeSeparations(segments, records) {
        const live = new Set();
        (segments || []).forEach(segment => {
            if (!Array.isArray(segment)) return;
            for (let index = 0; index < segment.length - 1; index += 1) {
                const key = global.corridorTunnelEdgeKey?.(segment[index], segment[index + 1]);
                if (key) live.add(key);
            }
        });
        return (records || []).filter(record => {
            const keys = gradeSeparationEdgeKeys([record]);
            return keys.length > 0 && keys.every(key => live.has(key));
        });
    }

    const api = {
        pedestrianOnlyProfile,
        crossingDetail,
        detectPedestrianRoadCrossings,
        buildGradeSeparationRecords,
        buildPedestrianCrossingPrompt,
        resolvePedestrianRoadCrossings,
        refreshGradeSeparationEdgeKeys,
        gradeSeparationEdgeKeys,
        gradeSeparationSpanRecords,
        retainLiveGradeSeparations
    };
    Object.assign(global, api);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
