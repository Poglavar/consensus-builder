// The agreement, member and map views share the same city, camera centre and local API.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LensLinks = api;
})(typeof window === 'undefined' ? null : window, function (root) {
    function url(path, selection, location) {
        const params = new URLSearchParams(location?.search || '');
        const out = new URLSearchParams();
        for (const key of ['city', 'at', 'backend', 'lang']) {
            const value = selection[key] || params.get(key) || (key === 'city' && root?.CityConfigManager?.getCurrentCityConfig?.()?.id);
            if (value) out.set(key, value);
        }
        if (selection.agreement) out.set('agreement', selection.agreement);
        else if (selection.member) {
            out.set('member', selection.member);
            if (selection.attestation) out.set('attestation', selection.attestation);
            if (selection.subject) out.set('subject', selection.subject);
        } else if (selection.view === 'members') out.set('view', 'members');
        return path + (out.size ? '?' + out.toString() : '');
    }
    return {
        pageUrl: (selection = {}, location = root?.location) => url('/lens.html', selection, location),
        mapUrl: (selection = {}, location = root?.location) => url('/', selection, location),
        isMemberView: location => {
            const query = new URLSearchParams(location?.search);
            return !query.has('agreement') && (query.get('view') === 'members' || ['member', 'service', 'attestation'].some(key => query.has(key)));
        }
    };
});
