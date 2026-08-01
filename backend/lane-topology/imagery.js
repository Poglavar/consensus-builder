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
        coverage: 'zagreb'
    })
});

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
        coverage: source.coverage
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

export async function fetchImageryCrop(source, bbox, options = {}) {
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
        throw new Error(`Orthophoto WMS returned HTTP ${response.status}.`);
    }
    const reportedContentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
    if (!reportedContentType.startsWith('image/')) {
        const text = await response.text();
        throw new Error(`Orthophoto WMS returned ${reportedContentType || 'non-image data'}: ${text.slice(0, 300)}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Orthophoto WMS returned an empty image.');
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`Orthophoto image exceeds the ${MAX_IMAGE_BYTES} byte safety limit.`);
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
