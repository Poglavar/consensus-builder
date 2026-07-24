// The obsolete split migration must stay inert so it cannot recreate server-side map visibility.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RETIREMENT_MESSAGE } from '../scripts/split-status-applied.js';

const scriptPath = fileURLToPath(new URL('../scripts/split-status-applied.js', import.meta.url));

describe('retired split-status-applied migration', () => {
    it('points operators to the local-state cleanup migration', () => {
        expect(RETIREMENT_MESSAGE).toContain('browser-local state');
        expect(RETIREMENT_MESSAGE).toContain('remove-server-applied.js');
    });

    it('contains no SQL that can add or write an applied column', () => {
        const source = readFileSync(scriptPath, 'utf8');
        expect(source).not.toMatch(/ADD\s+COLUMN[^;]*\bapplied\b/i);
        expect(source).not.toMatch(/SET\s+applied\s*=/i);
    });
});
