import path from 'node:path';

// Old experimental collaboration files and private MCP previews must never pass through static uploads.
export function privateUploadGuard(req, res, next) {
    let pathname;
    try { pathname = path.posix.normalize(decodeURIComponent(req.path)); }
    catch { return res.sendStatus(400); }
    if (pathname.split('/')[1]?.toLowerCase() === 'mcp-drafts') return res.sendStatus(404);
    next();
}
