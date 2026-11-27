// Portable code generation and immutable voting rosters. Personal labels stay in local files.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CommunityVoting = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
    const CODE_LENGTH = 15;
    const MAX_ENTRIES = 10000;
    const MAX_BATCH = 100;
    const ITERATIONS = 600000;
    const CHOICES = ['support', 'oppose', 'abstain'];
    const HASH = /^[a-f0-9]{64}$/;
    const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
    const fail = message => { throw new TypeError(message); };
    const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    function normalizeCode(value) {
        if (typeof value !== 'string' || value.length > 100) fail('Enter a voting code.');
        const code = value.toUpperCase().replace(/[\s-]/g, '');
        if (code.length !== CODE_LENGTH || [...code].some(char => !ALPHABET.includes(char))) fail('Use the fifteen letters on your voting card.');
        return code;
    }
    const formatCode = value => normalizeCode(value).match(/.{3}/g).join('-');
    function generateCode(crypto = root.crypto) {
        // Rejection sampling avoids modulo bias; never derive credentials from a person's details.
        let code = '';
        const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
        while (code.length < CODE_LENGTH) {
            for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
                if (byte < limit) code += ALPHABET[byte % ALPHABET.length];
                if (code.length === CODE_LENGTH) break;
            }
        }
        return formatCode(code);
    }
    async function codeHash(votingId, code, crypto = root.crypto) {
        if (!UUID.test(votingId)) fail('Invalid voting-list identifier.');
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizeCode(code)), 'PBKDF2', false, ['deriveBits']);
        const bytes = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS,
            salt: new TextEncoder().encode(`ugt-voting-code/v1\n${votingId}`) }, key, 256);
        return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    // v2 adds the optional household partition and ballot rule. v1 records are published on the
    // production index and immutable, so they keep validating; new voting lists are written as v2.
    const SCHEMA = 'community-voting/v2';
    const rules = () => root.CommunityBallotRules || (typeof require === 'function' ? require('./ballot-rules.js') : null);
    const eligibility = () => root.BuildingEligibility || (typeof require === 'function' ? require('../planning/eligibility.js') : null);
    const streets = () => root.StreetSegments || (typeof require === 'function' ? require('../streets/street-segments.js') : null);
    function configuration(raw) {
        if (raw == null) return null;
        const v1 = raw?.schema === 'community-voting/v1';
        const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
        if (!(v1 ? exact(raw, ['schema', 'id', 'codeHashes']) : raw?.schema === SCHEMA
            && ['schema', 'id', 'codeHashes'].every(key => keys.includes(key)) && keys.every(key => ['schema', 'id', 'codeHashes', 'households', 'longResidents', 'rule', 'eligibility', 'streetCode', 'street', 'block'].includes(key)))
            || !UUID.test(raw.id)
            || !Array.isArray(raw.codeHashes) || !raw.codeHashes.length || raw.codeHashes.length > MAX_ENTRIES
            || raw.codeHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash))
            || new Set(raw.codeHashes).size !== raw.codeHashes.length) fail('A voting list needs its ID and 1–10,000 unique code hashes.');
        const codeHashes = [...raw.codeHashes].sort();
        if (v1) return { schema: raw.schema, id: raw.id, codeHashes };
        const result = { schema: SCHEMA, id: raw.id, codeHashes };
        if (raw.households != null) {
            // A partition of the eligible codes. Canonical: each household sorted, households by their
            // first code; all households of one code is the same as no list, so it is dropped.
            const eligible = new Set(codeHashes), seen = new Set();
            if (!Array.isArray(raw.households) || raw.households.some(group => !Array.isArray(group) || !group.length
                || group.some(hash => !eligible.has(hash) || seen.has(hash) || !seen.add(hash))) || seen.size !== codeHashes.length) {
                fail('Households must group every eligible code exactly once.');
            }
            const households = raw.households.map(group => [...group].sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
            if (households.some(group => group.length > 1)) result.households = households;
        }
        // The codes of residents registered at their address for at least a rule's `longResidentYears`
        // (Create Mews para 6 (c)): a subset of the eligible codes, sorted, like households only hashes.
        if (raw.longResidents != null) {
            const eligible = new Set(codeHashes);
            if (!Array.isArray(raw.longResidents) || !raw.longResidents.length || raw.longResidents.some(hash => !eligible.has(hash))
                || new Set(raw.longResidents).size !== raw.longResidents.length) fail('Long residents must be eligible codes, each once.');
            result.longResidents = [...raw.longResidents].sort();
        }
        if (raw.rule != null) {
            if (!exact(raw.rule, ['id', 'version']) || !rules().get(raw.rule.id, raw.rule.version)) fail('Choose a ballot rule from the list.');
            result.rule = { id: raw.rule.id, version: raw.rule.version };
        }
        // A rule that covers only eligible buildings keeps the check it was created with
        // (planning/eligibility.js): which houses, each one's verdict and the source versions read.
        const required = result.rule ? rules().get(result.rule.id, result.rule.version)?.requires?.eligibility : null;
        if (raw.eligibility != null) {
            if (!required) fail('Only a ballot rule that covers eligible buildings records an eligibility check.');
            const recorded = eligibility().normalizeEvidence(raw.eligibility);
            if (recorded.set.id !== required.id || recorded.set.version !== required.version) fail('The eligibility check is for another rule set.');
            result.eligibility = recorded;
        }
        // A rule held only on a plan that complies with a street code keeps the code's check of each
        // building of the plan (planning/eligibility.js normalizeCodeEvidence).
        const requiredCode = result.rule ? rules().get(result.rule.id, result.rule.version)?.requires?.streetCode : null;
        if (raw.streetCode != null) {
            if (!requiredCode) fail('Only a ballot rule that requires a street code records a street code check.');
            let recorded;
            try { recorded = eligibility().normalizeCodeEvidence(raw.streetCode); } catch (error) { fail(error.message); }
            if (recorded.set.id !== requiredCode.id || recorded.set.version !== requiredCode.version) fail('The street code check is for another code.');
            result.streetCode = recorded;
        }
        // The street (or one segment of it, by side) whose residents vote: its name, OSM ways, the
        // segment's ends and its official id where there is one (streets/street-segments.js).
        if (raw.street != null) {
            try { result.street = streets().normaliseReference(raw.street); } catch (error) { fail(error.message); }
        }
        // The block whose residents vote (a rule with `unit: 'block'`): its plots as a parcel set, the
        // parcel source and the sorted parcel ids (a detected parcel block, or ugt_select_parcels block).
        if (raw.block != null) result.block = normaliseBlock(raw.block);
        return result;
    }
    // What a voting record still lacks for its ballot rule, checked when the agreement is saved (the
    // record itself can be built up step by step): the rule's minimum of households (`minHouseholds`),
    // the long residents a `long-resident-support` test counts, and the block a rule held on a block
    // (`unit: 'block'`) needs. Returns [{ code, ...params }], empty when nothing is missing.
    function ruleIssues(config) {
        const rule = config?.rule ? rules().get(config.rule.id, config.rule.version) : null;
        if (!rule) return [];
        const issues = [];
        const households = config.households ? config.households.length : config.codeHashes.length;
        if (Number.isInteger(rule.minHouseholds) && households < rule.minHouseholds) issues.push({ code: 'households-too-few', min: rule.minHouseholds, households });
        if (rules().needsLongResidents(rule) && !config.longResidents) issues.push({ code: 'long-residents-missing', years: rule.longResidentYears });
        if (rule.unit === 'block' && !config.block) issues.push({ code: 'block-missing' });
        return issues;
    }
    function normaliseBlock(raw) {
        if (!exact(raw, ['parcelSourceId', 'parcelIds']) || typeof raw.parcelSourceId !== 'string' || !raw.parcelSourceId || raw.parcelSourceId.length > 3507
            || !Array.isArray(raw.parcelIds) || !raw.parcelIds.length || raw.parcelIds.length > 500
            || raw.parcelIds.some(id => typeof id !== 'string' || !id || id.length > 250) || new Set(raw.parcelIds).size !== raw.parcelIds.length) {
            fail('A block is its parcel source and 1–500 distinct parcel ids.');
        }
        return { parcelSourceId: raw.parcelSourceId, parcelIds: [...raw.parcelIds].sort() };
    }
    // The household partition of local entries: codes sharing a household label are one household;
    // a code without one is a household of its own.
    function householdsOf(entries) {
        const groups = new Map();
        entries.forEach((row, index) => {
            const key = String(row.household || '').trim();
            const name = key ? `h:${key}` : `c:${index}`;
            groups.set(name, [...(groups.get(name) || []), row.codeHash]);
        });
        return [...groups.values()];
    }
    // The codes of the entries whose holders have lived at their address at least `years` (an entry's
    // `years`, a local label like its household): the voting record's `longResidents`, or null if none.
    function longResidentsOf(entries, years) {
        const long = entries.filter(row => Number.isFinite(row.years) && row.years >= years).map(row => row.codeHash).sort();
        return long.length ? long : null;
    }
    // Years at the address from a CSV cell or a local file: a whole number 0–150, or null when empty.
    function yearsOf(value) {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        const years = Number(String(value).trim());
        if (!Number.isInteger(years) || years < 0 || years > 150) fail('Years at the address must be a whole number of years.');
        return years;
    }
    // Resident rows from a CSV with Person and Household columns, and an optional Years column (years
    // at the address; header names are case-insensitive).
    function residentsCsv(text) {
        if (typeof text !== 'string') fail('The CSV needs Person and Household columns.');
        // The separator is the header's: a comma, or the semicolon or tab some spreadsheets export.
        const header = text.split(/\r?\n/, 1)[0];
        const separator = header.includes('\t') ? '\t' : header.includes(';') && !header.includes(',') ? ';' : ',';
        const rows = [];
        let row = [], cell = '', quoted = false;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (quoted) {
                if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false; else cell += char;
            } else if (char === '"') quoted = true;
            else if (char === separator) { row.push(cell); cell = ''; }
            else if (char === '\n' || char === '\r') {
                if (char === '\r' && text[i + 1] === '\n') i++;
                row.push(cell); rows.push(row); row = []; cell = '';
            } else cell += char;
        }
        if (cell || row.length) { row.push(cell); rows.push(row); }
        const [head = [], ...body] = rows.filter(r => r.some(value => value.trim()));
        const names = head.map(value => value.trim().replace(/^﻿/, '').toLowerCase());
        const person = names.indexOf('person'), household = names.indexOf('household'), years = names.indexOf('years');
        if (person < 0 || household < 0) fail('The CSV needs Person and Household columns.');
        if (!body.length || body.length > MAX_ENTRIES) fail('The CSV needs between 1 and 10,000 residents.');
        return body.map(r => ({ label: (r[person] || '').trim().replace(/^'(?=[=+@\-\t\r])/, ''),
            household: (r[household] || '').trim().replace(/^'(?=[=+@\-\t\r])/, ''), ...(years >= 0 ? { years: yearsOf(r[years]) } : {}) }))
            .map(r => { if (r.label.length > 500 || r.household.length > 500) fail('Invalid resident row.'); return r; });
    }
    // labels: strings, or { label, household } resident rows. household is a local grouping label.
    async function generateEntries(votingId, labels, crypto = root.crypto, progress = () => {}) {
        const rows = Array.isArray(labels) ? labels.map(row => typeof row === 'string' ? { label: row, household: '' } : row) : [];
        if (!rows.length || rows.length > MAX_BATCH || rows.some(row => !row || typeof row.label !== 'string' || row.label.length > 500
            || typeof (row.household ?? '') !== 'string' || (row.household || '').length > 500)) fail('Generate between 1 and 100 codes at a time.');
        const used = new Set(), entries = [];
        for (const { label, household, years = null } of rows) {
            let code;
            do { code = generateCode(crypto); } while (used.has(code));
            used.add(code);
            entries.push({ label, household: household || '', years: yearsOf(years), code, codeHash: await codeHash(votingId, code, crypto) });
            progress(entries.length, rows.length);
        }
        return entries;
    }
    function localFile(votingId, entries) {
        return { schema: 'ugt-local-voter-list/v1', votingId, entries: entries.map(({ label, household, years = null, code }) => ({ label, ...(household ? { household } : {}), ...(Number.isFinite(years) ? { years } : {}), code })) };
    }
    async function importLocalFile(raw, progress = () => {}) {
        if (!exact(raw, ['schema', 'votingId', 'entries']) || raw.schema !== 'ugt-local-voter-list/v1' || !UUID.test(raw.votingId)
            || !Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > MAX_ENTRIES) fail('Not a local voter-list file.');
        const hashes = new Set(), entries = [];
        for (const row of raw.entries) {
            // household and years are optional: a list without them has none.
            const keys = row && typeof row === 'object' ? Object.keys(row) : [];
            if (!(['label', 'code'].every(key => keys.includes(key)) && keys.every(key => ['label', 'household', 'years', 'code'].includes(key))) || typeof row.label !== 'string' || row.label.length > 500
                || typeof (row.household ?? '') !== 'string' || (row.household || '').length > 500) fail('Invalid local voter entry.');
            const code = formatCode(row.code), hash = await codeHash(raw.votingId, code);
            if (hashes.has(hash)) fail('Duplicate voting code.');
            hashes.add(hash); entries.push({ label: row.label, household: row.household || '', years: yearsOf(row.years), code, codeHash: hash });
            progress(entries.length, raw.entries.length);
        }
        return { votingId: raw.votingId, entries };
    }
    function distributionCsv(entries) {
        // Text cells cannot become executable spreadsheet formulas when the organiser opens the CSV.
        const cell = text => '"' + (/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replace(/"/g, '""') + '"';
        const years = entries.some(row => Number.isFinite(row.years));
        return `Person,Household,${years ? 'Years,' : ''}Code\r\n` + entries.map(row => `${cell(row.label)},${cell(row.household || '')},${years ? `${Number.isFinite(row.years) ? row.years : ''},` : ''}${cell(row.code)}`).join('\r\n');
    }
    return { ALPHABET, CODE_LENGTH, MAX_ENTRIES, MAX_BATCH, ITERATIONS, CHOICES, HASH, UUID, SCHEMA, exact, normalizeCode, formatCode,
        generateCode, codeHash, configuration, ruleIssues, normaliseBlock, householdsOf, longResidentsOf, residentsCsv, generateEntries, localFile, importLocalFile, distributionCsv };
});
