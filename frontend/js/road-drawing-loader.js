// Cache-busted loader for road drawing.
//
// Why this exists:
// - Our nginx config caches *.js for 1 year with `immutable`.
// - `road-drawing.js` changes frequently during development.
// - We already have a build cache token via `js/build-info.js` (`window.getCacheBustToken()`).
//
// This loader keeps the *HTML script order* intact by using `document.write` during parsing,
// while still appending a `?v=...` token so the browser fetches the updated file.
(function () {
    var token = (typeof window !== 'undefined' && typeof window.getCacheBustToken === 'function')
        ? window.getCacheBustToken()
        : String(Date.now());
    var sep = 'js/road-drawing.js'.indexOf('?') === -1 ? '?' : '&';
    document.write('<script src="js/road-drawing.js' + sep + 'v=' + encodeURIComponent(token) + '"><\/script>');
})();


