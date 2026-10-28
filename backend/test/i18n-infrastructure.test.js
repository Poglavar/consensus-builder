// Keep translations in language files and validate dictionary structure, placeholders and registry parity.
import { readFileSync, readdirSync } from 'node:fs';
import { parseExpression } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { dictionary, testI18n } from './helpers/i18n.js';

const root = new URL('../../frontend/', import.meta.url);
const api = testI18n();
const languages = api.getSupportedLanguages();
function flatten(node, prefix = '', output = {}) {
    for (const [key, value] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object') flatten(value, path, output);
        else output[path] = value;
    }
    return output;
}
function scriptFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
        return entry.isDirectory() ? scriptFiles(url) : /\.(js|mjs)$/.test(entry.name) ? [url] : [];
    });
}
const placeholders = value => [...new Set([...value.matchAll(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g)].map(match => match[1] || match[2]))].sort();

describe('translation infrastructure', () => {
    it('has exactly one dictionary file for each registered language', () => {
        expect(readdirSync(new URL('i18n/', root)).filter(file => file.endsWith('.json')).sort())
            .toEqual(languages.map(lang => `${lang}.json`).sort());
        const choices = api.getLocaleChoices();
        expect(choices.map(choice => choice.locale)).toEqual(api.getSupportedLocales());
        for (const choice of choices) {
            expect(api.t(choice.key)).not.toBe(choice.key);
            expect(choice.name).toBeTruthy();
        }
    });

    it.each(languages)('%s contains only strings, with no duplicate or ambiguous keys', language => {
        const ast = parseExpression(readFileSync(new URL(`i18n/${language}.json`, root), 'utf8'));
        function inspect(node) {
            expect(node.type).toBe('ObjectExpression');
            const keys = node.properties.map(property => property.key.value);
            expect(new Set(keys).size).toBe(keys.length);
            for (const property of node.properties) {
                expect(property.key.value).not.toMatch(/\.|^__proto__$|^prototype$|^constructor$/);
                if (property.value.type === 'ObjectExpression') inspect(property.value);
                else expect(property.value.type).toBe('StringLiteral');
            }
        }
        inspect(ast);
    });

    it.each(languages.filter(lang => lang !== 'en'))('%s preserves interpolation parameters', language => {
        const english = flatten(dictionary('en')), selected = flatten(dictionary(language));
        const mismatches = Object.keys(english).filter(key => selected[key] !== undefined
            && JSON.stringify(placeholders(english[key])) !== JSON.stringify(placeholders(selected[key])));
        expect(mismatches).toEqual([]);
    });

    it('keeps multilingual tables and runtime registration out of feature scripts', () => {
        const badTables = [], registrations = [];
        for (const file of scriptFiles(new URL('js/', root))) {
            const source = readFileSync(file, 'utf8');
            const localeTables = languages.filter(lang => new RegExp(`(?:["']${lang}["']|\\b${lang})\\s*:\\s*\\{`).test(source));
            if (localeTables.length > 1) badTables.push(file.pathname.split('/frontend/')[1]);
            if (/\.registerTranslations\s*\(/.test(source)) registrations.push(file.pathname.split('/frontend/')[1]);
        }
        expect(badTables).toEqual([]);
        expect(registrations).toEqual(['js/i18n-loader.js']);
    });
});
