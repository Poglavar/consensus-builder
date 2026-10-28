// Settings keeps reference material in shared dialogs, while the compact panel remains in place.
(function (win) {
    'use strict';
    const doc = win.document;
    const titles = { credits: 'mapCredits.title', contact: 'sidebar.info.contactTitle', about: 'sidebar.info.aboutTitle' };
    let active = null;
    function openReference(kind) {
        const content = doc.getElementById(`settings-reference-${kind}`);
        if (!content || !titles[kind]) return null;
        active?.close();
        const home = content.parentNode;
        const dialog = win.CbDialog.open({ title: win.i18n.t(titles[kind]), size: 'lg',
            className: 'settings-reference-dialog', body: content,
            onClose() { home.appendChild(content); if (active === dialog) active = null; } });
        active = dialog;
        return dialog;
    }
    doc.addEventListener('click', event => {
        const button = event.target.closest?.('[data-settings-reference]');
        if (button) openReference(button.dataset.settingsReference);
    });
    win.SettingsPanel = Object.freeze({ openReference });
})(window);
