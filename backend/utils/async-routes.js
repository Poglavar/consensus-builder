// Makes every async route handler's rejection reach Express's error handler.
//
// Express 4 calls a handler and ignores what it returns, so a rejected promise from an `async`
// handler is an UNHANDLED REJECTION — and on Node 15+ that exits the process. One malformed query
// string (`?city=a&city=b` → `.trim is not a function`) was therefore enough to take the whole API
// down. Rather than trusting every handler to wrap itself in try/catch, createApp() patches the
// registration methods once, before any route is added, so each handler's promise is caught and
// forwarded with next(err).

const REGISTRATION_METHODS = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

function forwardRejection(result, next) {
    if (result && typeof result.then === 'function') {
        result.then(undefined, next);
    }
}

function wrapHandler(fn) {
    if (typeof fn !== 'function') return fn;
    // Mounted sub-apps and routers are dispatched by Express itself (it detects them by these
    // properties), so wrapping them would break mounting; their own handlers are theirs to wrap.
    if (typeof fn.handle === 'function' || Array.isArray(fn.stack)) return fn;
    // Arity is how Express tells error middleware (4 args) from request middleware — keep it.
    if (fn.length === 4) {
        return function asyncErrorMiddleware(err, req, res, next) {
            forwardRejection(fn.call(this, err, req, res, next), next);
        };
    }
    return function asyncMiddleware(req, res, next) {
        forwardRejection(fn.call(this, req, res, next), next);
    };
}

function wrapArgs(args) {
    return args.map(arg => (Array.isArray(arg) ? wrapArgs(arg) : wrapHandler(arg)));
}

export function forwardAsyncErrors(app) {
    if (app.__asyncErrorsForwarded) return app;
    for (const method of REGISTRATION_METHODS) {
        const original = app[method];
        if (typeof original !== 'function') continue;
        app[method] = function registerWithAsyncErrors(...args) {
            // app.get('setting') is the settings getter, not a route.
            if (method === 'get' && args.length === 1) return original.apply(this, args);
            return original.apply(this, wrapArgs(args));
        };
    }
    app.__asyncErrorsForwarded = true;
    return app;
}
