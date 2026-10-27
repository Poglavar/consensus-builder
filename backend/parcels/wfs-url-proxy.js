// Encode a fixed WFS service URL for municipal full-URL proxies and constrain browser relays.
export function wfsUrlProxy(descriptor) {
    if (descriptor.wfsUrlProxy === undefined) return null;
    const proxy = new URL(descriptor.wfsUrlProxy);
    const service = new URL(descriptor.endpoint);
    if (descriptor.adapter !== 'wfs' || proxy.protocol !== 'https:' || service.protocol !== 'https:'
        || proxy.username || proxy.password || proxy.search || proxy.hash
        || service.username || service.password || service.hash || descriptor.wfsProxyParameter !== undefined) {
        throw new Error('Invalid WFS full-URL proxy configuration.');
    }
    return proxy;
}

export function isWfsUrlProxyRequest(url, descriptor) {
    try {
        const proxy = wfsUrlProxy(descriptor);
        if (!proxy || url.origin !== proxy.origin || url.pathname !== proxy.pathname
            || [...url.searchParams.keys()].join(',') !== 'url') return false;
        const target = new URL(url.searchParams.get('url'));
        const service = new URL(descriptor.endpoint);
        return target.origin === service.origin && target.pathname === service.pathname
            && !target.username && !target.password && !target.hash;
    } catch { return false; }
}
