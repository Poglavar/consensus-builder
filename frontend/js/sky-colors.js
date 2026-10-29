// Sky colours for the 3D model view: the zenith and horizon colours for a sun altitude, the warm glow
// toward a low sun, how strongly stars show, the sun's direction in the scene frame and a fixed star
// field. Pure numbers, no THREE: three-sky.js uploads them. Colours are sRGB triples in 0..1.
// UMD: window.SkyColors in the browser, require()-able in node.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SkyColors = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const rgb = hex => Object.freeze([(hex >> 16) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]);

    // The sun layer is off (or nothing is attached): a quiet light gradient close to the old flat
    // near-white background, with no sun, glow or stars.
    const NEUTRAL = Object.freeze({
        zenith: rgb(0xdfe7f0), horizon: rgb(0xf8f9fb), glow: rgb(0xf8f9fb), glowStrength: 0, sunDisc: 0, stars: 0
    });

    // Key altitudes in degrees, highest first: blue day, a pale horizon, a peach-to-mauve twilight
    // all round (the orange is the glow on the sun's side, below) and a dark blue night.
    const SKY_KEYS = Object.freeze([
        { altitude: 60, zenith: rgb(0x5692da), horizon: rgb(0xc8def2) },
        { altitude: 25, zenith: rgb(0x5590d8), horizon: rgb(0xd2e4f3) },
        { altitude: 10, zenith: rgb(0x5a8ecc), horizon: rgb(0xe3e6df) },
        { altitude: 3, zenith: rgb(0x5277a3), horizon: rgb(0xe8d4bf) },
        { altitude: 0, zenith: rgb(0x3d557b), horizon: rgb(0xd8bba9) },
        { altitude: -3, zenith: rgb(0x2a3a60), horizon: rgb(0xa88a92) },
        { altitude: -6, zenith: rgb(0x1a2546), horizon: rgb(0x5d5472) },
        { altitude: -10, zenith: rgb(0x0f1834), horizon: rgb(0x2c3352) },
        { altitude: -18, zenith: rgb(0x08102a), horizon: rgb(0x1a2544) }
    ].map(Object.freeze));

    // The warm light on the sun's side of the sky: strongest with the sun on the horizon.
    const GLOW_KEYS = Object.freeze([
        { altitude: 18, strength: 0, color: rgb(0xffe2b0) },
        { altitude: 8, strength: 0.35, color: rgb(0xffcb86) },
        { altitude: 2, strength: 0.85, color: rgb(0xffa458) },
        { altitude: -1, strength: 0.9, color: rgb(0xf5843f) },
        { altitude: -5, strength: 0.5, color: rgb(0xc0566a) },
        { altitude: -10, strength: 0, color: rgb(0x5a3a66) }
    ].map(Object.freeze));

    const STARS_FROM_DEG = -4;    // stars begin to show with the sun this far below the horizon
    const STARS_FULL_DEG = -12;   // and are at full strength from nautical twilight on
    const DISC_FADE_DEG = 1;      // the sun's disc fades out as it sinks below the horizon

    const lerp = (a, b, t) => a + (b - a) * t;
    const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

    // The two keys around an altitude and the fraction between them (keys sorted highest first).
    function around(keys, altitude) {
        if (altitude >= keys[0].altitude) return [keys[0], keys[0], 0];
        for (let i = 1; i < keys.length; i++) {
            if (altitude >= keys[i].altitude) {
                const upper = keys[i - 1], lower = keys[i];
                return [upper, lower, (upper.altitude - altitude) / (upper.altitude - lower.altitude)];
            }
        }
        const last = keys[keys.length - 1];
        return [last, last, 0];
    }

    // Stars: 0 by day and through the first dusk, 1 at night.
    function starStrength(altitudeDeg) {
        if (!Number.isFinite(altitudeDeg)) return 0;
        return Math.min(1, Math.max(0, (STARS_FROM_DEG - altitudeDeg) / (STARS_FROM_DEG - STARS_FULL_DEG)));
    }

    // The sky for a sun altitude in degrees; null (sun layer off) gives NEUTRAL.
    function skyColors(altitudeDeg) {
        if (!Number.isFinite(altitudeDeg)) return NEUTRAL;
        const [up, down, t] = around(SKY_KEYS, altitudeDeg);
        const [glowUp, glowDown, g] = around(GLOW_KEYS, altitudeDeg);
        return {
            zenith: mixRgb(up.zenith, down.zenith, t),
            horizon: mixRgb(up.horizon, down.horizon, t),
            glow: mixRgb(glowUp.color, glowDown.color, g),
            glowStrength: lerp(glowUp.strength, glowDown.strength, g),
            sunDisc: Math.min(1, Math.max(0, (altitudeDeg + DISC_FADE_DEG) / DISC_FADE_DEG)),
            stars: starStrength(altitudeDeg)
        };
    }

    // The direction toward the sun in the scene frame (x east, y north, z up), from SunCalc's
    // altitude and azimuth in radians (azimuth from south, positive toward west). Unlike the light in
    // sun-shadows.js this is the true direction: the sky is not Mercator-inflated.
    function sunDirection(altitudeRad, azimuthRad) {
        if (!Number.isFinite(altitudeRad) || !Number.isFinite(azimuthRad)) return null;
        const horizontal = Math.cos(altitudeRad);
        return { x: -Math.sin(azimuthRad) * horizontal, y: -Math.cos(azimuthRad) * horizontal, z: Math.sin(altitudeRad) };
    }

    // A fixed star field on the upper sky: unit directions (uniform over the dome, none in the
    // last few degrees above the horizon where haze hides them), point sizes in CSS pixels and
    // brightness 0..1 with many faint stars and few bright ones. Deterministic for a seed.
    function starField(count = 1600, seed = 20261028) {
        let state = seed >>> 0;
        const random = () => {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const minZ = Math.sin(3 * Math.PI / 180);
        const positions = new Float32Array(count * 3);
        const sizes = new Float32Array(count);
        const brightness = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const z = minZ + (1 - minZ) * random();   // uniform in z = uniform area on the sphere
            const angle = 2 * Math.PI * random();
            const r = Math.sqrt(1 - z * z);
            positions[i * 3] = r * Math.cos(angle);
            positions[i * 3 + 1] = r * Math.sin(angle);
            positions[i * 3 + 2] = z;
            const magnitude = Math.pow(random(), 3);
            brightness[i] = 0.25 + 0.75 * magnitude;
            sizes[i] = 1.2 + 1.8 * magnitude;
        }
        return { positions, sizes, brightness };
    }

    return { NEUTRAL, SKY_KEYS, GLOW_KEYS, skyColors, starStrength, sunDirection, starField };
});
