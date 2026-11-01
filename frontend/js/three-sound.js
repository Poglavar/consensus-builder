// City sound for the 3D model view, heard from the camera: the traffic of the life layer (engine
// rumble and tyre hiss from every vehicle, louder the nearer and faster it is, panned to where it
// is), the distant hum of the rest of the city, dogs barking now and then, a horn from a queue, and
// birdsong by day near the ground. Everything is synthesised with Web Audio (looped noise and
// oscillators), so there are no sound files to load. The level and event maths is pure and
// exported for tests; create() owns the AudioContext. UMD: window.__threeSound, require()-able.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeSound = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const MASTER_GAIN = 0.55;
    // Sound power per vehicle kind relative to a car; a bus is loudest, a motorcycle buzzes.
    const VEHICLE_POWER = { car: 1, bus: 4, moto: 2 };
    const FULL_SPEED_MS = 14;              // ≈ 50 km/h: tyre noise at its full share
    const REFERENCE_M = 15;                // one car at full speed this far away plays at half level
    const NEAREST_M = 3;                   // nothing is louder than at this distance
    const DOG_HEARD_M = 80;
    const HORN_HEARD_M = 120;
    const BARK_PER_DOG_S = 1 / 45;         // how often a dog in earshot starts barking
    const HORN_PER_QUEUE_S = 1 / 60;       // how often a queue within earshot hoots
    const BIRDS_BELOW_M = 200;             // songbirds are heard from street level, not from a plane
    const BIRD_SONG_PER_S = 1 / 4;

    // Pink (−3 dB/octave, Paul Kellet's filter) or brown (integrated, −6 dB/octave) noise in −1…1.
    function fillNoise(out, kind, rng) {
        const random = rng || Math.random;
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0, peak = 1e-9;
        for (let i = 0; i < out.length; i++) {
            const white = random() * 2 - 1;
            if (kind === 'brown') {
                last = (last + 0.02 * white) / 1.02;
                out[i] = last;
            } else {
                b0 = 0.99886 * b0 + white * 0.0555179; b1 = 0.99332 * b1 + white * 0.0750759;
                b2 = 0.969 * b2 + white * 0.153852; b3 = 0.8665 * b3 + white * 0.3104856;
                b4 = 0.55 * b4 + white * 0.5329522; b5 = -0.7616 * b5 - white * 0.016898;
                out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
                b6 = white * 0.115926;
            }
            peak = Math.max(peak, Math.abs(out[i]));
        }
        for (let i = 0; i < out.length; i++) out[i] /= peak;
        return out;
    }

    // `listener`: { x, y, z, rightX, rightY } in the life layer's true metres, `right` the camera's
    // horizontal right-hand direction (unit). Distance and direction of a point from it.
    function heard(listener, x, y, z) {
        const dx = x - listener.x, dy = y - listener.y, dz = (z || 0) - listener.z;
        const d = Math.max(NEAREST_M, Math.hypot(dx, dy, dz));
        const flat = Math.hypot(dx, dy);
        const pan = flat > 1e-6 ? (dx * listener.rightX + dy * listener.rightY) / flat * Math.min(1, flat / d) : 0;
        return { d, pan };
    }

    const soft = (intensity, reference) => intensity / (intensity + reference);

    // The traffic heard from `listener`: { rumble, hiss } levels 0…1 (inverse-square sum over the
    // vehicles, softly saturated) and `pan` −1 (left) … 1 (right), weighted by loudness.
    function trafficLevels(vehicles, listener) {
        let rumble = 0, hiss = 0, panSum = 0;
        for (const v of (vehicles || [])) {
            const { d, pan } = heard(listener, v.x, v.y, v.z);
            const speed = Math.min(1, Math.max(0, v.v || 0) / FULL_SPEED_MS);
            const power = VEHICLE_POWER[v.kind] || 1;
            const engine = power * (0.35 + 0.65 * speed) / (d * d);
            rumble += engine;
            hiss += (v.kind === 'bus' ? 2 : 1) * speed * speed / (d * d);
            panSum += engine * pan;
        }
        const reference = 1 / (REFERENCE_M * REFERENCE_M);
        return { rumble: soft(rumble, reference), hiss: soft(hiss, reference), pan: rumble > 0 ? Math.max(-1, Math.min(1, panSum / rumble)) : 0 };
    }

    // The events of one tick of `dt` seconds: which dog starts barking (the first to roll it among
    // those in earshot), whether a stopped vehicle in earshot hoots, and whether a bird sings.
    // Returns [{ type: 'bark'|'horn'|'birds', gain, pan, voice? }].
    function rollEvents({ dt, dogs, vehicles, listener, night, rng }) {
        const random = rng || Math.random;
        const events = [];
        for (const dog of (dogs || [])) {
            const { d, pan } = heard(listener, dog.x, dog.y, dog.z + 0.4);
            if (d > DOG_HEARD_M || random() >= BARK_PER_DOG_S * dt) continue;
            events.push({ type: 'bark', gain: Math.min(1, 6 / d), pan, voice: dog.bark || 400 });
            break;
        }
        const queued = (vehicles || []).filter(v => (v.v || 0) < 0.5);
        if (queued.length && random() < HORN_PER_QUEUE_S * dt) {
            const v = queued[Math.floor(random() * queued.length)];
            const { d, pan } = heard(listener, v.x, v.y, v.z + 1);
            if (d <= HORN_HEARD_M) events.push({ type: 'horn', gain: Math.min(1, 20 / d), pan, voice: v.kind === 'bus' ? 300 : 420 });
        }
        if (night < 0.5 && listener.z < BIRDS_BELOW_M && random() < BIRD_SONG_PER_S * dt) {
            events.push({ type: 'birds', gain: 1 - listener.z / BIRDS_BELOW_M, pan: random() * 1.6 - 0.8 });
        }
        return events;
    }

    // The distant city: a low hum under everything, quieter at night and from high above.
    function humLevel(night, heightM) {
        const height = Math.max(0, Number(heightM) || 0);
        return (0.16 - 0.07 * Math.min(1, Math.max(0, night || 0))) * (1 - 0.5 * Math.min(1, height / 1500));
    }

    function create() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContextClass();
        const out = ctx.createGain();
        out.gain.value = 0;
        const limiter = ctx.createDynamicsCompressor();
        out.connect(limiter);
        limiter.connect(ctx.destination);

        function noiseBuffer(kind) {
            const buffer = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
            fillNoise(buffer.getChannelData(0), kind);
            return buffer;
        }
        const pink = noiseBuffer('pink');
        const brown = noiseBuffer('brown');

        // A looped noise bed through a filter, a gain and (optionally) a panner.
        function bed(buffer, type, frequency, q, panned) {
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.loop = true;
            const filter = ctx.createBiquadFilter();
            filter.type = type;
            filter.frequency.value = frequency;
            filter.Q.value = q;
            const gain = ctx.createGain();
            gain.gain.value = 0;
            source.connect(filter);
            filter.connect(gain);
            let panner = null;
            if (panned) { panner = ctx.createStereoPanner(); gain.connect(panner); panner.connect(out); } else gain.connect(out);
            source.start(0, Math.random() * buffer.duration);
            return { source, gain, panner };
        }
        const rumble = bed(brown, 'lowpass', 220, 0.7, true);
        const hiss = bed(pink, 'bandpass', 900, 0.6, true);
        const hum = bed(brown, 'lowpass', 140, 0.5, false);

        // A one-shot voice: nodes built for the event, panned, released when it ends.
        function voice(pan) {
            const panner = ctx.createStereoPanner();
            panner.pan.value = pan;
            panner.connect(out);
            return panner;
        }
        function envelope(t, peak, attack, decay) {
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
            return gain;
        }
        function oscillator(type, t, end) {
            const osc = ctx.createOscillator();
            osc.type = type;
            osc.start(t);
            osc.stop(end);
            return osc;
        }

        // A woof: a sawtooth falling in pitch through the voice's formant, with a breath of noise.
        function bark(event) {
            const panner = voice(event.pan);
            const woofs = 1 + Math.floor(Math.random() * 3);
            const f0 = event.voice;
            for (let i = 0; i < woofs; i++) {
                const t = ctx.currentTime + 0.05 + i * (0.22 + Math.random() * 0.12);
                const osc = oscillator('sawtooth', t, t + 0.2);
                osc.frequency.setValueAtTime(f0 * 1.3, t);
                osc.frequency.exponentialRampToValueAtTime(f0 * 0.75, t + 0.13);
                const formant = ctx.createBiquadFilter();
                formant.type = 'bandpass';
                formant.frequency.value = f0 * 2.6;
                formant.Q.value = 1.8;
                const env = envelope(t, 0.5 * event.gain, 0.012, 0.15);
                osc.connect(formant); formant.connect(env); env.connect(panner);
                const breath = ctx.createBufferSource();
                breath.buffer = pink;
                const breathFilter = ctx.createBiquadFilter();
                breathFilter.type = 'bandpass';
                breathFilter.frequency.value = f0 * 4;
                const breathEnv = envelope(t, 0.15 * event.gain, 0.005, 0.08);
                breath.connect(breathFilter); breathFilter.connect(breathEnv); breathEnv.connect(panner);
                breath.start(t, Math.random() * 3, 0.12);
                if (i === woofs - 1) osc.onended = () => panner.disconnect();
            }
        }

        // A horn: two square tones a third apart, softened.
        function horn(event) {
            const panner = voice(event.pan);
            const t = ctx.currentTime + 0.02;
            const length = 0.25 + Math.random() * 0.35;
            const tone = ctx.createBiquadFilter();
            tone.type = 'lowpass';
            tone.frequency.value = 1800;
            const env = ctx.createGain();
            env.gain.setValueAtTime(0.0001, t);
            env.gain.exponentialRampToValueAtTime(0.12 * event.gain, t + 0.015);
            env.gain.setValueAtTime(0.12 * event.gain, t + length);
            env.gain.exponentialRampToValueAtTime(0.0001, t + length + 0.05);
            tone.connect(env); env.connect(panner);
            [1, 1.26].forEach((ratio, i) => {
                const osc = oscillator('square', t, t + length + 0.1);
                osc.frequency.value = event.voice * ratio;
                osc.connect(tone);
                if (i === 1) osc.onended = () => panner.disconnect();
            });
        }

        // A songbird: a run of quick whistled notes sweeping up or down.
        function birds(event) {
            const panner = voice(event.pan);
            const notes = 3 + Math.floor(Math.random() * 5);
            const base = 2800 + Math.random() * 1600;
            let t = ctx.currentTime + 0.05;
            for (let i = 0; i < notes; i++) {
                const length = 0.05 + Math.random() * 0.06;
                const osc = oscillator('sine', t, t + length + 0.02);
                const up = Math.random() < 0.5;
                osc.frequency.setValueAtTime(base * (up ? 0.85 : 1.2), t);
                osc.frequency.exponentialRampToValueAtTime(base * (up ? 1.25 : 0.8), t + length);
                const env = envelope(t, 0.05 * event.gain, 0.01, length);
                osc.connect(env); env.connect(panner);
                if (i === notes - 1) osc.onended = () => panner.disconnect();
                t += length + 0.04 + Math.random() * 0.08;
            }
        }
        const players = { bark, horn, birds };

        let playing = false;
        const last = { rumble: 0, hiss: 0, pan: 0, hum: 0, events: { bark: 0, horn: 0, birds: 0 } };
        // On (fades in) or off (stops at once and suspends the context, so nothing runs while silent).
        function setPlaying(on) {
            const next = !!on;
            if (next === playing) return;
            playing = next;
            const t = ctx.currentTime;
            out.gain.cancelScheduledValues(t);
            if (next) {
                out.gain.setValueAtTime(0, t);
                out.gain.setTargetAtTime(MASTER_GAIN, t, 0.25);
                ctx.resume().catch(() => { });
            } else {
                out.gain.setValueAtTime(0, t);
                ctx.suspend().catch(() => { });
            }
        }

        // One tick: `scene` = { dt, vehicles, dogs, listener, night }.
        function update(scene) {
            if (!playing) return;
            if (ctx.state === 'suspended') ctx.resume().catch(() => { });
            const t = ctx.currentTime;
            const traffic = trafficLevels(scene.vehicles, scene.listener);
            rumble.gain.gain.setTargetAtTime(0.9 * traffic.rumble, t, 0.15);
            hiss.gain.gain.setTargetAtTime(0.5 * traffic.hiss, t, 0.15);
            rumble.panner.pan.setTargetAtTime(traffic.pan, t, 0.15);
            hiss.panner.pan.setTargetAtTime(traffic.pan, t, 0.15);
            last.hum = humLevel(scene.night, scene.listener.z);
            hum.gain.gain.setTargetAtTime(last.hum, t, 0.5);
            Object.assign(last, traffic);
            for (const event of rollEvents(scene)) { players[event.type](event); last.events[event.type]++; }
        }

        function dispose() {
            playing = false;
            [rumble, hiss, hum].forEach(b => { try { b.source.stop(); } catch (_) { } });
            ctx.close().catch(() => { });
        }

        return {
            setPlaying, update, dispose, get state() { return ctx.state; }, get playing() { return playing; },
            stats: () => ({ state: ctx.state, playing, ...last, events: { ...last.events } })
        };
    }

    return { create, fillNoise, trafficLevels, rollEvents, humLevel, REFERENCE_M, DOG_HEARD_M, BIRDS_BELOW_M };
});
