import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { format } = require('../../frontend/js/parcels/source-progress.js');

describe('parcel source progress messages', () => {
    it('uses real decimal MB and locale-specific number formatting', () => {
        const detail = { phase: 'source-download', authority: 'Oxford', loadedBytes: 55_250_000, totalBytes: 70_000_000 };
        expect(format(detail)).toBe('Downloading Oxford… 55.3 / 70.0 MB');
        expect(format(detail, { language: 'hr' })).toBe('Downloading Oxford… 55,3 / 70,0 MB');
    });

    it('ignores unrelated progress and invalid counters', () => {
        expect(format({ done: 1, total: 2 })).toBeNull();
        expect(format({ phase: 'source-download', authority: 'Oxford', loadedBytes: 10 })).toBeNull();
        expect(format({ phase: 'source-process', authority: 'Oxford', processedFeatures: 10, totalFeatures: 5 })).toBeNull();
    });

    it.each(['en', 'es', 'hr', 'sr'])('translates every source phase in %s without leaving placeholders', language => {
        const dictionary = JSON.parse(readFileSync(new URL(`../../frontend/i18n/${language}.json`, import.meta.url), 'utf8'));
        const keys = [];
        const translate = (key, params) => {
            keys.push(key);
            const text = key.split('.').reduce((entry, part) => entry?.[part], dictionary);
            expect(typeof text, key).toBe('string');
            return text.replace(/\{\{(\w+)\}\}/g, (_match, param) => params[param]);
        };
        for (const phase of ['source-download', 'source-decompress', 'source-process', 'source-cache', 'source-prepare']) {
            const text = format({ phase, authority: 'Oxford', loadedBytes: 5e6, totalBytes: 20e6,
                processedFeatures: 250, totalFeatures: 1000 }, { language, translate });
            expect(text).not.toMatch(/undefined|\{\{|status\.messages/);
            if (phase !== 'source-prepare') expect(text).toContain('Oxford');
        }
        expect(new Set(keys).size).toBe(5);
    });
});
