import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const frontend = path.resolve(import.meta.dirname, '../../frontend');
const html = fs.readFileSync(path.join(frontend, 'hackathon-deck.html'), 'utf8');

describe('hackathon pitch deck page', () => {
    it('keeps the judge pitch short and navigable', () => {
        expect(html.match(/data-slide="\d"/g)).toHaveLength(7);
        expect(html).toContain('A market for real-world land change');
        expect(html).toContain('Ship the first externally resolved land market');
        expect(html).toContain('js/hackathon-deck.js?v=1');
    });

    it('separates live proof from the remaining evidence-binding gap', () => {
        expect(html).toContain('The core loop already runs');
        expect(html).toContain('External evidence binding is the next protocol step.');
        expect(html).toContain('Bind an external recipe to market settlement');
    });

    it('links directly to live judge evidence', () => {
        expect(html).toContain('/hackathon-demo.html');
        expect(html).toContain('https://api.urbangametheory.xyz/agent/discovery');
        expect(html).toContain('/actor-explorer.html');
    });
});
