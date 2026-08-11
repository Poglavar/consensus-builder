// proposals/maintenance.js — one-off housekeeping over the local proposal store, run from the
// console: what is here, what to delete, what to rename.
//
// Everything destructive is DRY RUN by default and prints what it would do. Nothing deletes without
// a backup file having been written first, in the same call — the store is IndexedDB, it is the only
// copy of anything not uploaded, and "I meant the other city" is not recoverable afterwards.
(function (global) {
    'use strict';

    const store = () => (typeof global.proposalStorage !== 'undefined' ? global.proposalStorage : null);

    const currentCity = () => {
        try {
            return (global.CityConfigManager && global.CityConfigManager.getCurrentCityId)
                ? global.CityConfigManager.getCurrentCityId() : null;
        } catch (_) { return null; }
    };

    /** Proposals of one city (default: the city on screen). */
    function proposalsOf(city) {
        const s = store();
        if (!s || typeof s.getAllProposals !== 'function') return [];
        const want = city || currentCity();
        return s.getAllProposals().filter(p => !want || !p.city || String(p.city) === String(want));
    }

    const applied = (proposal) => {
        try {
            if (typeof global.isProposalCurrentlyApplied === 'function') return !!global.isProposalCurrentlyApplied(proposal);
            if (typeof global.isApplied === 'function') return !!global.isApplied(proposal);
        } catch (_) { }
        return !!(proposal && proposal.applied);
    };

    // A name carrying a content hash: "Block HR-330264-685/1#p1ggd3r1". The hash is what makes it
    // unreadable, and the cadastral id in front of it is what made it wrong — a block is many
    // parcels, so naming it after one of them names it after an arbitrary member.
    const HASHED_NAME = /#[0-9a-z]{5,}$/i;
    const isHashedName = (text) => HASHED_NAME.test(String(text || '').trim());

    // ---- naming -------------------------------------------------------------------------------

    /** Every coordinate pair in a geometry, however deeply nested. */
    function everyPoint(geometry, out) {
        if (!geometry) return out;
        const coords = geometry.type ? geometry.coordinates : geometry;
        const walk = (node) => {
            if (!Array.isArray(node)) return;
            if (typeof node[0] === 'number' && typeof node[1] === 'number') { out.push(node); return; }
            node.forEach(walk);
        };
        walk(coords);
        return out;
    }

    /** The polygons a proposal is made of — its buildings, else its footprint. */
    function shapesOf(proposal) {
        const shapes = [];
        const push = (geometry) => {
            if (!geometry) return;
            shapes.push(geometry.type === 'Feature' ? geometry.geometry : geometry);
        };
        const buildings = proposal?.geometry?.buildings || proposal?.buildingProposal?.buildings;
        if (Array.isArray(buildings) && buildings.length) buildings.forEach(push);
        if (!shapes.length) {
            push(proposal?.roadProposal?.footprint);
            push(proposal?.structureProposal?.footprint);
            push(proposal?.geometry?.footprint);
            push(proposal?.footprint);
        }
        return shapes.filter(Boolean);
    }

    // The same content address blocks are named with (parcel-arrangement.hash32, 4 characters of a
    // 0/O/1/I/L-free alphabet), over the proposal's OWN geometry. Two proposals of the same shape
    // would collide, and two proposals of the same shape are the same proposal.
    const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    function codeFor(text) {
        const arrangement = global.__parcelArrangement;
        let value = (arrangement && typeof arrangement.hash32 === 'function') ? arrangement.hash32(text) >>> 0 : 0;
        let code = '';
        for (let i = 0; i < 4; i += 1) {
            code = CODE_ALPHABET[value % CODE_ALPHABET.length] + code;
            value = Math.floor(value / CODE_ALPHABET.length);
        }
        return code;
    }

    /**
     * The new-convention name for a proposal: "<Word> <area m²>-<CODE>".
     * Null when the proposal carries no geometry to measure — renaming on a guess is worse than
     * leaving an ugly name in place.
     */
    function nameFor(proposal) {
        const shapes = shapesOf(proposal);
        if (!shapes.length) return null;
        const points = [];
        shapes.forEach(shape => everyPoint(shape, points));
        if (points.length < 3) return null;

        let area = 0;
        try {
            if (global.turf && typeof global.turf.area === 'function') {
                shapes.forEach(shape => { area += Number(global.turf.area({ type: 'Feature', properties: {}, geometry: shape })) || 0; });
            }
        } catch (_) { area = 0; }
        if (!(area > 0)) return null;

        // Sorted, so the same outline emitted from a different starting vertex still hashes alike.
        //
        // Seven decimals, because these are DEGREES straight off the proposal — about 1 cm here.
        // This shipped with two, copied from block-batch's fingerprint without noticing that its
        // rings have been projected to METRES first: two decimals is a centimetre there and 1.1 km
        // here. Every block in a neighbourhood hashed to the same string, and three unrelated ones
        // were renamed …-FAXU. The unit is the whole difference; the number looked identical.
        const fingerprint = points.map(p => `${Number(p[0]).toFixed(7)},${Number(p[1]).toFixed(7)}`).sort().join(' ');
        const word = String(proposal.title || proposal.name || 'Block').trim().split(/\s+/)[0] || 'Block';
        return `${word} ${Math.round(area)}-${codeFor(fingerprint)}`;
    }

    // ---- what is in here ----------------------------------------------------------------------

    function proposalReport(city) {
        const all = proposalsOf(city);
        const notApplied = all.filter(p => !applied(p));
        const hashed = all.filter(p => isHashedName(p.title || p.name));
        const report = {
            city: city || currentCity(),
            total: all.length,
            applied: all.length - notApplied.length,
            notApplied: notApplied.length,
            hashedNames: hashed.length
        };
        console.log('[proposals] ', report);
        console.log('[proposals] backupProposals() · deleteUnappliedProposals() · renameHashedProposals() '
            + '— all dry-run until you pass { apply: true }');
        return report;
    }

    // ---- backup -------------------------------------------------------------------------------

    /**
     * Write every proposal of a city to a downloaded JSON file. Returns the payload so a caller
     * (the delete below) can prove a backup exists before it removes anything.
     */
    function backupProposals(city) {
        const all = proposalsOf(city);
        const payload = { city: city || currentCity(), takenAt: new Date().toISOString(), count: all.length, proposals: all };
        const text = JSON.stringify(payload, null, 2);
        try {
            const blob = new Blob([text], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `proposals-${payload.city || 'city'}-${payload.takenAt.replace(/[:.]/g, '-')}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (error) {
            console.error('[proposals] backup could not be downloaded — nothing else should run', error);
            return null;
        }
        console.log(`[proposals] backed up ${all.length} proposal(s) to a download.`);
        return payload;
    }

    // ---- delete the unapplied -----------------------------------------------------------------

    /**
     * Remove every NOT-APPLIED proposal of a city. Dry run unless { apply: true }, and it always
     * writes the backup first — these exist only in this browser, so a mistake here has no undo.
     */
    function deleteUnappliedProposals(options = {}) {
        const s = store();
        if (!s || typeof s.removeProposal !== 'function') { console.error('[proposals] no store'); return null; }
        const city = options.city || currentCity();
        const doomed = proposalsOf(city).filter(p => !applied(p));

        if (!doomed.length) { console.log('[proposals] nothing unapplied to delete.'); return { deleted: 0 }; }
        if (!options.apply) {
            console.warn(`[proposals] DRY RUN — would delete ${doomed.length} unapplied proposal(s) in ${city}.`);
            // The table is a SAMPLE. Said in the caption, because a table of thirty rows under a
            // line saying three hundred is read as thirty.
            console.log(`[proposals] first ${Math.min(30, doomed.length)} of ${doomed.length}:`);
            console.table(doomed.slice(0, 30).map(p => ({ id: p.proposalId, title: p.title || p.name, type: p.type })));
            if (doomed.length > 30) console.log(`[proposals] …and ${doomed.length - 30} more not shown.`);
            console.warn('[proposals] deleteUnappliedProposals({ apply: true }) to do it. A backup downloads first.');
            return { wouldDelete: doomed.length, deleted: 0 };
        }

        // Backup BEFORE, in the same call. Not a suggestion in a comment — a step that must succeed.
        const backup = backupProposals(city);
        if (!backup) { console.error('[proposals] backup failed; nothing deleted.'); return null; }

        // One persist for the whole run. removeProposal saves on every call, and three hundred
        // saves of one blob is both slow and a way for an early write to land after a late one.
        const batched = typeof s.beginBatch === 'function' && typeof s.endBatch === 'function';
        if (batched) s.beginBatch();
        const before = proposalsOf(city).length;
        const refused = [];
        try {
            doomed.forEach(p => {
                const key = p.proposalId || p.id;
                try {
                    // removeProposal returns the removed RECORD or null — not a boolean — and it
                    // returns null when it cannot resolve the id at all. Collect those by name.
                    if (!s.removeProposal(key)) refused.push({ id: key, title: p.title || p.name, why: 'id did not resolve' });
                } catch (error) {
                    refused.push({ id: key, title: p.title || p.name, why: String((error && error.message) || error) });
                }
            });
        } finally {
            if (batched) s.endBatch();
        }

        // Count what is LEFT, rather than trusting the tally the loop kept. A delete that silently
        // resolved nothing looks identical to a successful one from inside the loop.
        const after = proposalsOf(city).length;
        const deleted = before - after;
        console.log(`[proposals] ${city}: ${before} → ${after} (${deleted} removed of ${doomed.length} unapplied). Backup downloaded.`);
        if (refused.length) {
            console.warn(`[proposals] ${refused.length} could not be removed:`);
            console.table(refused.slice(0, 30));
        }
        return { before, after, deleted, attempted: doomed.length, refused: refused.length };
    }

    // ---- rename the hashed ---------------------------------------------------------------------

    /** Replace "Block HR-…#hash" names with the "<Word> <area>-<CODE>" convention. */
    function renameHashedProposals(options = {}) {
        const s = store();
        if (!s || typeof s.setProposalName !== 'function') {
            console.error('[proposals] proposalStorage.setProposalName is unavailable');
            return null;
        }
        const city = options.city || currentCity();
        const targets = proposalsOf(city).filter(p => isHashedName(p.title || p.name));
        if (!targets.length) { console.log('[proposals] no hashed names left.'); return { renamed: 0 }; }

        const taken = new Set(proposalsOf(city).map(p => String(p.title || p.name || '')));
        const plan = [];
        const skipped = [];
        targets.forEach(p => {
            const proposed = nameFor(p);
            if (!proposed) { skipped.push({ id: p.proposalId, title: p.title || p.name, why: 'no geometry to measure' }); return; }
            let name = proposed;
            // A collision means two proposals of the same shape and area. Suffix rather than refuse,
            // so one run leaves no hashed names behind.
            let n = 2;
            while (taken.has(name)) { name = `${proposed} (${n})`; n += 1; }
            taken.add(name);
            plan.push({ id: p.proposalId, from: p.title || p.name, to: name });
        });

        if (!options.apply) {
            console.warn(`[proposals] DRY RUN — would rename ${plan.length} proposal(s)`
                + (skipped.length ? `, skipping ${skipped.length} with nothing to measure` : '') + '.');
            console.table(plan.slice(0, 30));
            if (skipped.length) console.table(skipped.slice(0, 10));
            console.warn('[proposals] renameHashedProposals({ apply: true }) to do it.');
            return { wouldRename: plan.length, skipped: skipped.length, renamed: 0 };
        }

        let renamed = 0;
        plan.forEach(entry => {
            try { if (s.setProposalName(entry.id, entry.to)) renamed += 1; } catch (error) {
                console.warn('[proposals] could not rename', entry.id, error);
            }
        });
        console.log(`[proposals] renamed ${renamed} of ${plan.length}.`
            + (skipped.length ? ` ${skipped.length} skipped for having no geometry.` : ''));
        if (typeof global.renderProposalsList === 'function') { try { global.renderProposalsList(); } catch (_) { } }
        return { renamed, skipped: skipped.length };
    }

    // A name this very namer produced: "<Word> <number>-<CODE>", where CODE is four characters of
    // the code alphabet. The alphabet has no 0, 1, I, O or L, which is what keeps the OLD timestamp
    // names ("Block 1108-0126", "Detached-houses 1008-1833") out — an HHMM almost always carries a
    // 0 or a 1.
    const CONVENTION_NAME = new RegExp(`^(.+) (\\d+)-([${CODE_ALPHABET}]{4})$`);

    /**
     * Recompute the name of every proposal already carrying a convention name, and fix the ones
     * whose code is stale.
     *
     * This exists because the first renaming pass produced codes from a fingerprint that rounded
     * DEGREES to two decimals — 1.1 km — so unrelated blocks all came out …-FAXU. Their names are
     * not wrong, but the code does not stand for the outline, which is the only reason it is there.
     *
     * The area is the discriminator. A name this namer wrote has the measured area in front of the
     * code, so "area still matches, code differs" identifies a stale code exactly, and a name whose
     * number means something else (a date) is left alone.
     */
    function regenerateProposalNames(options = {}) {
        const s = store();
        if (!s || typeof s.setProposalName !== 'function') {
            console.error('[proposals] proposalStorage.setProposalName is unavailable');
            return null;
        }
        const city = options.city || currentCity();
        const all = proposalsOf(city);

        const stale = [];
        const areaMoved = [];
        all.forEach(p => {
            const current = String(p.title || p.name || '');
            const match = CONVENTION_NAME.exec(current);
            if (!match) return;
            const proposed = nameFor(p);
            if (!proposed || proposed === current) return;
            const entry = { id: p.proposalId, from: current, to: proposed };
            // Same area, different code: written by this namer, with the old fingerprint.
            if (Number(match[2]) === Number(String(proposed).match(/ (\d+)-/)?.[1])) stale.push(entry);
            else areaMoved.push(entry);
        });

        const targets = options.includeMovedArea ? stale.concat(areaMoved) : stale;
        const before = new Set(stale.map(entry => entry.from.split('-').pop()));
        const after = new Set(stale.map(entry => entry.to.split('-').pop()));

        if (!targets.length) {
            console.log('[proposals] every convention name already matches its geometry.');
            if (areaMoved.length) {
                console.log(`[proposals] ${areaMoved.length} name(s) disagree on the AREA too — a date in `
                    + 'front of a code-shaped suffix, or geometry that moved. regenerateProposalNames'
                    + '({ includeMovedArea: true }) to rewrite those as well.');
                console.table(areaMoved.slice(0, 20));
            }
            return { renamed: 0, stale: 0, areaMoved: areaMoved.length };
        }

        if (!options.apply) {
            console.warn(`[proposals] DRY RUN — would re-code ${targets.length} name(s) in ${city}.`);
            // The point of the exercise, in one line: distinct codes where there were duplicates.
            console.log(`[proposals] codes among them: ${before.size} distinct now → ${after.size} after `
                + `(${stale.length} names).`);
            console.log(`[proposals] first ${Math.min(30, targets.length)} of ${targets.length}:`);
            console.table(targets.slice(0, 30));
            if (areaMoved.length && !options.includeMovedArea) {
                console.log(`[proposals] ${areaMoved.length} more disagree on the area too and are NOT `
                    + 'included; pass { includeMovedArea: true } if they should be.');
            }
            console.warn('[proposals] regenerateProposalNames({ apply: true }) to do it.');
            return { wouldRename: targets.length, stale: stale.length, areaMoved: areaMoved.length, renamed: 0 };
        }

        const taken = new Set(all.map(p => String(p.title || p.name || '')));
        let renamed = 0;
        targets.forEach(entry => {
            let name = entry.to;
            let n = 2;
            while (taken.has(name)) { name = `${entry.to} (${n})`; n += 1; }
            taken.add(name);
            try { if (s.setProposalName(entry.id, name)) renamed += 1; } catch (error) {
                console.warn('[proposals] could not rename', entry.id, error);
            }
        });
        console.log(`[proposals] re-coded ${renamed} of ${targets.length}. `
            + `Distinct codes: ${before.size} → ${after.size}.`);
        if (typeof global.renderProposalsList === 'function') { try { global.renderProposalsList(); } catch (_) { } }
        return { renamed, stale: stale.length, areaMoved: areaMoved.length };
    }

    global.proposalReport = proposalReport;
    global.backupProposals = backupProposals;
    global.deleteUnappliedProposals = deleteUnappliedProposals;
    global.renameHashedProposals = renameHashedProposals;
    global.regenerateProposalNames = regenerateProposalNames;
    global.__proposalMaintenance = { proposalReport, backupProposals, deleteUnappliedProposals, renameHashedProposals, regenerateProposalNames, nameFor, isHashedName };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { proposalReport, backupProposals, deleteUnappliedProposals, renameHashedProposals, regenerateProposalNames, nameFor, isHashedName };
    }
})(typeof window !== 'undefined' ? window : globalThis);
