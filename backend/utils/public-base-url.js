// The origin baked into URLs the API hands out for files it stores: proposal thumbnails, uploaded
// images, models and metadata. It comes from PUBLIC_API_BASE_URL (pinned in ecosystem.config.cjs on
// prod) and from nowhere else — never the request's Host header, which the client controls and
// which on a dev machine is whatever port that day's backend happened to listen on. When nothing is
// pinned the API returns and stores the PATH alone (`/uploads/images/<file>`), and the client
// resolves it against the backend it is already talking to (data-source.js resolveBackendAssetUrl).
// Deriving the origin from Host is what left 406 local thumbnails pointing at localhost:4583, :3000
// and :4927 long after those backends were gone.
export function publicApiBaseUrl() {
    const pinned = typeof process.env.PUBLIC_API_BASE_URL === 'string' ? process.env.PUBLIC_API_BASE_URL.trim() : '';
    return pinned ? pinned.replace(/\/+$/, '') : '';
}

// Absolute when a public base is pinned, the served path alone otherwise.
export function publicFileUrl(servedPath) {
    const clean = String(servedPath || '');
    return `${publicApiBaseUrl()}${clean.startsWith('/') ? clean : `/${clean}`}`;
}
