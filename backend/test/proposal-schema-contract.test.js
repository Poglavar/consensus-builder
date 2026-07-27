// Static contract for the proposal DDL. This catches schema drift without requiring a live Postgres
// instance and protects the separation between shared lifecycle and browser-local map visibility.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIFECYCLE_STATUSES } from '../proposals/lifecycle.js';

const ddlPath = fileURLToPath(new URL('../routes/proposals-ddl.sql', import.meta.url));
const ddl = readFileSync(ddlPath, 'utf8');
const tableDefinition = ddl.match(/CREATE TABLE IF NOT EXISTS proposal\s*\(([\s\S]*?)\n\);/i)?.[1] || '';

describe('proposal schema contract', () => {
    it('defines the singular proposal table with one proposal-id uniqueness constraint', () => {
        expect(tableDefinition).not.toBe('');
        expect(ddl).not.toMatch(/CREATE TABLE IF NOT EXISTS proposals\b/i);
        expect(tableDefinition.match(/UNIQUE\s*\(proposal_id\)/gi) || []).toHaveLength(1);
        const proposalIdColumn = tableDefinition
            .split('\n')
            .find(line => /^\s*proposal_id\b/i.test(line))
            ?.split('--')[0] || '';
        expect(proposalIdColumn).not.toMatch(/\bUNIQUE\b/i);
    });

    it('stores lifecycle only and keeps applied state out of the server schema', () => {
        expect(tableDefinition).toMatch(/lifecycle_status\s+VARCHAR\(50\)\s+NOT NULL\s+DEFAULT 'Active'/i);
        expect(tableDefinition).not.toMatch(/^\s*applied\b/im);
        expect(tableDefinition).not.toMatch(/^\s*status\b/im);
    });

    it('uses the same lifecycle enum as the application contract', () => {
        const check = tableDefinition.match(/CHECK\s*\(lifecycle_status\s+IN\s*\(([^)]+)\)\)/i)?.[1] || '';
        const statuses = [...check.matchAll(/'([^']+)'/g)].map(match => match[1]);
        expect(statuses).toEqual(LIFECYCLE_STATUSES);
    });
});
