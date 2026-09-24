// Locale coverage: every translation key the frontend references literally must exist in all four
// locales (i18n.t returns the KEY when one is missing, so a gap renders as "modal.common.close"
// instead of text and `t(k) || 'fallback'` never fires). Also guards locale values against Cyrillic
// look-alike letters mixed into Latin words (sr.json once had "Primеnjeno" with a Cyrillic е).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const LANGS = ['en', 'hr', 'es', 'sr'];
const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

// Keys assembled at runtime (`prefix.${value}`) cannot be checked statically. Each such prefix must be
// listed here on purpose; a new dynamic call site with an unlisted prefix fails the test.
const DYNAMIC_KEY_PREFIXES = [
    'alerts.messages.',
    'gameDialogs.log.',
    'gameDialogs.log.row.',
    'modal.corridor.compass.',
    'modal.corridor.laneTypes.',
    'modal.corridor.presetWidths.',
    'modal.corridorStructure.kinds.',
    'modal.createProposal.missingParcels.',
    'modal.roadWidth.proposalList.filters.goals.',
    'modal.roadWidth.proposalList.goalLabels.',
    'modal.roadWidth.proposalList.sort.',
    'modal.roadWidth.proposalList.typeLabels.',
    'modal.singleBuilding.',
    'panel.parcel.ownershipType.',
    'proposalDrafts.validation.issues.',
    'proposals.roadDesignation.',
    'rowHouses.modal.',
    'sidebar.proposals.grainScore.',
    'status.messages.'
];

// Helpers that prepend a namespace to the key they are given, per file.
const PREFIXING_HELPERS = {
    'js/structure-geometry-editor.js': { fn: 't', prefix: 'structureEditor.' }
};

// Call names that take a dotted string first but are not translation lookups.
const NON_TRANSLATION_CALL = /(^|\.)(add|set|get|has|delete|includes|startsWith|endsWith|indexOf|querySelector|querySelectorAll|getElementById|getItem|setItem|removeItem|require|fetch|log|warn|error|info|debug)$/;

function flatten(node, prefix = '', out = {}) {
    for (const [k, v] of Object.entries(node)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out[key] = v;
    }
    return out;
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'vendor', 'lib', 'i18n', 'contracts'].includes(entry.name)) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (/\.(js|html)$/.test(entry.name) && !/\.min\./.test(entry.name)) out.push(p);
    }
    return out;
}

const locales = Object.fromEntries(LANGS.map(lang => [
    lang,
    flatten(JSON.parse(fs.readFileSync(path.join(FRONTEND, 'i18n', `${lang}.json`), 'utf8')))
]));

// i18n.js ships a small built-in table (language switcher labels) that the JSON files extend.
const inlineKeys = new Set(
    [...fs.readFileSync(path.join(FRONTEND, 'js/i18n.js'), 'utf8').matchAll(/'(language\.[\w.]+)'\s*:/g)].map(m => m[1])
);

const namespaces = new Set([...Object.keys(JSON.parse(fs.readFileSync(path.join(FRONTEND, 'i18n/en.json'), 'utf8'))), 'language', 'tools']);

function hasKey(table, key) {
    if (inlineKeys.has(key)) return true;
    if (key in table) return true;
    return PLURAL_FORMS.some(form => `${key}.${form}` in table);
}

