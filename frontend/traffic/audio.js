// Quiet, distance-weighted overhead traffic ambience with a gesture-gated Web Audio output.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficAudio = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const MAX_GAIN = .05;
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

    // viewport = { center: { x, y }, extent: { minX, minY, maxX, maxY } }.
    // Cars may provide { pose: { x, y }, speed } or { x, y, speed }.
    function mix(cars, viewport, running = true) {
        if (!running || !Array.isArray(cars) || !viewport?.center || !viewport?.extent) {
            return { gain: 0, rumble: 0, rolling: 0 };
        }
        const { minX, minY, maxX, maxY } = viewport.extent;
        if (![minX, minY, maxX, maxY, viewport.center.x, viewport.center.y].every(Number.isFinite)
            || maxX <= minX || maxY <= minY) return { gain: 0, rumble: 0, rolling: 0 };
        const radius = Math.max(1, Math.hypot(maxX - minX, maxY - minY) / 2);
        let count = 0, weight = 0, speedTotal = 0;
        for (const car of cars) {
            const pose = car?.pose || car;
            if (!Number.isFinite(pose?.x) || !Number.isFinite(pose?.y)
                || pose.x < minX || pose.x > maxX || pose.y < minY || pose.y > maxY) continue;
            const distance = Math.hypot(pose.x - viewport.center.x, pose.y - viewport.center.y);
            const proximity = 1 - .65 * clamp(distance / radius, 0, 1);
            const speed = clamp(Number.isFinite(car.speed) ? car.speed : 0, 0, 18);
            count++;
            weight += proximity;
            speedTotal += proximity * speed / 18;
        }
        if (!count) return { gain: 0, rumble: 0, rolling: 0 };
        const density = clamp(weight / 28, 0, 1);
        const motion = speedTotal / Math.max(weight, 1e-9);
        return {
            gain: MAX_GAIN * density,
            rumble: density * (1 - motion * .45),
            rolling: density * motion
        };
    }

    class Sound {
        constructor({ AudioContext: Context } = {}) {
            this.Context = Context || (typeof window !== 'undefined' && window.AudioContext);
            this.context = null;
            this.nodes = null;
            this.value = { gain: 0, rumble: 0, rolling: 0 };
            this.active = false;
        }

        create() {
            if (!this.Context) throw new Error('Web Audio is unavailable');
            const context = this.context = new this.Context();
            const master = context.createGain();
            const filter = context.createBiquadFilter();
            const noiseGain = context.createGain();
            const toneGain = context.createGain();
            const buffer = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate * 2)), context.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
            const noise = context.createBufferSource();
            noise.buffer = buffer; noise.loop = true;
            filter.type = 'lowpass'; filter.frequency.value = 450; filter.Q.value = .35;
            const low = context.createOscillator(), high = context.createOscillator();
            low.type = 'sine'; low.frequency.value = 46;
            high.type = 'sine'; high.frequency.value = 67;
            const lowGain = context.createGain(), highGain = context.createGain();
            lowGain.gain.value = .65; highGain.gain.value = .35;
            noise.connect(filter).connect(noiseGain).connect(master);
            low.connect(lowGain).connect(toneGain); high.connect(highGain).connect(toneGain);
            toneGain.connect(master); master.connect(context.destination);
            master.gain.value = 0;
            noise.start(); low.start(); high.start();
            this.nodes = { master, noiseGain, toneGain };
        }

        ramp(param, value) {
            const now = this.context.currentTime;
            param.cancelScheduledValues?.(now);
            if (param.setTargetAtTime) param.setTargetAtTime(value, now, .16);
            else param.value = value;
        }

        update(value) {
            this.value = value?.gain > 0 ? {
                gain: clamp(value.gain, 0, MAX_GAIN),
                rumble: clamp(value.rumble || 0, 0, 1),
                rolling: clamp(value.rolling || 0, 0, 1)
            } : { gain: 0, rumble: 0, rolling: 0 };
            if (!this.context || !this.nodes) return;
            const audible = this.active && this.value.gain > 0;
            this.ramp(this.nodes.master.gain, audible ? this.value.gain : 0);
            this.ramp(this.nodes.noiseGain.gain, audible ? .3 + .6 * this.value.rolling : 0);
            this.ramp(this.nodes.toneGain.gain, audible ? .15 + .15 * this.value.rumble : 0);
        }

        async start() {
            if (!this.context || this.context.state === 'closed') this.create();
            this.active = true;
            await this.context.resume();
            this.update(this.value);
        }

        async stop() {
            this.active = false;
            this.update({ gain: 0 });
            const context = this.context;
            if (!context || context.state === 'closed') return;
            const now = context.currentTime;
            const master = this.nodes.master.gain;
            master.cancelScheduledValues?.(now);
            if (master.setValueAtTime) master.setValueAtTime(0, now);
            else master.value = 0;
            if (context.state === 'running') await context.suspend();
        }

        async dispose() {
            this.active = false;
            const context = this.context;
            this.context = null; this.nodes = null;
            if (context && context.state !== 'closed') await context.close();
        }
    }

    return { mix, Sound, MAX_GAIN };
});
