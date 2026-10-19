// Response headers for user-uploaded files served from the API origin (/uploads, /images,
// /metadata). Uploads used to be stored with a client-chosen extension, so an .html/.svg/.js file
// could exist on disk and be rendered or executed as ours. Allowlisted image/model/JSON types are
// served inline; anything else is forced to an opaque download, and nosniff stops browsers from
// guessing their way back to HTML.
import path from 'path';

const INLINE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.json', '.glb', '.gltf']);

export function isInlineUploadPath(requestPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(String(requestPath || ''));
    } catch {
        return false;
    }
    return INLINE_EXTENSIONS.has(path.extname(decoded).toLowerCase());
}

export function uploadStaticHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!isInlineUploadPath(req.path)) {
        // express.static (send) keeps a Content-Type that is already set, so this one wins.
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment');
    }
    next();
}
