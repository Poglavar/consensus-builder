// Sun and shadow maths for the 3D model view: where the sun stands over a place at a local date and
// time, conversions between an IANA zone's wall clock and an instant, and the fit of the sun's shadow
// camera to the view. Pure (no DOM, no THREE, no SunCalc import) so it is unit-tested headless;
// three-sun.js applies it to the scene. Sun positions come from SunCalc, passed in as `sunCalc`.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__sunShadows = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const MINUTES_PER_DAY = 1440;
    const isNumber = value => typeof value === 'number' && Number.isFinite(value);
    const isInstant = value => value instanceof Date && isNumber(value.getTime());

    // ---- Wall clock in a zone ----
    // Intl is the only zone database a browser has; one formatter per zone is reused, since building
    // one costs far more than formatting with it.
    const partFormatters = new Map();
    function partsFormatter(timeZone) {
        let formatter = partFormatters.get(timeZone);
        if (!formatter) {
            formatter = new Intl.DateTimeFormat('en-US', {
                timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
            partFormatters.set(timeZone, formatter);
        }
        return formatter;
    }

    // The wall-clock fields of `instant` in `timeZone`.
    function zoneParts(instant, timeZone) {
        const parts = {};
        for (const { type, value } of partsFormatter(timeZone).formatToParts(instant)) {
            if (type !== 'literal') parts[type] = Number(value);
        }
        return parts;
    }

    // How far the zone's wall clock is ahead of UTC at `ms`, in milliseconds.
    function zoneOffsetMs(ms, timeZone) {
        const p = zoneParts(new Date(ms), timeZone);
        const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
        return wall - Math.floor(ms / 1000) * 1000;
    }

    function parseDateISO(dateISO) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO || ''));
        if (!match) throw new RangeError(`Not a YYYY-MM-DD date: ${dateISO}`);
        return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    }

    // The instant at which the zone's clock reads `minutes` past midnight on `dateISO`. The offset is
    // read twice because the first guess can sit on the other side of a DST change; a wall time that
    // a spring-forward skips resolves to the instant one offset later, as clocks do.
    function localToInstant(dateISO, minutes, timeZone) {
        if (!isNumber(minutes)) throw new RangeError('minutes must be a finite number');
        const { year, month, day } = parseDateISO(dateISO);
        const wallMs = Date.UTC(year, month - 1, day) + Math.round(minutes * 60000);
        const first = zoneOffsetMs(wallMs, timeZone);
        const second = zoneOffsetMs(wallMs - first, timeZone);
        return new Date(wallMs - second);
    }

    function localDateISO(instant, timeZone) {
        const p = zoneParts(instant, timeZone);
        return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    }

    function localMinutes(instant, timeZone) {
        const p = zoneParts(instant, timeZone);
        return p.hour * 60 + p.minute;
    }

    function formatMinutes(minutes) {
        const m = ((Math.floor(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
        return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    }

    // ---- The sun ----
    // SunCalc's azimuth is measured from SOUTH, increasing towards the WEST. The scene is x east,
    // y north, z up — but its XY are Web-Mercator units, inflated by k = 1/cos(latitude) against the
    // metric Z (three-mode.js lifeMercatorK). A shadow h metres long on the ground is h·k scene units,
    // so the horizontal part of the sun ray is scaled by k before normalising; without it every
    // shadow would come out cos(latitude) short (≈30% at Zagreb).
    function sunDirection(altitude, azimuth, k = 1) {
        if (![altitude, azimuth, k].every(isNumber) || k <= 0) return null;
        const horizontal = Math.cos(altitude) * k;
        const x = -Math.sin(azimuth) * horizontal;
        const y = -Math.cos(azimuth) * horizontal;
        const z = Math.sin(altitude);
        const length = Math.hypot(x, y, z);
        return { x: x / length, y: y / length, z: z / length };
    }

    // Direct light fades in over the first ten degrees above the horizon instead of switching on at
    // sunrise, and is off below it. A fraction of full strength, 0…1.
    const FULL_SUN_ALTITUDE = 10 * Math.PI / 180;
    function sunStrength(altitude) {
        if (!isNumber(altitude) || altitude <= 0) return 0;
        return Math.min(1, Math.sin(altitude) / Math.sin(FULL_SUN_ALTITUDE));
    }

    // The sky's own light (the scene's hemisphere light) by sun altitude in degrees, as a fraction of
    // its daytime intensity plus sRGB sky and ground colours (0…1): white by day, warm at sunset, a
    // dim moonlit blue at night, so the ground darkens with the sky instead of staying day-grey.
    const SKY_LIGHT_KEYS = [
        { altitude: 10, intensity: 1, sky: 0xffffff, ground: 0x888888 },
        { altitude: 2, intensity: 0.9, sky: 0xfff0e0, ground: 0x857f7a },
        { altitude: -2, intensity: 0.65, sky: 0xd9d4e6, ground: 0x6f6c78 },
        { altitude: -6, intensity: 0.42, sky: 0xa3afd8, ground: 0x3e4352 },
        { altitude: -12, intensity: 0.3, sky: 0x8296cc, ground: 0x262a36 }
    ];
    const hexRgb = hex => [(hex >> 16) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
    function skyLight(altitudeDeg) {
        const keys = SKY_LIGHT_KEYS;
        let upper = keys[0], lower = keys[0], t = 0;
        // No altitude (the sun layer off) keeps the plain daytime light, as the sky keeps its neutral one.
        if (isNumber(altitudeDeg) && altitudeDeg < keys[0].altitude) {
            upper = lower = keys[keys.length - 1];
            for (let i = 1; i < keys.length; i++) {
                if (altitudeDeg >= keys[i].altitude) {
                    upper = keys[i - 1]; lower = keys[i];
                    t = (upper.altitude - altitudeDeg) / (upper.altitude - lower.altitude);
                    break;
                }
            }
        }
        const mix = (a, b) => hexRgb(a).map((value, i) => value + (hexRgb(b)[i] - value) * t);
        return { intensity: upper.intensity + (lower.intensity - upper.intensity) * t, sky: mix(upper.sky, lower.sky), ground: mix(upper.ground, lower.ground) };
    }

    // How bright the sun icon burns: dim at the horizon, full from 45° up. The light itself uses
    // sunStrength, which saturates much lower; this one keeps changing through the day.
    const FULL_GLOW_ALTITUDE = 45 * Math.PI / 180;
    function sunGlow(altitude) {
        if (!isNumber(altitude) || altitude <= 0) return 0;
        return Math.min(1, altitude / FULL_GLOW_ALTITUDE);
    }

    // The day at a place: sunrise and sunset as local minutes. Where the sun neither rises nor sets
    // that date both are null and `polar` says whether it is polar day or polar night.
    function daylight(sunCalc, dateISO, lat, lng, timeZone) {
        // Noon local time keeps SunCalc's solar day on the chosen date across the date line and DST.
        const noon = localToInstant(dateISO, 12 * 60, timeZone);
        const times = sunCalc.getTimes(noon, lat, lng);
        const sunrise = isInstant(times.sunrise) ? times.sunrise : null;
        const sunset = isInstant(times.sunset) ? times.sunset : null;
        const solarNoon = isInstant(times.solarNoon) ? localMinutes(times.solarNoon, timeZone) : 12 * 60;
        if (!sunrise || !sunset || localDateISO(sunrise, timeZone) !== dateISO || localDateISO(sunset, timeZone) !== dateISO) {
            const noonAltitude = sunCalc.getPosition(localToInstant(dateISO, solarNoon, timeZone), lat, lng).altitude;
            return { sunrise: null, sunset: null, solarNoon, polar: noonAltitude > 0 ? 'day' : 'night' };
        }
        return { sunrise: localMinutes(sunrise, timeZone), sunset: localMinutes(sunset, timeZone), solarNoon, polar: null };
    }

    // Where the view starts when the person has not picked a time: now, if the sun is up at the
    // place. At night a playing day starts at sunrise, so the first thing seen is the day beginning;
    // a paused one shows solar noon, so a model opened at night still shows its shadows.
    function initialMinutes(nowMinutes, day, playing) {
        if (day.sunrise === null) return nowMinutes;
        if (nowMinutes >= day.sunrise && nowMinutes <= day.sunset) return nowMinutes;
        return playing ? day.sunrise : day.solarNoon;
    }

    // The playing day: one full 24 h turn every `cycleMs`, wrapping past midnight onto the same date.
    function advanceMinutes(minutes, elapsedMs, cycleMs) {
        if (![minutes, elapsedMs, cycleMs].every(isNumber) || cycleMs <= 0 || elapsedMs <= 0) return minutes;
        const next = minutes + elapsedMs * MINUTES_PER_DAY / cycleMs;
        return ((next % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    }

    // ---- The shadow camera ----
    // One orthographic shadow box centred on what the camera looks at, sized to the view: half its
    // side grows with the camera's distance, in steps of 25% so a small zoom does not refit (and
    // re-render) the map. Its centre snaps to whole texels so panning does not make edges crawl.
    const EXTENT_STEP = 1.25;
    const MIN_HALF_EXTENT = 30;
    const MAX_HALF_EXTENT = 3000;
    function shadowFrame({ targetX, targetY, distance, mapSize }) {
        if (![targetX, targetY, distance, mapSize].every(isNumber) || mapSize <= 0) return null;
        const wanted = Math.min(MAX_HALF_EXTENT, Math.max(MIN_HALF_EXTENT, distance * 0.9));
        const step = Math.ceil(Math.log(wanted / MIN_HALF_EXTENT) / Math.log(EXTENT_STEP));
        const halfExtent = Math.min(MAX_HALF_EXTENT, MIN_HALF_EXTENT * Math.pow(EXTENT_STEP, step));
        const texel = (2 * halfExtent) / mapSize;
        return {
            halfExtent,
            texel,
            centerX: Math.round(targetX / texel) * texel,
            centerY: Math.round(targetY / texel) * texel,
            // The light sits far up the sun ray so every caster between it and the box — a tower
            // outside the box throwing a long evening shadow into it — is inside the depth range.
            lightDistance: 5000 + 2 * halfExtent,
            far: 5000 + 4 * halfExtent + 1000
        };
    }

    return {
        MINUTES_PER_DAY, zoneParts, zoneOffsetMs, localToInstant, localDateISO, localMinutes, formatMinutes,
        sunDirection, sunStrength, sunGlow, skyLight, daylight, initialMinutes, advanceMinutes, shadowFrame
    };
});
