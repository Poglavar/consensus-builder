// Build-out state of a scheduled plan at a month: which members are planned, under construction or
// built, and how far along. Pure and DOM-free; the map clock, 2D and model views read it
// (docs/buildout-timeline.md).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BuildoutSchedule = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
    const BUILT = Object.freeze({ phase: 'built', progress: 1 });

    // A month as a running count ('2027-03' → 2027·12 + 2), or null for anything else.
    function monthIndex(value) {
        const match = typeof value === 'string' ? MONTH.exec(value) : null;
        return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
    }
    function monthOf(index) {
        if (!Number.isInteger(index) || index < 0) return null;
        return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
    }
    function addMonths(value, count) { const index = monthIndex(value); return index === null ? null : monthOf(index + count); }
    function monthsBetween(from, to) {
        const a = monthIndex(from), b = monthIndex(to);
        return a === null || b === null ? null : b - a;
    }
    function currentMonth(date = new Date()) { return monthOf(date.getFullYear() * 12 + date.getMonth()); }

    // Progress is linear over the window's months, counting the month in view as worked:
    // (month − start + 1) / (end − start + 1) during construction, 0 before, 1 after.
    function stateAt(window, month) {
        const at = monthIndex(month), start = monthIndex(window?.start), end = monthIndex(window?.end);
        if (at === null || start === null || end === null || end < start) return BUILT;
        if (at < start) return { phase: 'planned', progress: 0 };
        if (at > end) return BUILT;
        return { phase: 'construction', progress: (at - start + 1) / (end - start + 1) };
    }

    // Every member's state; members without a window are built at every date.
    function stateMapAt(plan, month) {
        const schedule = plan?.schedule || {};
        return new Map((plan?.designCids || []).map(cid => [cid, schedule[cid] ? stateAt(schedule[cid], month) : BUILT]));
    }

    // First start and last end of a schedule (plan content or a bare { cid: window } map), or null.
    function range(planOrSchedule) {
        const schedule = planOrSchedule?.schema ? planOrSchedule.schedule : planOrSchedule;
        const windows = Object.values(schedule || {}).filter(w => monthIndex(w?.start) !== null && monthIndex(w?.end) !== null);
        if (!windows.length) return null;
        return { start: windows.map(w => w.start).sort()[0], end: windows.map(w => w.end).sort().at(-1) };
    }

    // Built floors of a building of `floors` storeys at a progress; construction shows at least the
    // ground works (0 floors) and reaches the full count only when built.
    function builtFloors(floors, state) {
        const total = Number.isFinite(floors) && floors > 0 ? Math.round(floors) : 1;
        if (!state || state.phase === 'built') return total;
        if (state.phase === 'planned') return 0;
        return Math.min(total, Math.floor(total * state.progress));
    }

    // The bars of a Gantt strip: each window's offset and width as shares of the whole range.
    function bars(schedule, order = Object.keys(schedule || {})) {
        const span = range(schedule);
        if (!span) return [];
        const first = monthIndex(span.start), months = monthIndex(span.end) - first + 1;
        return order.filter(cid => schedule[cid]).map(cid => ({ cid, start: schedule[cid].start, end: schedule[cid].end,
            offset: (monthIndex(schedule[cid].start) - first) / months,
            width: (monthIndex(schedule[cid].end) - monthIndex(schedule[cid].start) + 1) / months }));
    }

    return Object.freeze({ monthIndex, monthOf, addMonths, monthsBetween, currentMonth, stateAt, stateMapAt, range, builtFloors, bars, BUILT });
});
