// The publish-time thumbnail queue (thumbnails/thumbnail-queue.js) writes the thumbnail and its
// before/pair pictures into the row, and only where no thumbnail stands yet.
import { describe, expect, it, vi } from 'vitest';
import { createThumbnailQueue } from '../thumbnails/thumbnail-queue.js';

function queueWith(render) {
    const pool = { query: vi.fn(async () => ({ rowCount: 1 })) };
    const queue = createThumbnailQueue({ render, concurrency: 1 });
    return { pool, queue };
}

describe('thumbnail queue', () => {
    it('stores the three pictures of a render in one UPDATE that fills only a NULL thumbnail', async () => {
        const { pool, queue } = queueWith(async () => ({
            url: 'https://api.example/uploads/images/thumb.png', beforeUrl: 'https://api.example/uploads/images/before.png',
            pairUrl: 'https://api.example/uploads/images/pair.png', frame: { zoom: 18 }, tiles: { loaded: 4, total: 4 }, bytes: 1234
        }));
        const result = await queue.enqueue({ pool, proposal: {}, city: 'zagreb', proposalId: 42, baseUrl: 'https://api.example' });
        expect(result.url).toContain('thumb.png');
        expect(pool.query).toHaveBeenCalledTimes(1);
        const [sql, params] = pool.query.mock.calls[0];
        expect(sql).toMatch(/SET screenshot_url = \$1, screenshot_before_url = \$2, screenshot_pair_url = \$3/);
        expect(sql).toMatch(/WHERE id = \$4 AND screenshot_url IS NULL/);
        expect(params).toEqual(['https://api.example/uploads/images/thumb.png', 'https://api.example/uploads/images/before.png',
            'https://api.example/uploads/images/pair.png', 42]);
    });

    it('writes NULL before/pair pictures when a render has none, and nothing at all when there is nothing to draw', async () => {
        const bare = queueWith(async () => ({ url: 'u', frame: {}, tiles: {}, bytes: 1 }));
        await bare.queue.enqueue({ pool: bare.pool, proposal: {}, city: 'zagreb', proposalId: 7, baseUrl: 'x' });
        expect(bare.pool.query.mock.calls[0][1]).toEqual(['u', null, null, 7]);

        const nothing = queueWith(async () => null);
        expect(await nothing.queue.enqueue({ pool: nothing.pool, proposal: {}, city: 'zagreb', proposalId: 8, baseUrl: 'x' })).toBeNull();
        expect(nothing.pool.query).not.toHaveBeenCalled();
    });
});
