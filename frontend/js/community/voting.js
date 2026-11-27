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
            && ['schema', 'id', 'codeHashes'].every(key => keys.includes(key)) && keys.every(key => ['schema', 'id', 'codeHashes', 'households', 'rule', 'eligibility', 'street'].includes(key)))
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
        // The street (or one segment of it, by side) whose residents vote: its name, OSM ways, the
        // segment's ends and its official id where there is one (streets/street-segments.js).
        if (raw.street != null) {
            try { result.street = streets().normaliseReference(raw.street); } catch (error) { fail(error.message); }
        }
        return result;
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
    // Resident rows from a CSV with Person and Household columns (header names are case-insensitive).
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
        const person = names.indexOf('person'), household = names.indexOf('household');
        if (person < 0 || household < 0) fail('The CSV needs Person and Household columns.');
        if (!body.length || body.length > MAX_ENTRIES) fail('The CSV needs between 1 and 10,000 residents.');
        return body.map(r => ({ label: (r[person] || '').trim().replace(/^'(?=[=+@\-\t\r])/, ''),
            household: (r[household] || '').trim().replace(/^'(?=[=+@\-\t\r])/, '') }))
            .map(r => { if (r.label.length > 500 || r.household.length > 500) fail('Invalid resident row.'); return r; });
    }
    // labels: strings, or { label, household } resident rows. household is a local grouping label.
    async function generateEntries(votingId, labels, crypto = root.crypto, progress = () => {}) {
        const rows = Array.isArray(labels) ? labels.map(row => typeof row === 'string' ? { label: row, household: '' } : row) : [];
        if (!rows.length || rows.length > MAX_BATCH || rows.some(row => !row || typeof row.label !== 'string' || row.label.length > 500
            || typeof (row.household ?? '') !== 'string' || (row.household || '').length > 500)) fail('Generate between 1 and 100 codes at a time.');
        const used = new Set(), entries = [];
        for (const { label, household } of rows) {
            let code;
            do { code = generateCode(crypto); } while (used.has(code));
            used.add(code);
            entries.push({ label, household: household || '', code, codeHash: await codeHash(votingId, code, crypto) });
            progress(entries.length, rows.length);
        }
        return entries;
    }
    function localFile(votingId, entries) {
        return { schema: 'ugt-local-voter-list/v1', votingId, entries: entries.map(({ label, household, code }) => ({ label, ...(household ? { household } : {}), code })) };
    }
    async function importLocalFile(raw, progress = () => {}) {
        if (!exact(raw, ['schema', 'votingId', 'entries']) || raw.schema !== 'ugt-local-voter-list/v1' || !UUID.test(raw.votingId)
            || !Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > MAX_ENTRIES) fail('Not a local voter-list file.');
        const hashes = new Set(), entries = [];
        for (const row of raw.entries) {
            // household is optional: files saved before households existed have none.
            if (!(exact(row, ['label', 'code']) || exact(row, ['label', 'household', 'code'])) || typeof row.label !== 'string' || row.label.length > 500
                || typeof (row.household ?? '') !== 'string' || (row.household || '').length > 500) fail('Invalid local voter entry.');
            const code = formatCode(row.code), hash = await codeHash(raw.votingId, code);
            if (hashes.has(hash)) fail('Duplicate voting code.');
            hashes.add(hash); entries.push({ label: row.label, household: row.household || '', code, codeHash: hash });
            progress(entries.length, raw.entries.length);
        }
        return { votingId: raw.votingId, entries };
    }
    function distributionCsv(entries) {
        // Text cells cannot become executable spreadsheet formulas when the organiser opens the CSV.
        const cell = text => '"' + (/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replace(/"/g, '""') + '"';
        return 'Person,Household,Code\r\n' + entries.map(row => `${cell(row.label)},${cell(row.household || '')},${cell(row.code)}`).join('\r\n');
    }
    return { ALPHABET, CODE_LENGTH, MAX_ENTRIES, MAX_BATCH, ITERATIONS, CHOICES, HASH, UUID, SCHEMA, exact, normalizeCode, formatCode,
        generateCode, codeHash, configuration, householdsOf, residentsCsv, generateEntries, localFile, importLocalFile, distributionCsv };
});
