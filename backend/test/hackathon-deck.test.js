import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const frontend = path.resolve(import.meta.dirname, '../../frontend');
const html = fs.readFileSync(path.join(frontend, 'hackathon-deck.html'), 'utf8');

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
        expect(html).toContain('External verifier live; first court-resolved USDC market settled.');
        expect(html).toContain('Court SAS → market outcome → USDC payout');
        expect(html).toContain('The future can mobilize action. It cannot declare itself true.');
        expect(html).toContain('Expose paid oracle facts to agents over x402');
    });

    it('links directly to live judge evidence', () => {
        expect(html).toContain('/hackathon-demo.html');
        expect(html).toContain('https://api.urbangametheory.xyz/agent/discovery');
        expect(html).toContain('/actor-explorer.html');
    });
});
