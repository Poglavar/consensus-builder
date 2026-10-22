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
        const m = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
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

    // The day at a place: sunrise and sunset as local minutes, or null for polar day and night (no
    // sunrise that date), when the time control spans the whole day instead.
    function daylight(sunCalc, dateISO, lat, lng, timeZone) {
        // Noon local time keeps SunCalc's solar day on the chosen date across the date line and DST.
        const noon = localToInstant(dateISO, 12 * 60, timeZone);
        const times = sunCalc.getTimes(noon, lat, lng);
        const sunrise = isInstant(times.sunrise) ? times.sunrise : null;
        const sunset = isInstant(times.sunset) ? times.sunset : null;
        const solarNoon = isInstant(times.solarNoon) ? localMinutes(times.solarNoon, timeZone) : 12 * 60;
        if (!sunrise || !sunset || localDateISO(sunrise, timeZone) !== dateISO || localDateISO(sunset, timeZone) !== dateISO) {
            return { sunrise: null, sunset: null, solarNoon, min: 0, max: MINUTES_PER_DAY - 1 };
        }
        const rise = localMinutes(sunrise, timeZone);
        const set = localMinutes(sunset, timeZone);
        return { sunrise: rise, sunset: set, solarNoon, min: rise, max: Math.max(rise, set) };
    }

    // What the view shows when the person has not picked a time: now, if the sun is up at the place,
    // else that day's solar noon — a model opened at night should still show its shadows.
    function initialMinutes(nowMinutes, day) {
        if (day.sunrise === null) return nowMinutes;
        return nowMinutes >= day.sunrise && nowMinutes <= day.sunset ? nowMinutes : day.solarNoon;
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
        sunDirection, sunStrength, daylight, initialMinutes, shadowFrame
    };
});
