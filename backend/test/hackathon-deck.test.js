import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const frontend = path.resolve(import.meta.dirname, '../../frontend');
const html = fs.readFileSync(path.join(frontend, 'deck.html'), 'utf8');
const landing = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
const demo = fs.readFileSync(path.join(frontend, 'hackathon-demo.html'), 'utf8');
const actors = fs.readFileSync(path.join(frontend, 'actor-explorer.html'), 'utf8');

describe('hackathon pitch deck page', () => {
    it('keeps the judge pitch short and navigable', () => {
        expect(html.match(/data-slide="\d"/g)).toHaveLength(7);
        expect(html).toContain('Hyperstition');
        expect(html).toContain('Markets for possible cities');
        expect(html).toContain('Scale the evidence market');
        expect(html).toContain('js/hackathon-deck.js?v=1');
    });

    it('shows the external resolver and first settlement as live', () => {
        expect(html).toContain('The core loop already runs');
        expect(html).toContain('External verifier and paid recipe-bound oracle facts live.');
        expect(html).toContain('Court SAS → market outcome → USDC payout');
        expect(html).toContain('Activate V2 and run the first genuinely prospective court market');
        expect(html).toContain('The future can mobilize action. It cannot declare itself true.');
        expect(html).toContain('11 MCP tools');
        expect(html).toContain('MCP action surface');
        expect(html).toContain('more cities and autonomous agent clients');
    });

    it('links directly to live judge evidence', () => {
        expect(html).toContain('/hackathon-demo.html');
        expect(html).toContain('https://api.urbangametheory.xyz/agent/discovery');
        expect(html).toContain('/actor-explorer.html');
    });

    it('is directly reachable from every other judge-facing page and the main landing page', () => {
        expect(landing).toContain('href="/deck.html"');
        expect(demo).toContain('href="/deck.html"');
        expect(actors).toContain('href="/deck.html"');
        expect([landing, demo, actors].join('\n')).not.toContain('hackathon-deck.html');
    });
});
