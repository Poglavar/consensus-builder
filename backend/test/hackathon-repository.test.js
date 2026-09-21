// Judge-facing repository contract: licensing and protocol documentation must remain discoverable
// from the root and must name the same deployed programs as the checked-in Solana workspace.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const PROGRAMS = [
    '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
    '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
    'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB',
    '1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g'
];

describe('hackathon repository documentation', () => {
    it('ships a repository-level Apache-2.0 license', () => {
        const license = read('LICENSE');
        expect(license).toContain('Apache License');
        expect(license).toContain('Version 2.0, January 2004');
        expect(license).toContain('Copyright 2026 Urban Game Theory contributors');
    });

    it('links the build, architecture, protocol, and scope from the root readme', () => {
        const readme = read('readme.md');
        for (const target of ['HACKATHON.md', 'docs/architecture.md', 'docs/hackathon-build.md', 'docs/protocol.md']) {
            expect(readme).toContain(target);
        }
        expect(read('docs/architecture.md')).toContain('```mermaid');
        expect(read('docs/hackathon-build.md')).toContain('npm ci');
    });

    it('documents every deployed program and a machine-readable recipe schema', () => {
        const protocol = read('docs/protocol.md');
        const anchor = read('blockchain/solana/Anchor.toml');
        for (const address of PROGRAMS) {
            expect(protocol).toContain(address);
            expect(anchor).toContain(address);
        }
        const schema = JSON.parse(read('backend/oracle/recipe.schema.json'));
        expect(schema.required).toEqual(expect.arrayContaining([
            'id', 'version', 'eventType', 'subject', 'trustedAttesters', 'outcomes', 'verification', 'hash'
        ]));
        expect(protocol).toContain('Evidence adapter interface');
        expect(protocol).toContain('Security and trust assumptions');
    });
});
