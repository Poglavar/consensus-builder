// A refused workspace is a page state: there is no editable map behind a dismissible warning.
(function (root) {
    'use strict';
    const messages = {
        blocked: ['Already open in another tab', 'Your map workspace is open in another tab. Close that tab, then try again here. Your saved work will still be here.'],
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
        const description = doc.createElement('p');
        description.textContent = text('workspace.' + state + '.message', messages[state][1]);
        const retry = doc.createElement('button');
        retry.id = 'workspace-retry';
        retry.type = 'button';
        retry.className = 'btn btn-primary';
        retry.textContent = text('bets.retry', 'Try again');
        retry.addEventListener('click', () => root.location.reload());
        content.append(title, description, retry);
        screen.append(content);
        doc.body.replaceChildren(screen);
        doc.body.classList.remove('app-loading', 'i18n-loading');
        doc.body.classList.add('workspace-unavailable');
    }
    root.WorkspaceScreen = Object.freeze({ show });
})(window);
