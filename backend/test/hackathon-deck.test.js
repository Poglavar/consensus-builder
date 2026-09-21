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
        expect(html).toContain('Possible cities lack a common path to reality');
        expect(html).toContain('REAL</b><b>PARCELS');
        expect(html).toContain('concrete Schelling point');
        expect(html).toContain('Canonical parcel set');
        expect(html).toContain('anchored to real parcels');
        expect(html).not.toContain('ONE</b><b>PARCEL');
        expect(html).not.toContain('anchored to the parcel');
        expect(html).not.toContain('no shared market');
        expect(html).toContain('Scale the evidence market');
        expect(html).toContain('js/hackathon-deck.js?v=2');
        expect(html).toContain('id="proof-attestation-count"');
        expect(html).not.toContain('<dt class="is-coral">92</dt>');
        expect(html).toContain('class="pitch-weather"');
        expect(html).toContain('pitch-weather__lightning');
        const css = fs.readFileSync(path.join(frontend, 'css/hackathon-deck.css'), 'utf8');
        expect(css).toContain('@keyframes cover-lightning-flash');
        expect(css).toContain('@keyframes cover-lightning-bolt');
        expect(css).toContain('@keyframes cover-sunrise');
        expect(css).toContain('@media (prefers-reduced-motion:reduce)');
    });

    it('shows the external resolver and first settlement as live', () => {
        expect(html).toContain('The core loop already runs');
        expect(html).toContain('External verifier and paid recipe-bound oracle facts live.');
        expect(html).toContain('Court SAS → market outcome → USDC payout');
        expect(html).toContain('Settle the first genuinely prospective court market from a later public record');
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
