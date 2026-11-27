// Guards shared by the routes that accept uploads or pins (designs, plans, agreements, pins, images,
// models, market recipes): a per-IP rate limit on top of the global write limiter, and a disk-space
// floor for uploads stored on the API host.

import fs from 'fs';
import path from 'node:path';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// Per IP, per window, on top of the global write limiter.
export const UPLOAD_RATE_WINDOW_MS = 15 * 60 * 1000;
export const UPLOAD_RATE_MAX = 30;

// req.ip, never the CF-Connecting-IP header (forgeable by anyone reaching the origin directly):
// nginx maps Cloudflare's header to the connecting address and the app trusts that one hop. IPv6
// is bucketed to its allocation so one visitor cannot walk their /56 for a fresh allowance.
function uploadClientKey(req) {
    const address = String(req.ip || '').trim();
    return address ? ipKeyGenerator(address) : 'unknown';
}

// Uploads that land on the API host's own disk are permanent, and that disk also holds Postgres and
// the other sites on the host. Below this much free space they are refused, so a flood of uploads
// fills at most the headroom above the floor, never the disk.
export const UPLOAD_MIN_FREE_BYTES = Number(process.env.UPLOAD_MIN_FREE_BYTES || 10 * 1024 ** 3);

function uploadFilesystem(dir, statfs) {
    try {
        return statfs(dir);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // On the first upload the route creates uploads/ inside this existing directory.
        return statfs(path.dirname(dir));
    }
}

/**
 * Middleware refusing an upload (507) when the filesystem holding `dir` has less than `minFreeBytes`
 * free. `statfs` is injectable for tests.
 */
export function requireUploadDiskHeadroom(dir, { minFreeBytes = UPLOAD_MIN_FREE_BYTES, statfs = fs.statfsSync } = {}) {
    return (req, res, next) => {
        let free;
        try {
            const stats = uploadFilesystem(dir, statfs);
            free = Number(stats.bavail) * Number(stats.bsize);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Upload disk check failed for ${dir}:`, error);
            return res.status(503).json({ error: 'Uploads are unavailable right now.', code: 'upload-disk-check-failed' });
        }
        if (!(free >= minFreeBytes)) {
            console.error(`[${new Date().toISOString()}] Upload refused: ${dir} has ${free} bytes free, below the ${minFreeBytes}-byte floor.`);
            return res.status(507).json({ error: 'The server is out of upload space.', code: 'upload-disk-full' });
        }
        return next();
    };
}

/**
 * A fresh per-IP limiter for one relay route (each route gets its own budget). A refusal says when
 * the client's window resets (`retryAfterSeconds`, as the Retry-After header does), so the browser
 * can tell the user how long to wait (proposals/design-sync.js refusalMessage).
 */
export function createUploadRateLimiter({ windowMs = UPLOAD_RATE_WINDOW_MS, limit = UPLOAD_RATE_MAX } = {}) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: uploadClientKey,
        handler: (req, res) => {
            const resetAt = req.rateLimit?.resetTime;
            const retryAfterSeconds = resetAt instanceof Date
                ? Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000))
                : Math.ceil(windowMs / 1000);
            res.status(429).json({ error: 'Too many uploads, please try again later.', code: 'upload-rate-limited', retryAfterSeconds });
        }
    });
}
