// Test servers bind the default (dual-stack) address, never 127.0.0.1. supertest listens on [::]
// with an ephemeral port and then connects to 127.0.0.1, and macOS lets another process bind
// 127.0.0.1 on that same port while [::] holds it: under the parallel suite a lens test's server
// took a bets request and answered 401. With every server on [::] the OS never hands a port out twice.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function testFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(full);
        return /\.(test\.)?m?js$/.test(entry.name) ? [full] : [];
    });
}

describe('test servers', () => {
    it('never bind 127.0.0.1 explicitly', () => {
        const offenders = testFiles(TEST_DIR)
            .filter(file => file !== fileURLToPath(import.meta.url))
            .flatMap(file => readFileSync(file, 'utf8').split('\n')
                .map((line, index) => ({ line, index }))
                .filter(({ line }) => /\.listen\([^)]*['"](127\.0\.0\.1|localhost)['"]/.test(line) || /['"]--host['"],\s*['"]127\.0\.0\.1['"]/.test(line))
                .map(({ index }) => `${path.relative(TEST_DIR, file)}:${index + 1}`));
        expect(offenders).toEqual([]);
    });
});
