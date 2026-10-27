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
    function configuration(raw) {
        if (raw == null) return null;
        if (!exact(raw, ['schema', 'id', 'codeHashes']) || raw.schema !== 'community-voting/v1' || !UUID.test(raw.id)
            || !Array.isArray(raw.codeHashes) || !raw.codeHashes.length || raw.codeHashes.length > MAX_ENTRIES
            || raw.codeHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash))
            || new Set(raw.codeHashes).size !== raw.codeHashes.length) fail('A voting list needs its ID and 1–10,000 unique code hashes.');
        return { schema: raw.schema, id: raw.id, codeHashes: [...raw.codeHashes].sort() };
    }
    async function generateEntries(votingId, labels, crypto = root.crypto, progress = () => {}) {
        if (!Array.isArray(labels) || !labels.length || labels.length > MAX_BATCH || labels.some(label => typeof label !== 'string' || label.length > 500)) fail('Generate between 1 and 100 codes at a time.');
        const used = new Set(), entries = [];
        for (const label of labels) {
            let code;
            do { code = generateCode(crypto); } while (used.has(code));
            used.add(code);
            entries.push({ label, code, codeHash: await codeHash(votingId, code, crypto) });
            progress(entries.length, labels.length);
        }
        return entries;
    }
    function localFile(votingId, entries) {
        return { schema: 'ugt-local-voter-list/v1', votingId, entries: entries.map(({ label, code }) => ({ label, code })) };
    }
    async function importLocalFile(raw, progress = () => {}) {
        if (!exact(raw, ['schema', 'votingId', 'entries']) || raw.schema !== 'ugt-local-voter-list/v1' || !UUID.test(raw.votingId)
            || !Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > MAX_ENTRIES) fail('Not a local voter-list file.');
        const hashes = new Set(), entries = [];
        for (const row of raw.entries) {
            if (!exact(row, ['label', 'code']) || typeof row.label !== 'string' || row.label.length > 500) fail('Invalid local voter entry.');
            const code = formatCode(row.code), hash = await codeHash(raw.votingId, code);
            if (hashes.has(hash)) fail('Duplicate voting code.');
            hashes.add(hash); entries.push({ label: row.label, code, codeHash: hash });
            progress(entries.length, raw.entries.length);
        }
        return { votingId: raw.votingId, entries };
    }
    function distributionCsv(entries) {
        // Text cells cannot become executable spreadsheet formulas when the organiser opens the CSV.
        const cell = text => '"' + (/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replace(/"/g, '""') + '"';
        return 'Person,Code\r\n' + entries.map(row => `${cell(row.label)},${cell(row.code)}`).join('\r\n');
    }
    return { ALPHABET, CODE_LENGTH, MAX_ENTRIES, MAX_BATCH, ITERATIONS, CHOICES, HASH, UUID, exact, normalizeCode, formatCode,
        generateCode, codeHash, configuration, generateEntries, localFile, importLocalFile, distributionCsv };
});
