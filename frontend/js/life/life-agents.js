// Life agents: the schematic population moving in the 3D model view — vehicles following directed
// lane tracks (life-graph.js) with simple car-following, and people wandering the walkable surface
// (life-surface.js). Pure and deterministic (seeded), no DOM, no THREE; true metres and seconds.
// The renderer reads the agents' x/y/z/heading/stride each frame. Behaviour is deliberately minimal:
// stay on the path or the surface, pick a random continuation, never drive into the vehicle ahead.
// See 3d-life.md.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory(
        (typeof __lifeGraph !== 'undefined') ? __lifeGraph : require('./life-graph.js'));
    else root.__lifeAgents = factory(root.__lifeGraph);
})(typeof self !== 'undefined' ? self : this, function (lifeGraph) {
    'use strict';

    const GAP_MIN_M = 2.0;        // bumper-to-bumper standstill gap
    const HEADWAY_S = 0.9;        // time headway kept to the vehicle ahead
    const ACCEL = 2.5;            // m/s²
    const DECEL = 5.0;            // m/s²
    const STRIDE_RAD_PER_M = 5.2; // Station3D's walk cycle: limb phase advance per metre walked
    const MAX_STEP_S = 0.1;       // one step never integrates more than this
    const WANDER_RADIUS_M = 40;   // how far a person looks for the next destination
    const PERSON_PER_M2 = 1 / 250; // crowd density over preferred walking space

    // To-scale schematic vehicle classes (metres). `clearance` is the body's height above the road.
    const VEHICLE_KINDS = {
        car: { len: 4.4, width: 1.8, height: 1.5, clearance: 0.3, wheelRadius: 0.32, weight: 0.86, speedFactor: 1.0 },
        bus: { len: 12.0, width: 2.5, height: 3.2, clearance: 0.4, wheelRadius: 0.5, weight: 0.06, speedFactor: 0.8 },
        moto: { len: 2.1, width: 0.6, height: 0.95, clearance: 0.4, wheelRadius: 0.3, weight: 0.08, speedFactor: 1.1 }
    };
    // No greys and no near-whites: those vanish against the grey buildings and the pale ground.
    const CAR_COLORS = [0x1a1a1a, 0x1a1a1a, 0xc0392b, 0xc0392b, 0x1f5fbf, 0x1f5fbf, 0x2e7d32, 0xf1c40f, 0xe67e22, 0x8e6e53, 0x6c3483, 0x16a085, 0x2c3e50, 0xd35400];
    const BUS_COLORS = [0x1e63c3];
    const MOTO_COLORS = [0x222222, 0xb71c1c, 0x37474f];
    const SKIN_COLORS = [0xf1c9a5, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
    const SHIRT_COLORS = [0x2f4f7f, 0x8b1e3f, 0x3c7a4d, 0xd9d2c5, 0xe8b04a, 0x5b5b5b, 0xffffff, 0x1f1f1f, 0xc0392b, 0x2980b9, 0xf39c12, 0x7f8c8d];
    const LEG_COLORS = [0x2b2b3a, 0x3d3d3d, 0x4a5568, 0x6b4f3a, 0x1b2a49, 0xbfb8a8];

    // Small deterministic PRNG so a scene looks the same on every entry and tests are repeatable.
    function mulberry32(seed) {
        let a = (seed >>> 0) || 1;
        return function () {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const pick = (rng, list) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

    function pickVehicleKind(rng) {
        let r = rng();
        for (const [kind, spec] of Object.entries(VEHICLE_KINDS)) {
            if (r < spec.weight) return kind;
            r -= spec.weight;
        }
        return 'car';
    }

    // Weighted choice of a track by length; null when there is nothing to choose from.
    function pickTrackByLength(rng, tracks, total) {
        if (!tracks.length || total <= 0) return null;
        let r = rng() * total;
        for (const track of tracks) {
            if (r < track.len) return track;
            r -= track.len;
        }
        return tracks[tracks.length - 1];
    }

    function createSimulation(graph, surface, options) {
        const o = options || {};
        const rng = typeof o.rng === 'function' ? o.rng : mulberry32(o.seed != null ? o.seed : 1);
        const maxVehicles = Math.max(0, o.maxVehicles != null ? o.maxVehicles : 100);
        const maxPeople = Math.max(0, o.maxPeople != null ? o.maxPeople : 64);
        const vehicleSpacing = o.vehicleSpacingM || 45;
        const tracks = graph.tracks;
        const nodes = graph.nodes;
        const driveTracks = tracks.filter(t => t.kind === 'drive' && t.len > 1);
        const driveLength = driveTracks.reduce((sum, t) => sum + t.len, 0);
        const sample = { x: 0, y: 0, z: 0, heading: 0, seg: 0 };
        let walk = surface || null;

        const vehicles = [];
        const people = [];
        const queues = tracks.map(() => []);

        // ---- vehicles -------------------------------------------------------------------------
        function chooseNext(track) {
            const node = nodes.get(track.to);
            if (!node) return null;
            const candidates = node.out.filter(id => id !== track.id);
            const ahead = candidates.filter(id => tracks[id].to !== track.from);
            const pool = ahead.length ? ahead : candidates;
            if (!pool.length) return null;
            return pick(rng, pool);
        }

        function joinLength(track, nextId) {
            if (nextId == null) return 0;
            const a = track.pts[track.pts.length - 1];
            const b = tracks[nextId].pts[0];
            return Math.hypot(b[0] - a[0], b[1] - a[1]);
        }

        // Free along the track AND clear of every vehicle in plan, so a spawn next to a node never
        // lands on a vehicle that is just past it on the neighbouring track.
        function spotIsFree(track, s, self) {
            lifeGraph.sampleTrack(track, s, sample, 0);
            for (const v of vehicles) {
                if (v === self) continue;
                if (v.track === track.id && Math.abs(v.s - s) < (v.len + self.len) / 2 + 6) return false;
                if (Math.hypot(v.x - sample.x, v.y - sample.y) < (v.len + self.len) / 2 + 2) return false;
            }
            return true;
        }

        function placeVehicle(v) {
            for (let attempt = 0; attempt < 24; attempt++) {
                const track = pickTrackByLength(rng, driveTracks, driveLength);
                if (!track) return false;
                const s = rng() * track.len;
                if (!spotIsFree(track, s, v)) continue;
                v.track = track.id;
                v.s = s;
                v.v = track.speed * v.speedFactor * 0.6;
                v.next = chooseNext(track);
                v.joinLen = 0;
                v.nextJoinLen = joinLength(track, v.next);
                v.joinFrom = null;
                v.seg = 0;
                return true;
            }
            return false;
        }

        function spawnVehicles() {
            const wanted = Math.min(maxVehicles, Math.round(driveLength / vehicleSpacing));
            let misses = 0;
            for (let i = 0; i < wanted && misses < 3; i++) {
                const kind = pickVehicleKind(rng);
                const spec = VEHICLE_KINDS[kind];
                const v = {
                    id: vehicles.length, kind, len: spec.len, width: spec.width, height: spec.height,
                    clearance: spec.clearance, wheelRadius: spec.wheelRadius,
                    color: pick(rng, kind === 'bus' ? BUS_COLORS : kind === 'moto' ? MOTO_COLORS : CAR_COLORS),
                    speedFactor: spec.speedFactor * (0.85 + 0.3 * rng()),
                    track: -1, s: 0, v: 0, next: null, joinLen: 0, nextJoinLen: 0, joinFrom: null,
                    x: 0, y: 0, z: 0, heading: 0, seg: 0
                };
                if (!placeVehicle(v)) { misses++; continue; }
                vehicles.push(v);
                updateVehiclePose(v);
            }
        }

        function updateVehiclePose(v) {
            const track = tracks[v.track];
            if (v.s < 0 && v.joinFrom && v.joinLen > 0) {
                const t = Math.min(1, Math.max(0, 1 + v.s / v.joinLen));
                const b = track.pts[0];
                v.x = v.joinFrom[0] + (b[0] - v.joinFrom[0]) * t;
                v.y = v.joinFrom[1] + (b[1] - v.joinFrom[1]) * t;
                v.z = v.joinFrom[2] + (b[2] - v.joinFrom[2]) * t;
                v.heading = Math.atan2(b[1] - v.joinFrom[1], b[0] - v.joinFrom[0]);
                return;
            }
            lifeGraph.sampleTrack(track, Math.max(0, v.s), sample, v.seg);
            v.x = sample.x; v.y = sample.y; v.z = sample.z; v.heading = sample.heading; v.seg = sample.seg;
        }

        // Vehicles heading for the same exit track from different approaches: the one further
        // from the node yields to the one nearer (ties by id), so merges never stack.
        const mergeLeaders = new Map();  // next track id → [{ v, remaining }]
        function remainingToExit(v) { return tracks[v.track].len - v.s + v.nextJoinLen; }

        function stepVehicles(dt) {
            for (const q of queues) q.length = 0;
            for (const v of vehicles) queues[v.track].push(v);
            for (const q of queues) if (q.length > 1) q.sort((a, b) => b.s - a.s);
            for (const q of queues) q.forEach((v, index) => { v.qi = index; });
            mergeLeaders.clear();
            for (const v of vehicles) {
                if (v.qi !== 0 || v.next == null) continue;
                if (!mergeLeaders.has(v.next)) mergeLeaders.set(v.next, []);
                mergeLeaders.get(v.next).push({ v, remaining: remainingToExit(v) });
            }

            for (const v of vehicles) {
                const track = tracks[v.track];
                const queue = queues[v.track];
                let gap = Infinity;
                if (v.qi > 0) {
                    const leader = queue[v.qi - 1];
                    // A leader that already crossed the node this step is on the next track, behind its start.
                    gap = leader.track === v.track
                        ? leader.s - v.s - (leader.len + v.len) / 2
                        : (leader.track === v.next ? (track.len - v.s) + v.nextJoinLen + leader.s - (leader.len + v.len) / 2 : Infinity);
                } else if (v.next != null) {
                    const nextQueue = queues[v.next];
                    if (nextQueue.length) {
                        const tail = nextQueue[nextQueue.length - 1];
                        gap = (track.len - v.s) + v.nextJoinLen + tail.s - (tail.len + v.len) / 2;
                    }
                    const rivals = mergeLeaders.get(v.next);
                    if (rivals && rivals.length > 1) {
                        const mine = remainingToExit(v);
                        for (const rival of rivals) {
                            if (rival.v === v) continue;
                            const ahead = rival.remaining < mine || (rival.remaining === mine && rival.v.id < v.id);
                            if (!ahead) continue;
                            gap = Math.min(gap, mine - rival.remaining - (rival.v.len + v.len) / 2);
                        }
                    }
                }
                let target = track.speed * v.speedFactor;
                if (gap !== Infinity) target = Math.min(target, Math.max(0, (gap - GAP_MIN_M) / HEADWAY_S));
                const dv = target - v.v;
                v.v = Math.max(0, v.v + Math.max(-DECEL * dt, Math.min(ACCEL * dt, dv)));
                v.s += v.v * dt;

                if (v.s >= track.len) {
                    if (v.next == null) {
                        // Dead end: this vehicle leaves the scene and another takes its place elsewhere.
                        if (!placeVehicle(v)) { v.s = track.len; v.v = 0; }
                    } else {
                        const overshoot = v.s - track.len;
                        const end = track.pts[track.pts.length - 1];
                        v.joinFrom = [end[0], end[1], end[2] || 0];
                        v.joinLen = v.nextJoinLen;
                        v.track = v.next;
                        v.s = -v.joinLen + overshoot;
                        v.seg = 0;
                        v.next = chooseNext(tracks[v.track]);
                        v.nextJoinLen = joinLength(tracks[v.track], v.next);
                    }
                }
                updateVehiclePose(v);
            }
        }

        // ---- people ---------------------------------------------------------------------------
        function makePerson(index) {
            const child = rng() < 0.08;
            const height = child ? 1.15 + rng() * 0.25 : 1.55 + rng() * 0.35;
            return {
                id: index, x: 0, y: 0, z: 0, heading: rng() * Math.PI * 2, target: null, wait: 0,
                stride: rng() * Math.PI * 2, amp: 1,
                speed: (child ? 0.9 + rng() * 0.4 : 1.0 + rng() * 0.5), height,
                colors: { skin: pick(rng, SKIN_COLORS), shirt: pick(rng, SHIRT_COLORS), legs: pick(rng, LEG_COLORS) }
            };
        }

        function placePerson(p) {
            if (!walk) return false;
            const point = walk.randomSpawn(rng);
            if (!point) return false;
            p.x = point[0]; p.y = point[1]; p.z = walk.zAt(p.x, p.y);
            p.target = walk.randomTarget(p.x, p.y, WANDER_RADIUS_M, rng);
            if (p.target) p.heading = Math.atan2(p.target[1] - p.y, p.target[0] - p.x);
            p.wait = rng() < 0.15 ? 1 + rng() * 5 : 0;
            return true;
        }

        function wantedPeople() {
            if (!walk) return 0;
            const stats = walk.stats;
            const effectiveArea = stats.preferredAreaM2 + 0.05 * stats.openAreaM2;
            return Math.min(maxPeople, Math.round(effectiveArea * PERSON_PER_M2));
        }

        function spawnPeople() {
            const wanted = wantedPeople();
            for (let i = 0; i < wanted; i++) {
                const p = makePerson(people.length);
                if (!placePerson(p)) break;
                people.push(p);
            }
        }

        function stepPeople(dt) {
            if (!walk) return;
            for (const p of people) {
                if (p.wait > 0) {
                    p.wait -= dt;
                    p.amp = Math.max(0, p.amp - dt * 3);
                    continue;
                }
                if (!p.target) {
                    p.target = walk.randomTarget(p.x, p.y, WANDER_RADIUS_M, rng);
                    if (!p.target) { p.wait = 1 + rng() * 2; continue; }
                }
                const dx = p.target[0] - p.x, dy = p.target[1] - p.y;
                const d = Math.hypot(dx, dy);
                if (d < 0.3) {
                    if (rng() < 0.4) p.wait = 2 + rng() * 6;
                    p.target = walk.randomTarget(p.x, p.y, WANDER_RADIUS_M, rng);
                    continue;
                }
                const step = Math.min(p.speed * dt, d);
                p.x += dx / d * step;
                p.y += dy / d * step;
                p.z = walk.zAt(p.x, p.y);
                p.heading = Math.atan2(dy, dx);
                p.stride += step * STRIDE_RAD_PER_M;
                p.amp = Math.min(1, p.amp + dt * 3);
            }
        }

        // A later surface (footprints that arrived after the first build) keeps the crowd but
        // moves anyone now standing inside a footprint and re-checks every current leg.
        function replaceSurface(next) {
            walk = next || null;
            if (!walk) return;
            for (const p of people) {
                if (!walk.isWalkable(p.x, p.y)) { placePerson(p); continue; }
                if (p.target && !walk.legOk(p.x, p.y, p.target[0], p.target[1])) p.target = null;
                p.z = walk.zAt(p.x, p.y);
            }
            const wanted = wantedPeople();
            while (people.length < wanted) {
                const p = makePerson(people.length);
                if (!placePerson(p)) break;
                people.push(p);
            }
        }

        // ---- public -----------------------------------------------------------------------------
        function step(dt) {
            if (!(dt > 0)) return;
            let remaining = Math.min(dt, 1.0);
            while (remaining > 1e-9) {
                const h = Math.min(MAX_STEP_S, remaining);
                stepVehicles(h);
                stepPeople(h);
                remaining -= h;
            }
        }

        spawnVehicles();
        spawnPeople();

        return {
            vehicles, people, tracks, graph, step, replaceSurface,
            get surface() { return walk; },
            stats: () => ({
                vehicles: vehicles.length, people: people.length, driveLength,
                walkableM2: walk ? walk.stats.preferredAreaM2 + walk.stats.openAreaM2 : 0,
                preferredM2: walk ? walk.stats.preferredAreaM2 : 0
            })
        };
    }

    return { createSimulation, mulberry32, VEHICLE_KINDS, GAP_MIN_M, HEADWAY_S, STRIDE_RAD_PER_M, WANDER_RADIUS_M, PERSON_PER_M2 };
});
