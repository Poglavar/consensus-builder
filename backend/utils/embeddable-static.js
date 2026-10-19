// Stored files (proposal thumbnails, uploaded images, models, metadata) are public and embedded by
// OTHER origins: the frontend on urbangametheory.xyz while the API is api.urbangametheory.xyz, a dev
// page on another port, social crawlers reading og:image. helmet's default
// `Cross-Origin-Resource-Policy: same-origin` makes browsers refuse every cross-origin <img> of such
// a file while a CORS fetch of the same bytes succeeds — which is exactly how the share dialog and
// the proposal cards came to show nothing. Mount this in front of the static handlers; JSON routes
// keep helmet's default.
export function embeddableStatic(req, res, next) {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
}
