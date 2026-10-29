// Saves text or a Blob as a file the person downloads: the one place the app builds an object URL,
// clicks a download link and releases the URL. The URL stays alive briefly after the click, since
// Firefox reads it only once the download has started.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.FileDownload = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const RELEASE_AFTER_MS = 1000;

    // save(win, content, name, type): content is a string or a Blob; type applies to a string.
    function save(win, content, name, type = 'application/octet-stream') {
        const blob = content instanceof win.Blob ? content : new win.Blob([content], { type });
        const url = win.URL.createObjectURL(blob);
        const link = win.document.createElement('a');
        link.href = url; link.download = name;
        win.document.body.appendChild(link); link.click(); link.remove();
        win.setTimeout(() => win.URL.revokeObjectURL(url), RELEASE_AFTER_MS);
        return name;
    }

    // A file name stem from a title: "Riverside Blocks č" -> "riverside-blocks-c"; fallback when empty.
    function fileStem(title, fallback = 'file') {
        return String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || fallback;
    }

    return { save, fileStem, RELEASE_AFTER_MS };
});
