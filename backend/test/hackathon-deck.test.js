// Headless checks of the judge-facing pitch pages: the deck's copy and structure, its live evidence
// links, the shared X identity and that every judge page reaches the deck.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const frontend = path.resolve(import.meta.dirname, '../../frontend');
const html = fs.readFileSync(path.join(frontend, 'deck2.html'), 'utf8');
// Every pitch variant loads the one shared deck script (navigation and live metrics).
const decks = ['deck.html', 'deck2.html', 'deck3.html'].map(name => fs.readFileSync(path.join(frontend, name), 'utf8'));
const landing = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
const demo = fs.readFileSync(path.join(frontend, 'hackathon-demo.html'), 'utf8');
const actors = fs.readFileSync(path.join(frontend, 'actor-explorer.html'), 'utf8');

describe('hackathon pitch deck page', () => {
    it('keeps the judge pitch short and navigable', () => {
        expect(html.match(/data-slide="\d"/g)).toHaveLength(7);
        expect(html).toContain('Hyperstition');
        expect(html).toContain('Markets for possible cities');
        expect(html).toContain('Ideas can be believed into reality, if tools exist');
        expect(html).toContain('Humans and AI agents imagine');
        expect(html).toContain('<strong><b>REAL</b><b>PARCELS</b></strong>');
        expect(html).toContain('a multitude of designs can reference');
        expect(html).toContain('Belief is not the last stage. It is a force.');
        expect(html).toContain('Forecasting opens as soon as a design exists.');
        expect(html).toContain('Stake YES or NO as soon as the agreement is minted.');
        expect(html).toContain('No donation or pledge is required first.');
        expect(html).toContain('Visible belief focuses attention');
        expect(html).toContain('belief ↔ action');
        expect(html).not.toContain('progressing through stages');
        expect(html).toContain('concrete Schelling point');
        expect(html).toContain('Canonical parcel set');
        expect(html).toContain('Dreamers, owners, investors, forecasters, speculators');
        expect(html).toContain('With a way to coordinate, they are more than the sum of the parts.');
        expect(html).not.toContain('ONE</b><b>PARCEL');
        expect(html).not.toContain('anchored to the parcel');
        expect(html).not.toContain('no shared market');
        expect(html).not.toContain('class="pitch-index"');
        expect(html).toContain('Scale the evidence market');
        // One cache-busting token for the shared script on every deck, so a change to it reaches them all.
        const tokens = decks.map(page => page.match(/<script src="js\/hackathon-deck\.js\?v=(\d+)" defer><\/script>/)?.[1]);
        expect(tokens.every(Boolean)).toBe(true);
        expect(new Set(tokens).size).toBe(1);
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
        expect(html).toContain('The full core loop is live on Solana Devnet');
        expect(html).toContain('External verifier and paid recipe-bound oracle facts live.');
        expect(html).toContain('Court attestation → recipe check → market outcome → USDC payout');
        expect(html).toContain('Settle the first genuinely prospective court market from a later public record');
        expect(html).toContain('shared MCP interface');
        expect(html).toContain('MCP action surface');
        expect(html).toContain('more cities and autonomous agent clients');
    });

    it('names the agreement as what is minted, bet on and supported, and facts as what agents pay for (M3)', () => {
        expect(html).toContain('Prediction market and agreement support');
        expect(html).toContain('On-chain agreement state or a source-hashed court record');
        expect(html).toContain('Executed, cancelled or expired agreement account');
        expect(html).toContain('Agents pay per verified fact.');
        expect(html).not.toContain('ProposalNFT');
        expect(html).not.toContain('proposal support');
        expect(html).not.toContain('per proposal');
    });

    it('links directly to live judge evidence', () => {
        expect(html).toContain('/hackathon-demo.html');
        expect(html).toContain('https://api.urbangametheory.xyz/agent/discovery');
        expect(html).toContain('/actor-explorer.html');
    });

    it('publishes the canonical Urban Game Theory X identity across public surfaces', () => {
        for (const page of [html, landing, demo, actors]) {
            expect(page).toContain('https://x.com/UrbanGameTheory');
            expect(page).toContain('@UrbanGameTheory');
        }
        for (const page of [html, landing, demo, actors]) {
            expect(page).toContain('name="twitter:site" content="@UrbanGameTheory"');
        }
    });

    it('is directly reachable from every other judge-facing page and the main landing page', () => {
        expect(landing).toContain('href="/deck.html"');
        expect(demo).toContain('href="/deck.html"');
        expect(actors).toContain('href="/deck.html"');
        expect([landing, demo, actors].join('\n')).not.toContain('hackathon-deck.html');
    });
});
