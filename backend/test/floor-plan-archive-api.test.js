// Archive page API base: production hosts use the production API; only loopback pages may redirect it.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { apiBase, PRODUCTION_API } = require('../../frontend/js/floor-plan-archive-api.js');

describe('floor-plan archive API base', () => {
    it('sends the production page to the production API, whatever ?backend= says', () => {
        expect(apiBase({ hostname: 'urbangametheory.xyz', search: '' })).toBe(PRODUCTION_API);
        expect(apiBase({ hostname: 'urbangametheory.xyz', search: '?backend=https%3A%2F%2Fevil.example' })).toBe(PRODUCTION_API);
    });

    it('lets a loopback page pick a loopback API port, and defaults to the dev API', () => {
        expect(apiBase({ hostname: 'localhost', search: '?backend=http%3A%2F%2Flocalhost%3A8472&tab=sites' })).toBe('http://localhost:8472');
        expect(apiBase({ hostname: '127.0.0.1', search: '?backend=http://127.0.0.1:8472/' })).toBe('http://127.0.0.1:8472');
        expect(apiBase({ hostname: 'localhost', search: '?backend=https%3A%2F%2Fevil.example' })).toBe('http://localhost:3000');
        expect(apiBase({ hostname: 'localhost', search: '' })).toBe('http://localhost:3000');
    });
});
