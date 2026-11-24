import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const read = path => readFileSync(new URL('../../frontend/' + path, import.meta.url), 'utf8');
const markup = read('lens.html');
const walkthrough = read('js/lens-walkthrough.js');
const source = [markup, walkthrough, ...['lens-console', 'lens-picker', 'agreement-panel'].map(name => read('js/' + name + '.js'))].join('\n');
const keys = new Set(Array.from(source.matchAll(/\b(lensWalk|lensActivity)\.(\w+)/g), match => match[0]));
for (const [, key] of walkthrough.matchAll(/\bw\('([\w]+)'/g)) keys.add('lensWalk.' + key);
const en = JSON.parse(read('i18n/en.json'));

describe('public lens activity copy', () => {
    for (const language of ['en', 'ar', 'es', 'fr', 'hr', 'kk', 'pt', 'ru', 'sr']) {
        it('provides the public labels and statement placeholders in ' + language, () => {
            const locale = JSON.parse(read('i18n/' + language + '.json'));
            for (const path of keys) {
                const [section, key] = path.split('.');
                const value = locale[section]?.[key];
                expect(value, path).toBeTypeOf('string');
                expect(value.trim(), path).not.toBe('');
                expect((value.match(/{{\w+}}/g) || []).sort(), path).toEqual((en[section][key].match(/{{\w+}}/g) || []).sort());
            }
        });
    }
});