function scanFrontend() {
    const literal = new Map();
    const dynamic = new Map();
    const record = (map, key, where) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(where);
    };
    const callRe = /([A-Za-z_$][\w$.]*)\(\s*(['"])([A-Za-z][\w-]*(?:\.[\w-]+)+)\2\s*[,)]/g;
    const templateRe = /([A-Za-z_$][\w$.]*)\(\s*`([A-Za-z][\w-]*(?:\.[\w-]+)*\.)\$\{/g;
    const attrRe = /data-i18n-key=["']([A-Za-z][\w-]*(?:\.[\w-]+)+)["']/g;

    for (const file of walk(FRONTEND)) {
        const rel = path.relative(FRONTEND, file);
        const src = fs.readFileSync(file, 'utf8');
        const lineOf = index => src.slice(0, index).split('\n').length;
        const prefixing = PREFIXING_HELPERS[rel];
        for (const m of src.matchAll(callRe)) {
            const [, fn, , rawKey] = m;
            if (NON_TRANSLATION_CALL.test(fn)) continue;
            const key = prefixing && fn === prefixing.fn ? prefixing.prefix + rawKey : rawKey;
            if (!namespaces.has(key.split('.')[0])) continue;
            record(literal, key, `${rel}:${lineOf(m.index)}`);
        }
        for (const m of src.matchAll(attrRe)) record(literal, m[1], `${rel}:${lineOf(m.index)}`);
        for (const m of src.matchAll(templateRe)) {
            const [, fn, prefix] = m;
            if (NON_TRANSLATION_CALL.test(fn)) continue;
            if (!namespaces.has(prefix.split('.')[0])) continue;
            record(dynamic, prefix, `${rel}:${lineOf(m.index)}`);
        }
    }
    return { literal, dynamic };
}

const { literal, dynamic } = scanFrontend();

describe('i18n locale coverage', () => {
    it('finds a realistic number of literal keys (the scanner itself works)', () => {
        expect(literal.size).toBeGreaterThan(1000);
        expect(literal.has('panel.parcel.nft.checkFailedRetry')).toBe(true);
        expect(literal.has('structureEditor.tools.tree')).toBe(true);
    });

    for (const lang of LANGS) {
        it(`every literal key used in frontend code exists in ${lang}.json`, () => {
            const missing = [...literal.entries()]
                .filter(([key]) => !hasKey(locales[lang], key))
                .map(([key, where]) => `${key}  (${where.slice(0, 2).join(', ')})`);
            expect(missing).toEqual([]);
        });
    }

    it('every dynamic key prefix is explicitly allowlisted', () => {
        const unlisted = [...dynamic.entries()]
            .filter(([prefix]) => !DYNAMIC_KEY_PREFIXES.includes(prefix))
            .map(([prefix, where]) => `${prefix}  (${where[0]})`);
        expect(unlisted).toEqual([]);
    });

    it('every allowlisted dynamic prefix names a real subtree of en.json', () => {
        const dead = DYNAMIC_KEY_PREFIXES.filter(prefix => !Object.keys(locales.en).some(key => key.startsWith(prefix)));
        expect(dead).toEqual([]);
    });

    it('every en key exists in hr, es and sr', () => {
        for (const lang of ['hr', 'es', 'sr']) {
            const missing = Object.keys(locales.en).filter(key => !hasKey(locales[lang], key)
                // a plural form another language does not need (en one/other vs hr one/few/other)
                && !PLURAL_FORMS.some(form => key.endsWith(`.${form}`) && hasKey(locales[lang], key.slice(0, -form.length - 1))));
            expect({ lang, missing }).toEqual({ lang, missing: [] });
        }
    });
});

describe('i18n locale scripts', () => {
    const mixedWord = value => String(value).split(/[^\p{L}]+/u)
        .filter(word => /\p{Script=Cyrillic}/u.test(word) && /\p{Script=Latin}/u.test(word));

    it('detects a Cyrillic look-alike inside a Latin word', () => {
        expect(mixedWord('Primеnjeno')).toEqual(['Primеnjeno']);
        expect(mixedWord('Primenjeno')).toEqual([]);
    });

    for (const lang of LANGS) {
        it(`${lang}.json has no word mixing Cyrillic and Latin letters`, () => {
            const bad = Object.entries(locales[lang])
                .filter(([, value]) => typeof value === 'string' && mixedWord(value).length)
                .map(([key, value]) => `${key}: ${mixedWord(value).join(', ')}`);
            expect(bad).toEqual([]);
        });
    }
});
