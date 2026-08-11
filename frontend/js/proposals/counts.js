// proposals/counts.js — how many proposals there ARE, for the sidebar button.
//
// The list has three tabs (Local / Server / Blockchain), but they are three VIEWS of overlapping
// sets, not three sets: Blockchain is the minted subset of Local, and every uploaded local proposal
// is also a row on the server. Adding the tabs would count one proposal up to three times, so the
// button shows their UNION — the server's own total plus the local records that were never uploaded.
//
// Pure and DOM-free so node can test it; the browser gets window.__proposalCounts (UMD).

(function (global) {
    'use strict';

    /** Union of the three tabs.
        @param {Array<{onServer?: boolean}>} local  local records; onServer = has a server serial,
               so the server total already counts it (and a minted one is in here either way).
        @param {number|null} serverCount  the server's own total for this city; null/unknown means
               the server has not answered, and then local is all we honestly know. */
    function unionProposalCount(local, serverCount) {
        const list = Array.isArray(local) ? local : [];
        const total = (typeof serverCount === 'number' && Number.isFinite(serverCount) && serverCount >= 0)
            ? Math.floor(serverCount)
            : null;
        if (total === null) return list.length;
        return total + list.filter(entry => !(entry && entry.onServer)).length;
    }

    /** Je li serverski broj dovoljno star da ga vrijedi ponovno pitati.
        Nikad pitan (0/null) je uvijek zastario — inače bi prvi prikaz sekcije šutio. */
    function serverCountIsStale(refreshedAt, now, maxAgeMs) {
        if (typeof refreshedAt !== 'number' || !Number.isFinite(refreshedAt) || refreshedAt <= 0) return true;
        if (typeof now !== 'number' || !Number.isFinite(now)) return true;
        const maxAge = (typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs >= 0) ? maxAgeMs : 0;
        return (now - refreshedAt) >= maxAge;
    }

    const api = { unionProposalCount, serverCountIsStale };
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') global.__proposalCounts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
