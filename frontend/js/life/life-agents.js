// Life agents: the schematic population moving in the 3D model view — vehicles following directed
// lane tracks (life-graph.js) with simple car-following, steered like real vehicles (the front axle
// rides the lane and the junction curve, the rear axle trails it), and people wandering the walkable surface
// (life-surface.js), some of them walking a dog on a lead. Pure and deterministic (seeded), no DOM, no THREE; true metres and seconds.
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
    const TURN_BRAKE = 2.5;       // m/s², the comfortable braking used to slow down for a turn
    const STRIDE_RAD_PER_M = 5.2; // Station3D's walk cycle: limb phase advance per metre walked
    const MAX_STEP_S = 0.1;       // one step never integrates more than this
    const WANDER_RADIUS_M = 40;   // how far a person looks for the next destination
    const PERSON_PER_M2 = 1 / 250; // crowd density over preferred walking space
    const CHILD_SHARE = 0.06;     // walkers on their own who are children
    const PAIR_SHARE = 0.3;       // walkers who set out as a pair (a companion beside them)
    const PAIR_CHILD_SHARE = 0.5; // companions who are a child walking with an adult
    const PAIR_GAP_M = 0.7;       // shoulder to shoulder in a pair
    const DOG_SHARE = 0.16;       // adults walking on their own who walk a dog
    const LEASH_M = 1.8;          // how far a dog strays from its walker's hand

    // To-scale schematic vehicle classes (metres). `clearance` is the body's height above the road;
    // `frontAxle`/`rearAxle` are the axles' distances ahead of and behind the body centre (a city bus
    // has a 5.9 m wheelbase with 2.7 m / 3.4 m overhangs); `turnRadius` sizes its junction curves,
    // wider for a bus so its trailing rear axle does not cut across the corner.
    const VEHICLE_KINDS = {
        car: { len: 4.4, width: 1.8, height: 1.5, clearance: 0.3, wheelRadius: 0.32, frontAxle: 1.4, rearAxle: 1.3, turnRadius: 7, weight: 0.86, speedFactor: 1.0 },
        bus: { len: 12.0, width: 2.5, height: 3.2, clearance: 0.4, wheelRadius: 0.5, frontAxle: 3.3, rearAxle: 2.6, turnRadius: 11, weight: 0.06, speedFactor: 0.8 },
        moto: { len: 2.1, width: 0.6, height: 0.95, clearance: 0.4, wheelRadius: 0.3, frontAxle: 0.7, rearAxle: 0.7, turnRadius: 6, weight: 0.08, speedFactor: 1.1 }
    };
    const MAX_STEER_RAD = 0.6;
    // No greys and no near-whites: those vanish against the grey buildings and the pale ground.
    const CAR_COLORS = [0x1a1a1a, 0x1a1a1a, 0xc0392b, 0xc0392b, 0x1f5fbf, 0x1f5fbf, 0x2e7d32, 0xf1c40f, 0xe67e22, 0x8e6e53, 0x6c3483, 0x16a085, 0x2c3e50, 0xd35400];
    const BUS_COLORS = [0x1e63c3];
    const MOTO_COLORS = [0x222222, 0xb71c1c, 0x37474f];
    const SKIN_COLORS = [0xf1c9a5, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
    const SHIRT_COLORS = [0x2f4f7f, 0x8b1e3f, 0x3c7a4d, 0xd9d2c5, 0xe8b04a, 0x5b5b5b, 0xffffff, 0x1f1f1f, 0xc0392b, 0x2980b9, 0xf39c12, 0x7f8c8d];
    const LEG_COLORS = [0x2b2b3a, 0x3d3d3d, 0x4a5568, 0x6b4f3a, 0x1b2a49, 0xbfb8a8];

    // Dog breeds, metres: `legM` the leg from the elbow down to the ground, `bodyM` nose-less body
    // length, `depthM`/`widthM` the chest, `headM` the skull's radius, `snoutM` the muzzle. Ears stand
    // (`earsUp`) or hang; the tail is carried at `tailRad` above the horizontal. A coat is
    // { body, head, legs }. `bark` is the voice's fundamental (Hz): small dogs yap, big dogs woof.
    const DOG_BREEDS = {
        labrador: { weight: 0.24, legM: 0.32, bodyM: 0.72, depthM: 0.27, widthM: 0.22, headM: 0.1, snoutM: 0.12, earM: 0.1, earsUp: false, tailM: 0.36, tailRad: 0.25, bark: 260,
            coats: [{ body: 0xd8b26a, head: 0xd8b26a, legs: 0xd8b26a }, { body: 0x1d1a18, head: 0x1d1a18, legs: 0x1d1a18 }, { body: 0x5a3a22, head: 0x5a3a22, legs: 0x5a3a22 }] },
        shepherd: { weight: 0.14, legM: 0.36, bodyM: 0.8, depthM: 0.28, widthM: 0.22, headM: 0.1, snoutM: 0.14, earM: 0.12, earsUp: true, tailM: 0.42, tailRad: -0.7, bark: 230,
            coats: [{ body: 0x3a2a1c, head: 0xa9743b, legs: 0xb98445 }] },
        husky: { weight: 0.12, legM: 0.32, bodyM: 0.68, depthM: 0.25, widthM: 0.21, headM: 0.095, snoutM: 0.1, earM: 0.09, earsUp: true, tailM: 0.32, tailRad: 1.1, bark: 300,
            coats: [{ body: 0x6f7378, head: 0x8d9196, legs: 0xe9e9e6 }, { body: 0x2c2c2e, head: 0x4a4a4c, legs: 0xe9e9e6 }] },
        beagle: { weight: 0.16, legM: 0.2, bodyM: 0.5, depthM: 0.2, widthM: 0.16, headM: 0.075, snoutM: 0.08, earM: 0.1, earsUp: false, tailM: 0.22, tailRad: 1.0, bark: 420,
            coats: [{ body: 0x2a2018, head: 0x9a6430, legs: 0xf1ece2 }] },
        terrier: { weight: 0.18, legM: 0.17, bodyM: 0.42, depthM: 0.15, widthM: 0.13, headM: 0.065, snoutM: 0.06, earM: 0.05, earsUp: false, tailM: 0.12, tailRad: 1.3, bark: 620,
            coats: [{ body: 0xf0ebe0, head: 0xb07a40, legs: 0xf0ebe0 }, { body: 0xf0ebe0, head: 0x2a2018, legs: 0xf0ebe0 }] },
        dachshund: { weight: 0.16, legM: 0.09, bodyM: 0.52, depthM: 0.17, widthM: 0.14, headM: 0.065, snoutM: 0.09, earM: 0.08, earsUp: false, tailM: 0.2, tailRad: 0.2, bark: 520,
            coats: [{ body: 0x8b4513, head: 0x8b4513, legs: 0x8b4513 }, { body: 0x231a14, head: 0x7a4a24, legs: 0x7a4a24 }] }
    };

    function pickDogBreed(rng) {
        let r = rng();
        for (const [breed, spec] of Object.entries(DOG_BREEDS)) {
            if (r < spec.weight) return breed;
            r -= spec.weight;
        }
        return 'labrador';
    }

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
        const dogs = [];
        // Dogs draw from their own stream, so adding them never reshuffles the crowd or the traffic.
        const dogRng = mulberry32((o.seed != null ? o.seed : 1) ^ 0x5bd1e995);
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

        // The curve from `track` into `nextId` (life-graph.junctionCurve) at a turn radius, cached
        // per pair and radius.
        const curves = new Map();
        function curveTo(track, nextId, radius) {
            if (nextId == null) return null;
            const key = track.id + '>' + nextId + '@' + radius;
            let curve = curves.get(key);
            if (!curve) { curve = lifeGraph.junctionCurve(track, tracks[nextId], radius); curves.set(key, curve); }
            return curve;
        }

        // Path length from s = len on `track` to s = 0 on the next track, through the curve. It is
        // negative when the trims are longer than the curve, and it keeps every gap below measured
        // along the path actually driven: (exitS − s) + curve + (s' − entryS).
        function joinOffset(track, curve) {
            return curve ? curve.len - (track.len - curve.exitS) - curve.entryS : 0;
        }

        function setNext(v, track) {
            v.next = chooseNext(track);
            v.nextCurve = curveTo(track, v.next, v.turnRadius);
            v.nextJoinLen = joinOffset(track, v.nextCurve);
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
                setNext(v, track);
                // Before the turn into the next track starts, so nobody spawns half-way round it.
                const s = rng() * (v.nextCurve ? v.nextCurve.exitS : track.len);
                if (!spotIsFree(track, s, v)) continue;
                v.track = track.id;
                v.s = s;
                v.v = track.speed * v.speedFactor * 0.6;
                v.curve = null;
                v.rear = null; // a fresh spawn: the rear axle starts straight behind the front
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
                    frontAxle: spec.frontAxle, rearAxle: spec.rearAxle, turnRadius: spec.turnRadius,
                    color: pick(rng, kind === 'bus' ? BUS_COLORS : kind === 'moto' ? MOTO_COLORS : CAR_COLORS),
                    speedFactor: spec.speedFactor * (0.85 + 0.3 * rng()),
                    track: -1, s: 0, v: 0, next: null, curve: null, nextCurve: null, nextJoinLen: 0,
                    x: 0, y: 0, z: 0, heading: 0, steer: 0, seg: 0, rear: null
                };
                if (!placeVehicle(v)) { misses++; continue; }
                vehicles.push(v);
                updateVehiclePose(v);
            }
        }

        // The point of the driven path `ahead` metres past the vehicle's s: on the junction curve it
        // is still on (s runs from entryS − curve.len up to entryS there), its track, the curve into
        // the next track, or the start of that track. A dead end clamps at the end of the track.
        function samplePath(v, ahead, out) {
            const s = v.s + ahead;
            if (v.curve && s < v.curve.entryS) {
                const along = s - v.curve.entryS + v.curve.len;
                lifeGraph.sampleTrack(v.curve, along, out, 0);
                out.heading = lifeGraph.curveHeading(v.curve, along, out.seg);
                return out;
            }
            const c = v.nextCurve;
            if (c && s > c.exitS) {
                const along = s - c.exitS;
                if (along < c.len) {
                    lifeGraph.sampleTrack(c, along, out, 0);
                    out.heading = lifeGraph.curveHeading(c, along, out.seg);
                    return out;
                }
                return lifeGraph.sampleTrack(tracks[v.next], c.entryS + along - c.len, out, 0);
            }
            lifeGraph.sampleTrack(tracks[v.track], Math.max(0, s), out, v.seg);
            v.seg = out.seg;
            return out;
        }

        // Bicycle-model pose: the front axle sits on the path frontAxle metres ahead of s and the
        // rear axle is dragged after it at the wheelbase (a tractrix), so the body pivots about its
        // rear axle and the rear wheels cut inside a corner instead of sliding sideways through it.
        // `steer` is the front wheels' angle to the body.
        function updateVehiclePose(v) {
            if (v.curve && v.s >= v.curve.entryS) v.curve = null;
            samplePath(v, v.frontAxle, sample);
            const fx = sample.x, fy = sample.y;
            const wheelbase = v.frontAxle + v.rearAxle;
            if (!v.rear) {
                v.rear = [fx - Math.cos(sample.heading) * wheelbase, fy - Math.sin(sample.heading) * wheelbase];
            } else {
                const dx = fx - v.rear[0], dy = fy - v.rear[1];
                const d = Math.hypot(dx, dy);
                if (d > 1e-6) { v.rear[0] = fx - dx / d * wheelbase; v.rear[1] = fy - dy / d * wheelbase; }
            }
            v.heading = Math.atan2(fy - v.rear[1], fx - v.rear[0]);
            v.x = fx - Math.cos(v.heading) * v.frontAxle;
            v.y = fy - Math.sin(v.heading) * v.frontAxle;
            v.z = sample.z;
            let steer = sample.heading - v.heading;
            while (steer > Math.PI) steer -= 2 * Math.PI;
            while (steer < -Math.PI) steer += 2 * Math.PI;
            v.steer = Math.max(-MAX_STEER_RAD, Math.min(MAX_STEER_RAD, steer));
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
                // Through a turn no faster than its curve allows, and braked down to that in time.
                if (v.curve && v.s < v.curve.entryS) target = Math.min(target, v.curve.vmax);
                if (v.nextCurve) {
                    const toTurn = Math.max(0, v.nextCurve.exitS - v.s);
                    target = Math.min(target, Math.sqrt(v.nextCurve.vmax * v.nextCurve.vmax + 2 * TURN_BRAKE * toTurn));
                }
                if (gap !== Infinity) target = Math.min(target, Math.max(0, (gap - GAP_MIN_M) / HEADWAY_S));
                const dv = target - v.v;
                v.v = Math.max(0, v.v + Math.max(-DECEL * dt, Math.min(ACCEL * dt, dv)));
                v.s += v.v * dt;

                if (v.next == null && v.s >= track.len) {
                    // Dead end: this vehicle leaves the scene and another takes its place elsewhere.
                    if (!placeVehicle(v)) { v.s = track.len; v.v = 0; }
                } else if (v.next != null && v.s >= v.nextCurve.exitS) {
                    // Leave the lane where the turn starts and continue on the curve into the next one.
                    const overshoot = v.s - v.nextCurve.exitS;
                    v.curve = v.nextCurve;
                    v.track = v.next;
                    v.s = v.curve.entryS - v.curve.len + overshoot;
                    v.seg = 0;
                    setNext(v, tracks[v.track]);
                }
                updateVehiclePose(v);
            }
        }

        // ---- people ---------------------------------------------------------------------------
        // A walker: a child is 1.1–1.4 m with its own proportions (three-life.js personParts); everyone
        // has their own walk-cycle phase, cadence (`gait`) and limb swing (`swing`), so two people
        // side by side never march in step. A companion (`partner`: the id of the person it walks
        // with) keeps to one side of them and takes their pace instead of wandering on its own.
        function makePerson(index, { child = rng() < CHILD_SHARE, partner = null, pace = null } = {}) {
            const height = child ? 1.1 + rng() * 0.3 : 1.55 + rng() * 0.35;
            const own = child ? 0.9 + rng() * 0.4 : 1.0 + rng() * 0.5;
            return {
                id: index, x: 0, y: 0, z: 0, heading: rng() * Math.PI * 2, target: null, wait: 0,
                stride: rng() * Math.PI * 2, amp: 1, gait: 0.85 + rng() * 0.3, swing: 0.75 + rng() * 0.35,
                speed: pace == null ? own : pace * 1.35, height, child,
                partner, side: rng() < 0.5 ? 1 : -1,
                colors: { skin: pick(rng, SKIN_COLORS), shirt: pick(rng, SHIRT_COLORS), legs: pick(rng, LEG_COLORS) }
            };
        }

        // The point beside `leader` where its companion walks (its own side), or behind it where
        // the sidewalk is too narrow for two abreast.
        function besidePoint(leader, side) {
            const x = leader.x - Math.sin(leader.heading) * side * PAIR_GAP_M, y = leader.y + Math.cos(leader.heading) * side * PAIR_GAP_M;
            if (!walk.isBlocked(x, y)) return [x, y];
            return [leader.x - Math.cos(leader.heading) * 0.8, leader.y - Math.sin(leader.heading) * 0.8];
        }

        // One more walker, and with PAIR_SHARE odds a companion beside them when the budget allows;
        // an adult left on their own may walk a dog instead.
        function addPerson(wanted) {
            const p = makePerson(people.length);
            if (!placePerson(p)) return false;
            people.push(p);
            if (!p.child && dogRng() < DOG_SHARE) addDog(p);
            if (people.length < wanted && rng() < PAIR_SHARE) {
                const c = makePerson(people.length, { child: rng() < PAIR_CHILD_SHARE, partner: p.id, pace: p.speed });
                // Beside its partner when that ground is the same kind (a sidewalk stays a sidewalk), else on the same spot.
                const at = besidePoint(p, c.side), beside = walk.classAt(at[0], at[1]) === walk.classAt(p.x, p.y);
                c.x = beside ? at[0] : p.x; c.y = beside ? at[1] : p.y;
                c.z = walk.zAt(c.x, c.y); c.heading = p.heading; c.wait = p.wait;
                people.push(c);
            }
            return true;
        }

        function placePerson(p) {
            if (!walk) return false;
            // Keep the intended density in authored public space before spending the remaining
            // crowd budget on the loaded neighbourhood. OSM context must not dilute the design.
            const authoredCount = Math.min(maxPeople, Math.round(walk.stats.authoredPreferredAreaM2 * PERSON_PER_M2));
            const point = walk.randomSpawn(rng, p.id < authoredCount);
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
            while (people.length < wanted && addPerson(wanted)) { /* until the crowd is full */ }
        }

        // A companion walks to the point beside its partner at its own pace (above the partner's, so
        // a gap closes), onto walkable ground only, and stands while the partner stands.
        function stepCompanion(p, leader, dt) {
            const at = besidePoint(leader, p.side);
            const dx = at[0] - p.x, dy = at[1] - p.y, d = Math.hypot(dx, dy);
            if (leader.wait > 0 && d < 0.5) { p.amp = Math.max(0, p.amp - dt * 3); return; }
            const step = Math.min(p.speed * dt, d);
            let moved = 0;
            if (step > 1e-6) {
                // Its partner's legs were checked, so it crosses the street with them; only a footprint stops it.
                const nx = p.x + dx / d * step, ny = p.y + dy / d * step;
                if (!walk.isBlocked(nx, ny)) { p.x = nx; p.y = ny; moved = step; }
                else {
                    const lx = leader.x - p.x, ly = leader.y - p.y, ld = Math.hypot(lx, ly);
                    const toward = Math.min(step, Math.max(0, ld - 0.4));
                    if (toward > 1e-6 && !walk.isBlocked(p.x + lx / ld * toward, p.y + ly / ld * toward)) { p.x += lx / ld * toward; p.y += ly / ld * toward; moved = toward; }
                }
                p.z = walk.zAt(p.x, p.y);
            }
            p.heading = d < 0.3 ? leader.heading : Math.atan2(dy, dx);
            p.stride += moved * STRIDE_RAD_PER_M * p.gait;
            p.amp = moved > 0.2 * p.speed * dt ? Math.min(1, p.amp + dt * 3) : Math.max(0, p.amp - dt * 3);
        }

        function stepPeople(dt) {
            if (!walk) return;
            for (const p of people) {
                if (p.wait > 0) {
                    p.wait -= dt;
                    p.amp = Math.max(0, p.amp - dt * 3);
                    continue;
                }
                if (p.partner != null) { stepCompanion(p, people[p.partner], dt); continue; }
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
                // legOk samples a leg at intervals: a footprint corner between two samples stops the walker here.
                if (walk.isBlocked(p.x + dx / d * step, p.y + dy / d * step)) { p.target = null; continue; }
                p.x += dx / d * step;
                p.y += dy / d * step;
                p.z = walk.zAt(p.x, p.y);
                p.heading = Math.atan2(dy, dx);
                p.stride += step * STRIDE_RAD_PER_M * p.gait;
                p.amp = Math.min(1, p.amp + dt * 3);
            }
        }

        // ---- dogs ---------------------------------------------------------------------------------
        // A dog on a lead: it trots a little ahead of its walker on the walker's leash side, and
        // while the walker stands it noses about within the lead's reach. It never strays further
        // than LEASH_M from the walker and steps only onto walkable ground; one left behind (a new
        // surface, a corner it could not round) rejoins at the walker's feet.
        function addDog(owner) {
            const breed = pickDogBreed(dogRng);
            const spec = DOG_BREEDS[breed];
            const side = dogRng() < 0.5 ? 1 : -1;
            const dog = {
                id: dogs.length, owner: owner.id, breed, side,
                legM: spec.legM, bodyM: spec.bodyM, depthM: spec.depthM, widthM: spec.widthM, headM: spec.headM,
                snoutM: spec.snoutM, earM: spec.earM, earsUp: spec.earsUp, tailM: spec.tailM, tailRad: spec.tailRad, bark: spec.bark,
                coat: pick(dogRng, spec.coats),
                x: owner.x, y: owner.y, z: owner.z, heading: owner.heading,
                stride: dogRng() * Math.PI * 2, amp: 0, wag: dogRng() * Math.PI * 2, nose: 0,
                lead: 0.5 + dogRng() * 0.6, sniff: null, sniffWait: 0
            };
            dogs.push(dog);
            owner.dog = dog.id;
            return dog;
        }

        function stepDog(d, dt) {
            const owner = people[d.owner];
            const ox = owner.x, oy = owner.y;
            let tx, ty, pace;
            if (owner.wait > 0) {
                // Standing walker: pick a spot to sniff within reach every few seconds.
                d.sniffWait -= dt;
                if (!d.sniff || d.sniffWait <= 0) {
                    const a = dogRng() * Math.PI * 2, r = 0.5 + dogRng() * (LEASH_M - 0.6);
                    const sx = ox + Math.cos(a) * r, sy = oy + Math.sin(a) * r;
                    d.sniff = walk.isBlocked(sx, sy) ? [ox, oy] : [sx, sy];
                    d.sniffWait = 2 + dogRng() * 4;
                }
                [tx, ty] = d.sniff;
                pace = 0.7;
            } else {
                d.sniff = null;
                const c = Math.cos(owner.heading), s = Math.sin(owner.heading);
                const ahead = d.lead, aside = d.side * 0.45;
                tx = ox + c * ahead - s * aside; ty = oy + s * ahead + c * aside;
                if (walk.isBlocked(tx, ty)) { tx = ox - c * 0.6; ty = oy - s * 0.6; }
                pace = Math.max(0.6, owner.speed) * 1.6;
            }
            const dx = tx - d.x, dy = ty - d.y, dist = Math.hypot(dx, dy);
            const fromOwner = Math.hypot(d.x - ox, d.y - oy);
            if (fromOwner > LEASH_M + 3) {
                d.x = ox; d.y = oy; d.z = owner.z; d.heading = owner.heading;
                return;
            }
            let moved = 0;
            const step = Math.min(pace * dt, dist);
            if (step > 1e-6) {
                const nx = d.x + dx / dist * step, ny = d.y + dy / dist * step;
                if (!walk.isBlocked(nx, ny) && Math.hypot(nx - ox, ny - oy) <= LEASH_M + 0.5) { d.x = nx; d.y = ny; moved = step; }
                else if (fromOwner > 0.3) {
                    // The lead pulls it back toward its walker.
                    const toward = Math.min(pace * dt, fromOwner - 0.3);
                    const px = d.x + (ox - d.x) / fromOwner * toward, py = d.y + (oy - d.y) / fromOwner * toward;
                    if (!walk.isBlocked(px, py)) { d.x = px; d.y = py; moved = toward; }
                }
                d.z = walk.zAt(d.x, d.y);
            }
            if (moved > 1e-4) d.heading = Math.atan2(dy, dx);
            // A quadruped's legs cycle faster the shorter they are.
            d.stride += moved * 3.4 / d.legM;
            const walking = moved > 0.2 * pace * dt;
            d.amp = walking ? Math.min(1, d.amp + dt * 4) : Math.max(0, d.amp - dt * 4);
            // Nose down once it stands at its spot; tail wags faster while it moves.
            const sniffing = owner.wait > 0 && !walking && dist < 0.3;
            d.nose = sniffing ? Math.min(1, d.nose + dt * 2) : Math.max(0, d.nose - dt * 3);
            d.wag += dt * (walking ? 9 : 5);
        }

        function stepDogs(dt) {
            if (!walk) return;
            for (const d of dogs) stepDog(d, dt);
        }

        // A later surface (footprints that arrived after the first build) keeps the crowd but
        // moves anyone now standing inside a footprint and re-checks every current leg.
        function replaceSurface(next) {
            walk = next || null;
            if (!walk) return;
            for (const p of people) {
                if (!walk.isWalkable(p.x, p.y)) {
                    // A companion rejoins its partner rather than moving away on its own.
                    if (p.partner != null) { const l = people[p.partner]; p.x = l.x; p.y = l.y; }
                    else placePerson(p);
                }
                if (p.target && !walk.legOk(p.x, p.y, p.target[0], p.target[1])) p.target = null;
                p.z = walk.zAt(p.x, p.y);
            }
            for (const d of dogs) {
                if (walk.isWalkable(d.x, d.y)) { d.z = walk.zAt(d.x, d.y); continue; }
                const owner = people[d.owner];
                d.x = owner.x; d.y = owner.y; d.z = owner.z; d.sniff = null;
            }
            const wanted = wantedPeople();
            while (people.length < wanted && addPerson(wanted)) { /* until the crowd is full */ }
        }

        // ---- public -----------------------------------------------------------------------------
        function step(dt) {
            if (!(dt > 0)) return;
            let remaining = Math.min(dt, 1.0);
            while (remaining > 1e-9) {
                const h = Math.min(MAX_STEP_S, remaining);
                stepVehicles(h);
                stepPeople(h);
                stepDogs(h);
                remaining -= h;
            }
        }

        spawnVehicles();
        spawnPeople();

        return {
            vehicles, people, dogs, tracks, graph, step, replaceSurface,
            get surface() { return walk; },
            stats: () => ({
                vehicles: vehicles.length, people: people.length, dogs: dogs.length, driveLength,
                walkableM2: walk ? walk.stats.preferredAreaM2 + walk.stats.openAreaM2 : 0,
                preferredM2: walk ? walk.stats.preferredAreaM2 : 0
            })
        };
    }

    return { createSimulation, mulberry32, VEHICLE_KINDS, DOG_BREEDS, GAP_MIN_M, HEADWAY_S, STRIDE_RAD_PER_M, WANDER_RADIUS_M, PERSON_PER_M2, PAIR_SHARE, PAIR_GAP_M, DOG_SHARE, LEASH_M };
});
