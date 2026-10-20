// Solar vectors use the apartment's east/north/up metre frame, independently of Three.js.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.__apartmentSunState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const TIME_ZONE = 'Europe/Zagreb', CYCLE_SECONDS = 20, RAD = Math.PI / 180;
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const clockFormatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    const timeFormatter = new Intl.DateTimeFormat('hr-HR', {
        timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
    const parts = (formatter, date) => Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
    const wrap = progress => ((progress % 1) + 1) % 1;

    function localDate(now = new Date()) {
        const p = parts(dateFormatter, now);
        return `${p.year}-${p.month}-${p.day}`;
    }

    // Resolve civil clock readings with the IANA timezone, never the computer's timezone.
    function localClock(date, hour = 0, minute = 0) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(hour) || hour < 0 || hour > 23
            || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError('Invalid local date or time');
        const target = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
        if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== date) throw new RangeError('Invalid local date');
        let instant = target;
        for (let i = 0; i < 4; i++) {
            const p = parts(clockFormatter, new Date(instant));
            const shown = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
            if (shown === target) return new Date(instant);
            instant += target - shown;
        }
        throw new RangeError('Local time does not exist on this date');
    }

    function dayBounds(date = localDate()) {
        const start = localClock(date), next = new Date(`${date}T12:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        const end = localClock(next.toISOString().slice(0, 10));
        return { date, start, end, durationMs: end.getTime() - start.getTime() };
    }

    function advanceProgress(progress, elapsedSeconds, paused = false, duration = CYCLE_SECONDS) {
        if (![progress, elapsedSeconds, duration].every(finite) || elapsedSeconds < 0 || duration <= 0) throw new RangeError('Invalid simulation clock');
        return paused ? wrap(progress) : wrap(progress + elapsedSeconds / duration);
    }

    function dateAtProgress(day, progress) {
        if (!finite(progress)) throw new RangeError('Invalid simulation progress');
        return new Date(day.start.getTime() + wrap(progress) * day.durationMs);
    }

    function progressAtTime(day, hour = 12, minute = 0) {
        return (localClock(day.date, hour, minute).getTime() - day.start.getTime()) / day.durationMs;
    }

    function clockHands(timeString) {
        if (typeof timeString !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeString)) {
            throw new RangeError('Invalid clock time');
        }
        const [hour, minute] = timeString.split(':').map(Number);
        return { hourDeg: (hour % 12) * 30 + minute / 2, minuteDeg: minute * 6 };
    }

    // Screen coordinates increase rightward and downward; north is the top of the dial.
    function compassBearing(x, y) {
        if (!finite(x) || !finite(y) || (x === 0 && y === 0)) return null;
        return ((Math.atan2(x, -y) / RAD) + 360) % 360;
    }

    // SunCalc azimuth: south=0, west=PI/2. Apartment coordinates: X right, Y up-page, Z up.
    // rotationDeg maps apartment XY to geographic east/north with a counterclockwise rotation.
    // Equivalently, it is north's clockwise bearing from apartment +Y towards apartment +X.
    function sunDirection(altitude, azimuth, rotationDeg = 0) {
        if (![altitude, azimuth, rotationDeg].every(finite)) throw new RangeError('Invalid solar angles');
        const horizontal = Math.cos(altitude), east = -horizontal * Math.sin(azimuth), north = -horizontal * Math.cos(azimuth);
        const c = Math.cos(rotationDeg * RAD), s = Math.sin(rotationDeg * RAD);
        return { x: c * east + s * north, y: -s * east + c * north, z: Math.sin(altitude) };
    }

    function orientationFromPlacement(placement) {
        if (placement?.status !== 'placed' || !finite(placement.best?.rotationDeg)) {
            return { status: 'unknown', rotationDeg: null, basis: null };
        }
        return { status: 'placed', rotationDeg: ((placement.best.rotationDeg % 360) + 360) % 360, basis: 'placement' };
    }

    function sampleSun({ sunCalc, day, progress, latitude, longitude, rotationDeg = 0 }) {
        if (!finite(latitude) || Math.abs(latitude) > 90 || !finite(longitude) || Math.abs(longitude) > 180) throw new RangeError('Invalid sun location');
        const date = dateAtProgress(day, progress), { altitude, azimuth } = sunCalc.getPosition(date, latitude, longitude);
        return { date, time: timeFormatter.format(date), altitude, azimuth,
            direction: sunDirection(altitude, azimuth, rotationDeg), daylight: altitude > 0 };
    }

    return { TIME_ZONE, CYCLE_SECONDS, localDate, dayBounds, advanceProgress, dateAtProgress, progressAtTime, clockHands, compassBearing,
        formatTime: date => timeFormatter.format(date), sunDirection, orientationFromPlacement, sampleSun };
});
