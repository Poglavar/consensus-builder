// Geolocation helper routes (IP -> coarse location -> default city)
// This route is intentionally coarse and privacy-preserving: we only map to one of the supported cities.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const ipCache = new Map(); // ip -> { ts, cityId, countryCode }

function nowMs() {
    return Date.now();
}

function normalizeIp(ip) {
    if (!ip) return null;
    const raw = String(ip).trim();
    if (!raw) return null;
    // Strip IPv6 mapped IPv4 prefix
    if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length);
    return raw;
}

function isPrivateIp(ip) {
    if (!ip) return true;
    const v = String(ip).trim().toLowerCase();
    if (!v) return true;
    if (v === '::1' || v === 'localhost') return true;
    if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
    // IPv4 checks
    if (/^127\./.test(v)) return true;
    if (/^10\./.test(v)) return true;
    if (/^192\.168\./.test(v)) return true;
    const m172 = v.match(/^172\.(\d+)\./);
    if (m172) {
        const n = Number(m172[1]);
        if (n >= 16 && n <= 31) return true;
    }
    return false;
}

function getClientIp(req) {
    // If behind nginx/other proxy, X-Forwarded-For is the canonical header.
    // We use the left-most IP (original client).
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
        const first = String(xff).split(',')[0]?.trim();
        const ip = normalizeIp(first);
        if (ip) return ip;
    }
    const xri = req.headers['x-real-ip'];
    if (xri) {
        const ip = normalizeIp(xri);
        if (ip) return ip;
    }
    return normalizeIp(req.ip || req.socket?.remoteAddress || '');
}

function mapCountryToCityId(countryCode) {
    const cc = (countryCode || '').toString().trim().toUpperCase();
    if (cc === 'HR') return 'zagreb';
    if (cc === 'RS') return 'belgrade';
    if (cc === 'AR') return 'buenos_aires';
    return null;
}

async function lookupCountryCodeViaIpApi(ip) {
    // ipapi.co supports IP-specific lookups without an API key for small volumes.
    // Docs: https://ipapi.co/api/#complete-location
    const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
    const response = await fetch(url, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'consensus-builder/geo'
        }
    });
    if (!response.ok) {
        throw new Error(`ipapi status ${response.status}`);
    }
    const data = await response.json();
    const countryCode = data?.country_code || data?.country || null;
    if (!countryCode) return null;
    return String(countryCode).trim().toUpperCase();
}

export function setupGeoRoute(app) {
    app.get('/geo/default-city', async (req, res) => {
        const defaultCityId = 'zagreb';
        try {
            const ip = getClientIp(req);
            if (!ip || isPrivateIp(ip)) {
                return res.json({
                    cityId: defaultCityId,
                    source: 'default',
                    reason: 'private_or_missing_ip'
                });
            }

            const cached = ipCache.get(ip);
            if (cached && (nowMs() - cached.ts) < CACHE_TTL_MS) {
                return res.json({
                    cityId: cached.cityId || defaultCityId,
                    source: 'cache',
                    countryCode: cached.countryCode || null
                });
            }

            const countryCode = await lookupCountryCodeViaIpApi(ip);
            const cityId = mapCountryToCityId(countryCode) || defaultCityId;
            ipCache.set(ip, { ts: nowMs(), cityId, countryCode });

            return res.json({
                cityId,
                source: 'ipapi',
                countryCode: countryCode || null
            });
        } catch (err) {
            // Never block UX on geo failure.
            return res.json({
                cityId: defaultCityId,
                source: 'default',
                reason: 'lookup_failed'
            });
        }
    });
}


