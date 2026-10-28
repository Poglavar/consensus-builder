// Isolate persisted preview fixtures and remove their private files after each test.
import { afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewLinks } from '../../agents/mcp-preview-links.js';
const fixtures = [];
afterEach(() => {
    for (const { store, directory } of fixtures.splice(0)) {
        store.dispose(); rmSync(directory, { recursive: true, force: true });
    }
});
export function createTestPreviewLinks(options) {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-preview-fixture-'));
    const store = createPreviewLinks({ ...options, storeDirectory: directory });
    fixtures.push({ store, directory }); return store;
}
