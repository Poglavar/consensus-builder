import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cidOfObject } from '../cid.js';
import { validateDesignContent } from '../routes/designs.js';
import { validateAgreementContent } from '../routes/agreements.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PlanRecord = require('../../frontend/js/plan-record.js');
const examples = JSON.parse(readFileSync(new URL('../agents/mcp-examples.json', import.meta.url), 'utf8'));
describe('worked MCP resources', () => {
    for (const kind of ['road', 'building', 'space', 'parcel-layout', 'urban-rule', 'agreement']) it(`carries a canonical ${kind} artifact with its actual CID`, () => {
        const example = examples[kind], content = example.untrusted.design || example.untrusted.agreement;
        expect(cidOfObject(content)).toBe(example.cid);
        if (kind === 'agreement') {
            const plan = example.untrusted.plan;
            expect(plan.cid).toBe(content.planCid);
            expect(cidOfObject(plan.content)).toBe(plan.cid);
            expect(PlanRecord.validate(plan.content)).toBeNull();
            expect(example.untrusted.designs.map(d => d.cid).sort()).toEqual(plan.content.designCids);
            expect(validateAgreementContent(content, { designCids: plan.content.designCids }).ok).toBe(true);
        } else expect(validateDesignContent(content).ok).toBe(true);
    });
});
