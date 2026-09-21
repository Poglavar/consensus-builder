// Static documentation checks keep the public guides aligned with the app's immutable-proposal lifecycle.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const frontendPath = fileURLToPath(new URL('../../frontend/', import.meta.url));
const readFrontend = (name) => readFileSync(`${frontendPath}${name}`, 'utf8');

describe('public product guides', () => {
    it.each(['how-to-use.html', 'kako-koristiti.html'])('%s explains the current proposal lifecycle', (name) => {
        const html = readFrontend(name);

        expect(html).toContain('site-intro-parcels.webp');
        expect(html).toMatch(/Fork proposal|Razgranaj prijedlog/);
        expect(html).toMatch(/local\s+proposal is created and applied|lokalni prijedlog koji je već primijenjen/);
        expect(html).toMatch(/source stays unchanged|Izvor ostaje netaknut/);
        expect(html).not.toMatch(/map doesn't change until|karta se ne mijenja dok/);
        expect(html).not.toMatch(/id="drafts"|id="skice"/);
    });

    it.each(['how-to-use-road.html', 'kako-koristiti-cesta.html'])('%s describes finished roads as proposals', (name) => {
        const html = readFrontend(name);

        expect(html).toMatch(/creates a local proposal and applies it immediately|stvara lokalni prijedlog i odmah ga primjenjuje/);
        expect(html).not.toMatch(/built road is not yet a proposal|Izgrađena cesta još nije prijedlog/);
    });

    it('uses capability horizons instead of expired roadmap dates', () => {
        const html = readFrontend('roadmap.html');

        expect(html).toContain('id="now"');
        expect(html).toContain('id="next"');
        expect(html).toContain('id="later"');
        expect(html).not.toMatch(/Oct 2024|Dec 2025|Jun 2026/);
    });
});
