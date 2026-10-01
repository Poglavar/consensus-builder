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

    it('requires a cadastral declaration or a site, and no ancestry column', () => {
        expect(tableDefinition).not.toMatch(/^\s*ancestor_parcel_ids\b/im);
        expect(tableDefinition).toMatch(/^\s*cadastre_parcel_ids\s+JSONB\s+NOT NULL/im);
        expect(tableDefinition).toMatch(/^\s*site\s+geometry\(MultiPolygon,\s*4326\)/im);
        expect(tableDefinition).toMatch(/^\s*binding\s+JSONB/im);
        expect(tableDefinition).not.toMatch(/proposal_cadastre_parcel_ids_nonempty/i);
        expect(tableDefinition).toMatch(/proposal_cadastre_parcel_ids_or_site/i);
        expect(tableDefinition).toMatch(/jsonb_array_length\(cadastre_parcel_ids\)\s*>\s*0\s+OR\s+site IS NOT NULL/i);
        expect(tableDefinition).toMatch(/proposal_cadastre_declaration_matches_record/i);
        expect(tableDefinition).toMatch(/proposal_data->'cadastreParcelIds'\s*=\s*cadastre_parcel_ids/i);
    });

    // The deployable migration for existing tables: only ALTERs (an unqualified CREATE TABLE would
    // shadow the live consensus.proposal), re-runnable, the same CHECK as the table definition, and
    // listed in deploy-backend.sh so it reaches the server before the code that writes site/binding.
    it('ships the site/binding columns as a re-runnable ALTER-only DDL in the deploy list', () => {
        const siteDdl = readFileSync(fileURLToPath(new URL('../routes/proposal-site-ddl.sql', import.meta.url)), 'utf8');
        const statements = siteDdl.replace(/--.*$/gm, '');
        expect(statements).not.toMatch(/CREATE\s+TABLE/i);
        expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS site geometry\(MultiPolygon, 4326\)/);
        expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS binding JSONB/);
        expect(statements).toMatch(/DROP CONSTRAINT IF EXISTS proposal_cadastre_parcel_ids_nonempty/);
        expect(statements).toMatch(/DROP CONSTRAINT IF EXISTS proposal_cadastre_parcel_ids_or_site;\s*ALTER TABLE proposal ADD CONSTRAINT proposal_cadastre_parcel_ids_or_site/);
        expect(statements).toMatch(/jsonb_array_length\(cadastre_parcel_ids\) > 0 OR site IS NOT NULL/);
        expect(statements).toMatch(/CREATE INDEX IF NOT EXISTS idx_proposal_site/);
        const deploy = readFileSync(fileURLToPath(new URL('../deploy-backend.sh', import.meta.url)), 'utf8');
        const list = deploy.match(/DDL_FILES=\(([\s\S]*?)\)/)?.[1] || '';
        expect(list).toMatch(/routes\/proposal-site-ddl\.sql/);
        expect(list).not.toMatch(/routes\/proposals-ddl\.sql/);
    });
});
