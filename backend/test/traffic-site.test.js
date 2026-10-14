import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTrafficSimulatorApp } from '../scripts/serve-traffic-simulator.mjs';

const require = createRequire(import.meta.url);
const trafficDir = new URL('../../frontend/traffic/', import.meta.url);
const html = readFileSync(new URL('index.html', trafficDir), 'utf8');
const pageScript = readFileSync(new URL('traffic.js', trafficDir), 'utf8');
const favicon = readFileSync(new URL('favicon.svg', trafficDir), 'utf8');
const ogImage = readFileSync(new URL('og-image.png', trafficDir));

describe('Croatian traffic simulator site', () => {
    it('serves Croatian copy without a language selector or external i18n dependency', () => {
        const copy = require('../../frontend/traffic/copy.js');
        const body = html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] || '';

        expect(html).toMatch(/<html\s+lang="hr">/i);
        expect(body).toContain('Simulator prometa u Zagrebu');
        expect(body).toContain('Zatvori traku');
        expect(body).not.toMatch(/<(?:select|button)\b[^>]*(?:language|jezik)|\bname="(?:lang|language|jezik)"/i);
        expect(body).not.toMatch(/\b(?:Choose language|Select language|Odaberite jezik|English)\b/i);
        expect(html).toContain('src="copy.js');
        expect(copy.t('traffic.title')).toBe('Simulator prometa u Zagrebu');
        expect(pageScript).toContain('window.TrafficCopy.t');
        expect(pageScript).not.toMatch(/window\.(?:i18n|i18next)|\bi18next\b/i);
        expect(html).not.toMatch(/<script\b[^>]*src="https?:\/\/[^\"]*(?:i18n|locale|translation)/i);
    });

    it('publishes canonical, Open Graph, Twitter and favicon metadata matching its assets', () => {
        expect(html).toContain('<link rel="canonical" href="https://zagreb.lol/promet/simulator/">');
        expect(html).toContain('<meta property="og:locale" content="hr_HR">');
        expect(html).toContain('<meta property="og:url" content="https://zagreb.lol/promet/simulator/">');
        expect(html).toContain('<meta property="og:image" content="https://zagreb.lol/promet/simulator/og-image.png">');
        expect(html).toContain('<meta property="og:image:width" content="1200">');
        expect(html).toContain('<meta property="og:image:height" content="630">');
        expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
        expect(html).toContain('<meta name="twitter:image" content="https://zagreb.lol/promet/simulator/og-image.png">');
        expect(html).toContain('<link rel="icon" href="favicon.svg" type="image/svg+xml">');
        expect(favicon.toString('utf8')).toMatch(/<svg\b/);
        expect(ogImage.toString('ascii', 1, 4)).toBe('PNG');
        expect(ogImage.readUInt32BE(16)).toBe(1200);
        expect(ogImage.readUInt32BE(20)).toBe(630);
    });

    it('fetches only the network API and does not expose the old static central data file', async () => {
        const fetchTargets = [...pageScript.matchAll(/\bfetch\(\s*(['"])(.*?)\1/g)].map(match => match[2]);
        expect(fetchTargets).toEqual(['/api/promet/simulator/network']);
        expect(html).not.toMatch(/(?:data\/)?central\.json(?:\.gz)?/i);

        const pool = { query: vi.fn(() => { throw new Error('static page must not query the database'); }) };
        const app = createTrafficSimulatorApp({ pool, env: {} });
        await request(app).get('/promet/simulator/data/central.json.gz').expect(404);
        expect(pool.query).not.toHaveBeenCalled();
    });
});
