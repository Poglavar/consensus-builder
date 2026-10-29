// A refused workspace is a page state: there is no editable map behind a dismissible warning.
// The page loads this in its head, right after the workspace claim, so a tab that does not own the
// saved workspace stops before the app: nothing loads, nothing is applied, only this screen shows.
// The stop waits for the first script in <body>: Chrome never paints a page whose parser was
// stopped inside <head>.
(function (root) {
    'use strict';
    const messages = {
        blocked: ['Already open in another tab'],
        unsupported: ['Update your browser to continue', 'Update this browser and reopen the page. Your saved work has not been changed.'],
        error: ['Could not open your saved work', 'Try again to reopen this workspace. Your saved work has not been replaced.']
    };
    function show(reason) {
        const state = Object.hasOwn(messages, reason) ? reason : 'error';
        const text = (key, fallback) => {
            const value = root.i18n?.t?.(key);
            return value && value !== key ? value : fallback;
        };
        const doc = root.document;
        const screen = doc.createElement('main');
        screen.id = 'workspace-screen';
        screen.setAttribute('aria-labelledby', 'workspace-screen-title');
        const content = doc.createElement('div');
        const title = doc.createElement('h1');
        title.id = 'workspace-screen-title';
        title.textContent = text('workspace.' + state + '.title', messages[state][0]);
        const retry = doc.createElement('button');
        retry.id = 'workspace-retry';
        retry.type = 'button';
        retry.className = 'btn btn-primary';
        retry.textContent = text('bets.retry', 'Try again');
        retry.addEventListener('click', () => root.location.reload());
        content.append(title);
        if (messages[state][1]) {
            const description = doc.createElement('p');
            description.textContent = text('workspace.' + state + '.message', messages[state][1]);
            content.append(description);
        }
        content.append(retry);
        screen.append(content);
        doc.body.replaceChildren(screen);
        doc.body.classList.remove('app-loading', 'i18n-loading');
        doc.body.classList.add('workspace-unavailable');
    }

    // Only the screen's own styles and its translations load after the stop.
    const SCREEN_STYLES = ['css/tokens.css', 'css/primitives.css', 'css/base.css', 'css/workspace.css'];
    const SCREEN_SCRIPTS = ['js/i18n.js', 'js/i18n-loader.js'];

    let refusal = null;
    let halted = false;

    function halt(reason) {
        if (halted) return Promise.resolve();
        halted = true;
        // Stops parsing and every pending load: no later script of the page runs.
        root.stop();
        const doc = root.document;
        const versioned = path => (typeof root.appendBuildToken === 'function' ? root.appendBuildToken(path) : path);
        SCREEN_STYLES.forEach(href => {
            const link = doc.createElement('link');
            link.rel = 'stylesheet';
            link.href = versioned(href);
            doc.head.append(link);
        });
        const loads = root.i18n ? [] : SCREEN_SCRIPTS.map(src => new Promise(resolve => {
            const script = doc.createElement('script');
            script.src = versioned(src);
            script.async = false;
            script.onload = script.onerror = resolve;
            doc.head.append(script);
        }));
        return Promise.all(loads)
            .then(() => root.i18n?.translationsReady)
            .catch(() => {})
            .then(() => show(reason));
    }

    function refuse(reason) {
        refusal = reason;
        if (root.document.body) halt(reason);
    }

    // The first script in <body> calls this; a refusal that came while the head was loading stops here.
    function bodyReached() {
        if (refusal) halt(refusal);
    }

    root.BrowserWorkspace?.ready.then(owned => {
        if (!owned) refuse(root.BrowserWorkspace.status);
    }, error => {
        root.AppDiagnostics?.report(error, { code: 'workspace-unavailable', context: { surface: 'workspace' } });
        refuse('error');
    });

    root.WorkspaceScreen = Object.freeze({ show, bodyReached });
})(window);
