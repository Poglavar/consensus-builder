// toPublicImageUrl re-anchors a stored scene image reference to the request's public base. The bug it
// fixes: image_url was persisted as an absolute URL baked from the save-time Host (http://localhost:
// <dev-port>/uploads/...), so a share link made in an earlier dev session pointed at a port no longer
// listening and rendered a broken <img>. Storing the path and resolving the origin per request heals
// both new (relative) rows and the old (stale absolute) ones.
import { describe, it, expect, afterEach } from 'vitest';
import { toPublicImageUrl } from '../routes/ai-scene.js';

const reqWithHost = (host, protocol = 'http') => ({ protocol, get: (h) => (h === 'host' ? host : undefined) });

afterEach(() => { delete process.env.PUBLIC_API_BASE_URL; });

describe('toPublicImageUrl', () => {
    it('anchors a relative path to the request host when no base is pinned', () => {
        delete process.env.PUBLIC_API_BASE_URL;
        expect(toPublicImageUrl(reqWithHost('localhost:3000'), '/uploads/images/scene-abc.jpeg'))
            .toBe('http://localhost:3000/uploads/images/scene-abc.jpeg');
    });

    it('heals a stale absolute URL from a dead dev port by re-anchoring its path', () => {
        delete process.env.PUBLIC_API_BASE_URL;
        // Saved on an old session (port 4477); now served from 3000 — keep the path, swap the origin.
        expect(toPublicImageUrl(reqWithHost('localhost:3000'), 'http://localhost:4477/uploads/images/scene-x.png'))
            .toBe('http://localhost:3000/uploads/images/scene-x.png');
    });

    it('prefers the pinned public base over the request host (prod)', () => {
        process.env.PUBLIC_API_BASE_URL = 'https://api.urbangametheory.xyz';
        expect(toPublicImageUrl(reqWithHost('internal-host:8080'), '/uploads/images/scene-y.png'))
            .toBe('https://api.urbangametheory.xyz/uploads/images/scene-y.png');
    });

    it('re-anchors a stale prod-baked URL onto the current pinned base too', () => {
        process.env.PUBLIC_API_BASE_URL = 'https://api.urbangametheory.xyz';
        expect(toPublicImageUrl(reqWithHost('x'), 'https://old.example.com/uploads/images/scene-z.png'))
            .toBe('https://api.urbangametheory.xyz/uploads/images/scene-z.png');
    });

    it('strips a trailing slash on the pinned base', () => {
        process.env.PUBLIC_API_BASE_URL = 'https://api.urbangametheory.xyz/';
        expect(toPublicImageUrl(reqWithHost('x'), '/uploads/a.png'))
            .toBe('https://api.urbangametheory.xyz/uploads/a.png');
    });

    it('adds a leading slash to a bare relative path', () => {
        delete process.env.PUBLIC_API_BASE_URL;
        expect(toPublicImageUrl(reqWithHost('localhost:3000'), 'uploads/images/scene-a.png'))
            .toBe('http://localhost:3000/uploads/images/scene-a.png');
    });

    it('passes through empty/nullish values untouched', () => {
        expect(toPublicImageUrl(reqWithHost('x'), null)).toBeNull();
        expect(toPublicImageUrl(reqWithHost('x'), '')).toBe('');
    });
});
