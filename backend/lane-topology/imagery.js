const EARTH_RADIUS_M = 6_371_008.8;
const DEFAULT_MAX_DIMENSION = 2048;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

export const LANE_IMAGERY_SOURCES = Object.freeze({
    zagreb_cdof_2022: Object.freeze({
        key: 'zagreb_cdof_2022',
        label: 'City of Zagreb CDOF 2022',
        capturedAt: '2022',
        nativeGsdM: 0.15,
        url: 'https://geoportal.zagreb.hr/Public/Ortofoto2022_Public/MapServer/WMSServer',
        layer: 'ZG_CDOF2022',
        attribution: 'Ortofoto © Grad Zagreb',
        role: 'primary',
        coverage: 'zagreb',
        // The server's own LatLonBoundingBox from GetCapabilities, not a guess at the city limits.
        // Outside it this WMS does not error — it returns a SOLID WHITE image, which as a map layer
        // blanks the screen and as model input is worse still: a blank crop is something a
        // recognition run would happily describe. 900 m west of Jastrebarsko was enough to hit it.
        //
        // A rectangle is the outer bound, not the shape: the data follows the city's
        // administrative outline, so inside this box imagery is possible, never guaranteed.
        bounds: Object.freeze([15.7643127, 45.6055652, 16.2692342, 45.9855807])
    })
});

// Does a WGS84 bbox touch the source's coverage at all?
export function withinImageryCoverage(source, bbox) {
    const bounds = source?.bounds;
    if (!Array.isArray(bounds) || !Array.isArray(bbox) || bbox.length !== 4) return true;
    const [west, south, east, north] = bbox;
    return west < bounds[2] && east > bounds[0] && south < bounds[3] && north > bounds[1];
}

function radians(value) {
    return value * Math.PI / 180;
}

function distanceMeters([lon1, lat1], [lon2, lat2]) {
    const phi1 = radians(lat1);
    const phi2 = radians(lat2);
    const deltaPhi = radians(lat2 - lat1);
    const deltaLambda = radians(lon2 - lon1);
    const a = Math.sin(deltaPhi / 2) ** 2
        + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function detectedImageContentType(buffer, reportedContentType) {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    if (buffer.length >= 8
        && buffer[0] === 0x89
        && buffer.subarray(1, 4).toString('ascii') === 'PNG') {
        return 'image/png';
    }
    return reportedContentType;
}

export function publicImagerySource(source) {
    return {
        key: source.key,
        label: source.label,
        capturedAt: source.capturedAt,
        nativeGsdM: source.nativeGsdM,
        wmsUrl: source.url,
        wmsLayer: source.layer,
        attribution: source.attribution,
        role: source.role,
        coverage: source.coverage,
        bounds: source.bounds || null
    };
}

export function resolveImagerySource(key) {
    return LANE_IMAGERY_SOURCES[String(key || '')] || null;
}

export function imageryCropSpec(source, bbox, options = {}) {
    const [west, south, east, north] = bbox;
    const middleLat = (south + north) / 2;
    const middleLon = (west + east) / 2;
    const widthM = distanceMeters([west, middleLat], [east, middleLat]);
    const heightM = distanceMeters([middleLon, south], [middleLon, north]);
    const requestedGsdM = Math.max(
        Number(source.nativeGsdM) || 0.15,
        Number(options.gsdM) || 0
    );
    const maxDimension = Math.max(
        256,
        Math.min(4096, Number(options.maxDimension) || DEFAULT_MAX_DIMENSION)
    );
    const nativeWidth = Math.max(1, Math.ceil(widthM / requestedGsdM));
    const nativeHeight = Math.max(1, Math.ceil(heightM / requestedGsdM));
    const scale = Math.min(1, maxDimension / Math.max(nativeWidth, nativeHeight));
    const width = Math.max(64, Math.round(nativeWidth * scale));
    const height = Math.max(64, Math.round(nativeHeight * scale));
    const effectiveGsdM = Math.max(widthM / width, heightM / height);

    const url = new URL(source.url);
    const params = {
        SERVICE: 'WMS',
        VERSION: '1.1.1',
        REQUEST: 'GetMap',
        LAYERS: source.layer,
        STYLES: '',
        SRS: 'EPSG:4326',
        BBOX: bbox.join(','),
        WIDTH: String(width),
        HEIGHT: String(height),
        FORMAT: 'image/jpeg'
    };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    return {
        source: publicImagerySource(source),
        bbox: bbox.map(Number),
        width,
        height,
        widthM: Number(widthM.toFixed(2)),
        heightM: Number(heightM.toFixed(2)),
        requestedGsdM,
        effectiveGsdM: Number(effectiveGsdM.toFixed(3)),
        northUp: true,
        pixelCoordinates: {
            origin: 'top-left',
            x: 'west-to-east',
            y: 'north-to-south'
        },
        url: url.toString()
    };
}

// An error the city's WMS will give again however many times we ask: out of coverage, an XML
// fault, an image over the safety limit. Anything else — a reset socket, a 5xx, a timeout — is
// weather, and asking again is the whole fix.
function permanent(error) {
    return Object.assign(error, { permanentImageryError: true });
}

// One reset connection from geoportal.zagreb.hr used to lose a whole junction, AFTER the run had
// paid to enumerate it and hand it to a model: two of the first six junctions of one batch died
// this way, `TypeError: fetch failed` and `TypeError: terminated`, both `read ECONNRESET` under the
// covers — undici names them differently only by whether the reset arrived during the connection or
// midway through the image. The same fault took out a 40-minute coverage rebuild once already,
// which is why tileEvidence retries; this call site never got the same treatment.
//
// The retry has to cover the BODY, not just the request: `terminated` is thrown by arrayBuffer()
// long after the response headers arrived.
export async function fetchImageryCrop(source, bbox, options = {}) {
    const attempts = Math.max(1, Number(options.attempts) || 3);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await fetchImageryCropOnce(source, bbox, options);
        } catch (error) {
            lastError = error;
            if (error?.permanentImageryError || attempt === attempts) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
    throw lastError;
}

async function fetchImageryCropOnce(source, bbox, options = {}) {
    const spec = imageryCropSpec(source, bbox, options);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation is available for imagery.');

    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 45_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetchImpl(spec.url, {
            headers: {
                Accept: 'image/jpeg,image/*;q=0.9',
                'User-Agent': 'consensus-builder/lane-topology'
            },
            signal: controller.signal
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error(`Orthophoto request timed out after ${timeoutMs} ms.`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const error = new Error(`Orthophoto WMS returned HTTP ${response.status}.`);
        // A 5xx is the server having a bad moment; a 4xx is our request, and repeating it is rude
        // and pointless.
        throw response.status >= 500 ? error : permanent(error);
    }
    const reportedContentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
    if (!reportedContentType.startsWith('image/')) {
        const text = await response.text();
        throw permanent(new Error(`Orthophoto WMS returned ${reportedContentType || 'non-image data'}: `
            + text.slice(0, 300)));
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Orthophoto WMS returned an empty image.');
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw permanent(new Error(`Orthophoto image exceeds the ${MAX_IMAGE_BYTES} byte safety limit.`));
    }
    return {
        buffer,
        contentType: detectedImageContentType(buffer, reportedContentType),
        metadata: {
            ...spec,
            url: undefined,
            byteLength: buffer.length
        }
    };
}
