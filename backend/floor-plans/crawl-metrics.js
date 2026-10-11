// Body lengths are decoded payload bytes exposed by fetcher, not network or wire bytes.
// Hosts refer to the requested URL, even when a response redirects.
export function emptyCrawlMetrics() {
    return {
        requestsAttempted: 0,
        fetchResults: 0,
        successfulResponses: 0,
        decodedResponseBodyBytes: 0,
        pageDecodedBodyBytes: 0,
        assetDecodedBodyBytes: 0,
        attemptedHostKeys: [],
        successfulHostKeys: [],
    };
}

function hostKey(url) {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return null;
    }
}

function bodyByteLength(body) {
    if (typeof body === 'string') return Buffer.byteLength(body);
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body.byteLength;
    return 0;
}

export function recordCrawlAttempt(metrics, url) {
    const host = hostKey(url);
    return {
        ...metrics,
        requestsAttempted: metrics.requestsAttempted + 1,
        attemptedHostKeys: host && !metrics.attemptedHostKeys.includes(host)
            ? [...metrics.attemptedHostKeys, host] : metrics.attemptedHostKeys,
    };
}

export function recordCrawlResponse(metrics, response, kind) {
    const noBody = response?.notModified === true || response?.status === 304;
    const bytes = noBody ? 0 : bodyByteLength(response?.body);
    return {
        ...metrics,
        fetchResults: metrics.fetchResults + 1,
        decodedResponseBodyBytes: metrics.decodedResponseBodyBytes + bytes,
        pageDecodedBodyBytes: metrics.pageDecodedBodyBytes + (kind === 'asset' ? 0 : bytes),
        assetDecodedBodyBytes: metrics.assetDecodedBodyBytes + (kind === 'asset' ? bytes : 0),
    };
}

export function recordCrawlSuccess(metrics, url) {
    const host = hostKey(url);
    return {
        ...metrics,
        successfulResponses: metrics.successfulResponses + 1,
        successfulHostKeys: host && !metrics.successfulHostKeys.includes(host)
            ? [...metrics.successfulHostKeys, host] : metrics.successfulHostKeys,
    };
}

export function crawlMetricCounters(metrics) {
    return {
        requestsAttempted: metrics.requestsAttempted,
        fetched: metrics.requestsAttempted,
        fetchResults: metrics.fetchResults,
        successfulResponses: metrics.successfulResponses,
        decodedResponseBodyBytes: metrics.decodedResponseBodyBytes,
        pageDecodedBodyBytes: metrics.pageDecodedBodyBytes,
        assetDecodedBodyBytes: metrics.assetDecodedBodyBytes,
        uniqueHostsAttempted: metrics.attemptedHostKeys.length,
        uniqueHostsSucceeded: metrics.successfulHostKeys.length,
    };
}

export function crawlMetricTelemetry(metrics) {
    return {
        requestedHostKeys: [...metrics.attemptedHostKeys],
        successfulHostKeys: [...metrics.successfulHostKeys],
    };
}
