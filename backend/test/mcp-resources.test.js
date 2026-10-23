import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cidOfObject } from '../cid.js';
import { validateDesignContent } from '../routes/designs.js';
import { validateAgreementContent } from '../routes/agreements.js';
const examples = JSON.parse(readFileSync(new URL('../agents/mcp-examples.json', import.meta.url), 'utf8'));
describe('worked MCP resources', () => {
    for (const kind of ['road', 'building', 'space', 'parcel-layout', 'urban-rule', 'agreement']) it(`carries a canonical ${kind} artifact with its actual CID`, () => {
        const example = examples[kind], content = example.untrusted.design || example.untrusted.agreement;
        expect(cidOfObject(content)).toBe(example.cid);
        expect((kind === 'agreement' ? validateAgreementContent : validateDesignContent)(content).ok).toBe(true);
        if (kind === 'agreement') expect(example.untrusted.designs.map(d => d.cid)).toEqual(content.designs.map(d => d.cid));
    });
});
