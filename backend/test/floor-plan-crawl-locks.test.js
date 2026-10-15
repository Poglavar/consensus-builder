import { describe, it, expect } from 'vitest';
import { acquireCrawlLock, withCrawlMutation } from '../floor-plans/crawl-locks.js';

// Model PostgreSQL advisory locks closely enough to expose overlap and cleanup
// errors without a database. Each fake client represents one DB session.
function advisoryLockDb() {
    const locks = new Map();
    let nextSession = 1;

    const keyFor = (sql, args) => {
        const parts = [...sql.matchAll(/hashtext\((?:'([^']+)'|\$(\d+))\)/g)].map(([, literal, index]) =>
            literal ?? String(args[Number(index) - 1]));
        return `${parts.length === 1 ? 'single' : 'pair'}:${parts.join('|')}`;
    };
    const query = (session, sql, args = []) => {
        const acquire = /pg_(try_)?advisory_lock(_shared)?\s*\(/i.exec(sql);
        if (acquire) {
            const key = keyFor(sql, args);
            const mode = acquire[2] ? 'shared' : 'exclusive';
            const holders = locks.get(key) ?? new Map();
            const own = holders.get(session);
            const available = own?.mode === mode || [...holders].every(([owner, held]) =>
                owner === session || (mode === 'shared' && held.mode === 'shared'));
            if (!available && acquire[1]) return Promise.resolve({ rows: [{ locked: false }] });
            if (!available) return Promise.reject(new Error('blocking lock in fake DB'));
            holders.set(session, { mode, count: (own?.count ?? 0) + 1 });
            locks.set(key, holders);
            return Promise.resolve({ rows: [{ locked: true }] });
        }

        if (/pg_advisory_unlock/i.test(sql)) {
            const key = keyFor(sql, args);
            const holders = locks.get(key);
            const own = holders?.get(session);
            if (own) {
                if (own.count === 1) holders.delete(session);
                else holders.set(session, { ...own, count: own.count - 1 });
                if (!holders.size) locks.delete(key);
            }
            return Promise.resolve({ rows: [{ unlocked: Boolean(own) }] });
        }
        return Promise.resolve({ rows: [] });
    };

    return { client: () => {
        const session = nextSession++;
        return { query: (sql, args) => query(session, sql, args) };
    } };
}

describe('floor plan crawl advisory locks', () => {
    it('allows different sites to crawl concurrently and denies the same site', async () => {
        const db = advisoryLockDb();
        const releaseA = await acquireCrawlLock(db.client(), 'alpha.example');
        const clientB = db.client();
        const releaseB = await acquireCrawlLock(clientB, 'beta.example');
        await expect(acquireCrawlLock(clientB, 'alpha.example')).rejects.toThrow();
        await releaseA();
        await releaseB();
    });

    it('normalizes www and case before checking site conflicts', async () => {
        const db = advisoryLockDb();
        const release = await acquireCrawlLock(db.client(), 'WWW.Example.COM');
        await expect(acquireCrawlLock(db.client(), 'example.com')).rejects.toThrow();
        await release();
    });

    it('rejects an invalid site before making any database call', async () => {
        const client = { query: () => { throw new Error('unexpected query'); } };
        await expect(acquireCrawlLock(client, 'https://user:pass@example.com/')).rejects.toThrow();
    });

    it('blocks an unscoped crawl while a site crawl is active', async () => {
        const db = advisoryLockDb();
        const scoped = await acquireCrawlLock(db.client(), 'alpha.example');
        await expect(acquireCrawlLock(db.client())).rejects.toThrow();
        await scoped();
        const unscoped = await acquireCrawlLock(db.client());
        await unscoped();
    });

    it('releases the shared gate when the site lock cannot be acquired', async () => {
        const db = advisoryLockDb();
        const holder = await acquireCrawlLock(db.client(), 'alpha.example');
        const contender = db.client();
        await expect(acquireCrawlLock(contender, 'alpha.example')).rejects.toThrow();
        await holder();
        // A leaked shared gate would keep this global exclusive lock unavailable.
        const unscoped = await acquireCrawlLock(contender);
        await unscoped();
    });

    it('releases the crawl lock after its release callback', async () => {
        const db = advisoryLockDb();
        const client = db.client();
        const release = await acquireCrawlLock(client, 'alpha.example');
        await release();
        const second = await acquireCrawlLock(db.client(), 'alpha.example');
        await second();
    });

    it('allows reentrant acquisition on one session and balances both releases', async () => {
        const db = advisoryLockDb();
        const client = db.client();
        const releaseA = await acquireCrawlLock(client, 'alpha.example');
        const releaseB = await acquireCrawlLock(client, 'alpha.example');
        await releaseA();
        await expect(acquireCrawlLock(db.client(), 'alpha.example')).rejects.toThrow();
        await releaseB();
        const afterBoth = await acquireCrawlLock(db.client(), 'alpha.example');
        await afterBoth();
    });

    it('releases the mutation lock when work throws', async () => {
        const db = advisoryLockDb();
        const client = db.client();
        await expect(withCrawlMutation(client, async () => { throw new Error('write failed'); }))
            .rejects.toThrow('write failed');
        await expect(withCrawlMutation(db.client(), async () => 'ok')).resolves.toBe('ok');
    });
});
