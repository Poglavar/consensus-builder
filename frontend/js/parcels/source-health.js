(function attachParcelSourceHealth(root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelSourceHealth = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function createParcelSourceHealth() {
    'use strict';

    const MAX_RETRY_AFTER_SECONDS = 60 * 60;
    const MAX_COOLDOWNS = 128;
    const COOLDOWN_SECONDS = Object.freeze({ rateLimited: 30, blocked: 60, unavailable: 30 });
    const HEALTH_CODES = new Set(['parcel-source-blocked', 'parcel-source-rate-limited', 'parcel-source-unavailable']);

    function parseRetryAfter(value, now = Date.now()) {
        if (typeof value !== 'string' && typeof value !== 'number') return undefined;
        const text = String(value).trim();
        if (!text) return undefined;
        let seconds;
        if (/^\d+$/.test(text)) seconds = Number(text);
        else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
            const time = Date.parse(text);
            if (!Number.isFinite(time)) return undefined;
            seconds = Math.max(0, Math.ceil((time - now) / 1000));
        } else return undefined;
        return Number.isFinite(seconds) ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil(seconds))) : undefined;
    }

    function safeErrorString(value, fallback) {
        if (typeof value !== 'string' || !value.trim()) return fallback;
        return value.trim()
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/https?:\/\/\S+/gi, '[provider]')
            .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
            .replace(/\b([\w-]*token|password|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
            .replace(/\s+/g, ' ')
            .slice(0, 240) || fallback;
    }

    function firstObject(...values) {
        return values.find(value => value && typeof value === 'object' && !Array.isArray(value)) || {};
    }

    async function errorFromResponse(response, { now = Date.now } = {}) {
        let payload = {};
        try { payload = await response.clone?.().json?.() ?? await response.json(); } catch (_) { /* Use stable fallback metadata for non-JSON responses. */ }
        const outer = firstObject(payload);
        const body = firstObject(outer.error, outer.data, outer);
        const status = Number(response?.status);
        const upstreamValue = body.upstreamStatus ?? outer.upstreamStatus;
        const parsedUpstream = Number(upstreamValue);
        const upstreamStatus = Number.isSafeInteger(parsedUpstream) && parsedUpstream >= 100 && parsedUpstream <= 599
            ? parsedUpstream
            : status >= 400 && status <= 599 ? status : undefined;
        let code = typeof body.code === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(body.code)
            ? body.code : typeof outer.code === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(outer.code) ? outer.code : '';
        if (!code || !HEALTH_CODES.has(code)) {
            const cause = upstreamStatus ?? status;
            if ([401, 403, 498, 499].includes(cause)) code = 'parcel-source-blocked';
            else if (cause === 429) code = 'parcel-source-rate-limited';
            else if (!code && cause >= 500) code = 'parcel-source-unavailable';
            else if (!code) code = 'parcel-source-unavailable';
        }
        const retryHeader = response?.headers?.get?.('retry-after');
        const retryValue = body.retryAfterSeconds ?? outer.retryAfterSeconds ?? retryHeader;
        const retryAfterSeconds = parseRetryAfter(retryValue, now());
        const defaultMessage = code === 'parcel-source-blocked' ? 'Parcel source access is blocked.'
            : code === 'parcel-source-rate-limited' ? 'Parcel source is rate limited.'
                : 'Parcel source is unavailable.';
        const message = safeErrorString(body.message ?? outer.message ?? body.error, defaultMessage);
        const error = new Error(message);
        error.status = Number.isSafeInteger(status) ? status : 502;
        error.code = code;
        if (upstreamStatus !== undefined) error.upstreamStatus = upstreamStatus;
        if (retryAfterSeconds !== undefined) error.retryAfterSeconds = retryAfterSeconds;
        return error;
    }

    function providerKey(url) {
        let parsed;
        try { parsed = new URL(String(url), typeof location !== 'undefined' ? location.href : 'http://localhost/'); }
        catch (_) { return String(url).split(/[?#]/, 1)[0]; }
        const match = parsed.pathname.match(/(?:^|\/)parcel-sources\/([^/]+)(?:\/|$)/);
        const path = match ? `/parcel-sources/${match[1]}` : parsed.pathname;
        return `${parsed.origin}${path}`;
    }

    function copyFailure(error) {
        const safe = new Error(safeErrorString(error?.message, 'Parcel source is temporarily unavailable.'));
        for (const key of ['status', 'code', 'upstreamStatus', 'retryAfterSeconds']) {
            const value = error?.[key];
            if (Number.isSafeInteger(value) || (key === 'code' && typeof value === 'string')) safe[key] = value;
        }
        if (!safe.code) safe.code = 'parcel-source-unavailable';
        if (!safe.status) safe.status = 502;
        return safe;
    }

    function createRequester({ fetchImpl = (...args) => fetch(...args), now = Date.now, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
        if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof sleep !== 'function') {
            throw new TypeError('Parcel source requester requires fetch, clock, and sleep functions.');
        }
        const cooldowns = new Map();

        function pruneExpiredCooldowns() {
            const currentTime = now();
            for (const [key, cooldown] of cooldowns) {
                if (cooldown.until <= currentTime) cooldowns.delete(key);
            }
        }

        function setCooldown(key, failure, seconds) {
            const duration = Math.max(0, Math.min(MAX_RETRY_AFTER_SECONDS, Number(seconds) || 0));
            if (!duration) return;
            pruneExpiredCooldowns();
            if (cooldowns.has(key)) cooldowns.delete(key);
            else if (cooldowns.size >= MAX_COOLDOWNS) cooldowns.delete(cooldowns.keys().next().value);
            cooldowns.set(key, { until: now() + duration * 1000, failure: copyFailure(failure) });
        }

        function cooldownFailure(cooldown) {
            const error = copyFailure(cooldown.failure);
            const remaining = Math.max(0, Math.ceil((cooldown.until - now()) / 1000));
            if (error.code === 'parcel-source-rate-limited' || error.code === 'parcel-source-unavailable') {
                error.retryAfterSeconds = remaining;
            }
            return error;
        }

        function attemptSignal(options) {
            const timeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                ? AbortSignal.timeout(15000) : null;
            const external = options.signal;
            if (!timeout) return external;
            if (!external) return timeout;
            if (typeof AbortSignal.any === 'function') return AbortSignal.any([external, timeout]);
            return external;
        }

        return async function request(url, options = {}, retries = 3, delay = 600) {
            const key = providerKey(url);
            const totalAttempts = Math.max(1, Math.min(10, Number.isSafeInteger(retries) ? retries : 3));
            const waitMs = Math.max(0, Math.min(30000, Number.isFinite(delay) ? delay : 600));
            let lastFailure;

            for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
                pruneExpiredCooldowns();
                const cooldownAtStart = cooldowns.get(key) || null;
                if (cooldownAtStart) throw cooldownFailure(cooldownAtStart);
                const signal = attemptSignal(options);
                try {
                    const response = await fetchImpl(url, { ...options, ...(signal ? { signal } : {}) });
                    if (response.ok) {
                        if (cooldowns.get(key) === cooldownAtStart && cooldownAtStart) cooldowns.delete(key);
                        return response;
                    }
                    if (response.status === 404) return response;
                    const failure = await errorFromResponse(response, { now });
                    lastFailure = failure;
                    if (failure.code === 'parcel-source-blocked') {
                        setCooldown(key, failure, COOLDOWN_SECONDS.blocked);
                        throw failure;
                    }
                    if (failure.code === 'parcel-source-rate-limited') {
                        const cooldownSeconds = failure.retryAfterSeconds ?? COOLDOWN_SECONDS.rateLimited;
                        failure.retryAfterSeconds = cooldownSeconds;
                        setCooldown(key, failure, cooldownSeconds);
                        throw failure;
                    }
                    if (failure.retryAfterSeconds !== undefined) {
                        setCooldown(key, failure, failure.retryAfterSeconds);
                        throw failure;
                    }
                    if (!(response.status >= 500 && response.status <= 599)) throw failure;
                } catch (caught) {
                    const timeout = caught?.name === 'AbortError' || caught?.name === 'TimeoutError';
                    const failure = caught?.status ? copyFailure(caught) : Object.assign(
                        new Error(timeout ? 'Parcel source request timed out.' : 'Parcel source is unavailable.'),
                        { status: timeout ? 504 : 502, code: 'parcel-source-unavailable' }
                    );
                    if (timeout) {
                        failure.status = 504;
                        failure.code = 'parcel-source-unavailable';
                        failure.message = 'Parcel source request timed out.';
                    }
                    lastFailure = failure;
                    if (failure.code === 'parcel-source-blocked' || failure.code === 'parcel-source-rate-limited') throw failure;
                    if (failure.retryAfterSeconds !== undefined) throw failure;
                    const retryable = !options.signal?.aborted && (failure.status === 504 || failure.status === 502
                        || (failure.upstreamStatus >= 500 && failure.upstreamStatus <= 599));
                    if (!retryable) throw failure;
                    if (attempt + 1 >= totalAttempts) {
                        setCooldown(key, failure, COOLDOWN_SECONDS.unavailable);
                        throw failure;
                    }
                }
                if (attempt + 1 < totalAttempts) await sleep(waitMs);
            }
            const failure = copyFailure(lastFailure || new Error('Parcel source is temporarily unavailable.'));
            setCooldown(key, failure, COOLDOWN_SECONDS.unavailable);
            throw failure;
        };
    }

    function describeFailure(error, { offline = false, translate } = {}) {
        const t = (key, fallback, values = {}) => {
            try {
                const translated = typeof translate === 'function'
                    ? translate(`parcelSourceHealth.${key}`, values) : null;
                return typeof translated === 'string' && translated && translated !== `parcelSourceHealth.${key}`
                    ? translated : fallback;
            } catch (_) { return fallback; }
        };
        const code = String(error?.code || '');
        const status = Number(error?.upstreamStatus ?? error?.status);
        const retry = Number.isSafeInteger(error?.retryAfterSeconds)
            ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, error.retryAfterSeconds)) : COOLDOWN_SECONDS.rateLimited;
        let message;
        if (offline) message = t('offline', 'You appear to be offline. Connect to the internet and try again.');
        else if (code === 'parcel-source-rate-limited' || status === 429) {
            message = t('rateLimited', `This parcel source is rate limited. Retry in ${retry} seconds.`, { seconds: retry });
        } else if (code === 'parcel-source-blocked' || status === 401 || status === 403) {
            const deniedStatus = status === 401 ? 401 : 403;
            message = t('blocked', `The provider denied access (HTTP ${deniedStatus}). It may restrict IP addresses or require authentication. Choose another source or try again later.`, { status: deniedStatus });
        } else if (status === 504 || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            message = t('timeout', 'This parcel source timed out. Try again shortly.');
        } else {
            message = t('unavailable', 'This parcel source is temporarily unavailable.');
        }
        return `${message} ${t('loadedRemain', 'Already loaded parcels remain visible. Retry or choose another source.')}`;
    }

    return Object.freeze({ createRequester, errorFromResponse, describeFailure });
});
