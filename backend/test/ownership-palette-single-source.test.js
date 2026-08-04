// The ownership-highlight palette paints the map AND the sidebar legend, so a second copy is a
// legend that can lie: styles.js held two verbatim duplicates, and changing the colour in
// ownership-highlight.js alone left parcels repainting themselves in the old one.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const frontendJs = fileURLToPath(new URL('../../frontend/js/', import.meta.url));

function jsFiles(dir) {
    return readdirSync(dir).flatMap(entry => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return entry === 'vendor' ? [] : jsFiles(path);
        return path.endsWith('.js') ? [path] : [];
    });
}

// One hue per ownership type, taken from the definition itself.
const OWNERSHIP_HUES = ['#4a90e2', '#9b59b6', '#f39c12', '#e74c3c'];

describe('ownership highlight palette', () => {
    const files = jsFiles(frontendJs);

    it('is written down in exactly one file', () => {
        OWNERSHIP_HUES.forEach(hue => {
            const holders = files.filter(path => readFileSync(path, 'utf8').includes(`fillColor: '${hue}'`));
            expect(holders.map(p => p.replace(frontendJs, ''))).toEqual(['parcels/ownership-highlight.js']);
        });
    });

    it('keeps government and private individual in different parts of the wheel', () => {
        const source = readFileSync(join(frontendJs, 'parcels/ownership-highlight.js'), 'utf8');
        const hueOf = type => (source.match(new RegExp(`'${type}':[^}]*fillColor: '(#[0-9a-f]{6})'`)) || [])[1];
        const government = hueOf('government');
        const individual = hueOf('private individual');
        expect(government).toBeTruthy();
        expect(individual).toBeTruthy();
        // Compare the dominant channel: blue-dominant vs red-dominant cannot be confused at 30% fill.
        const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
        const dominant = hex => channels(hex).indexOf(Math.max(...channels(hex)));
        expect(dominant(government)).not.toBe(dominant(individual));
    });
});
