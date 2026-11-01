(function (win, doc) {
    'use strict';
    doc.addEventListener('mapshell:sheetopened', event => {
        if (event.detail?.id !== 'chat-sheet') return;
        const sheet = doc.getElementById('chat-sheet');
        win.ensureOptionalTool('chat').then(() => win.ChatPanel?.mount(sheet?.querySelector('[data-chat-host]')))
            .catch(error => win.updateStatus?.(error.message));
    });
})(window, document);
