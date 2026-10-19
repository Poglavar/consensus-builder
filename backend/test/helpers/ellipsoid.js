// The ellipsoidal oracle for projection tests: Vincenty's direct and inverse formulae on WGS84,
// written independently of frontend/js/metric-frame.js so a frame is judged against something it
// does not share code with. Positions are [lon, lat] degrees; distances are metres; bearings are
// degrees clockwise from north.

const A = 6378137;
const F = 1 / 298.257223563;
const B = A * (1 - F);
const RAD = Math.PI / 180;

export function inverse(p, q) {
    return inverseFull(p, q).distance;
}

// The initial bearing (degrees clockwise from north) of the geodesic from p to q. Mixing turf's
// SPHERICAL bearing with the ellipsoidal destination below puts a point 2 cm off a 24 m geodesic.
export function initialBearing(p, q) {
    return inverseFull(p, q).initialBearing;
}

export function inverseFull(p, q) {
    const L = (q[0] - p[0]) * RAD;
    const U1 = Math.atan((1 - F) * Math.tan(p[1] * RAD));
    const U2 = Math.atan((1 - F) * Math.tan(q[1] * RAD));
    const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
    let lam = L, prev, n = 0, sinS, cosS, sigma, sinAlpha, cosSqAlpha, cos2SM;
    do {
        const sinL = Math.sin(lam), cosL = Math.cos(lam);
        sinS = Math.sqrt((cU2 * sinL) ** 2 + (cU1 * sU2 - sU1 * cU2 * cosL) ** 2);
        if (sinS === 0) return 0;
        cosS = sU1 * sU2 + cU1 * cU2 * cosL;
        sigma = Math.atan2(sinS, cosS);
        sinAlpha = cU1 * cU2 * sinL / sinS;
        cosSqAlpha = 1 - sinAlpha ** 2;
        cos2SM = cosSqAlpha ? cosS - 2 * sU1 * sU2 / cosSqAlpha : 0;
        const C = F / 16 * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
        prev = lam;
        lam = L + (1 - C) * F * sinAlpha * (sigma + C * sinS * (cos2SM + C * cosS * (-1 + 2 * cos2SM ** 2)));
    } while (Math.abs(lam - prev) > 1e-12 && ++n < 200);
    if (n >= 200) throw new Error('vincenty inverse did not converge');
    const uSq = cosSqAlpha * (A * A - B * B) / (B * B);
    const bigA = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const bigB = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    const dS = bigB * sinS * (cos2SM + bigB / 4 * (cosS * (-1 + 2 * cos2SM ** 2) - bigB / 6 * cos2SM * (-3 + 4 * sinS ** 2) * (-3 + 4 * cos2SM ** 2)));
    const distance = B * bigA * (sigma - dS);
    const sinL = Math.sin(lam), cosL = Math.cos(lam);
    let initialBearing = Math.atan2(cU2 * sinL, cU1 * sU2 - sU1 * cU2 * cosL) / RAD;
    if (initialBearing < 0) initialBearing += 360;
    return { distance, initialBearing };
}

// The position `distance` metres from `p` along `bearing` (Vincenty direct).
export function destination(p, bearing, distance) {
    const alpha1 = bearing * RAD;
    const sinA1 = Math.sin(alpha1), cosA1 = Math.cos(alpha1);
    const tanU1 = (1 - F) * Math.tan(p[1] * RAD);
    const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1), sinU1 = tanU1 * cosU1;
    const sigma1 = Math.atan2(tanU1, cosA1);
    const sinAlpha = cosU1 * sinA1;
    const cosSqAlpha = 1 - sinAlpha * sinAlpha;
    const uSq = cosSqAlpha * (A * A - B * B) / (B * B);
    const bigA = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const bigB = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    let sigma = distance / (B * bigA), prev, cos2SM, sinS, cosS, n = 0;
    do {
        cos2SM = Math.cos(2 * sigma1 + sigma);
        sinS = Math.sin(sigma); cosS = Math.cos(sigma);
        const dS = bigB * sinS * (cos2SM + bigB / 4 * (cosS * (-1 + 2 * cos2SM ** 2) - bigB / 6 * cos2SM * (-3 + 4 * sinS ** 2) * (-3 + 4 * cos2SM ** 2)));
        prev = sigma;
        sigma = distance / (B * bigA) + dS;
    } while (Math.abs(sigma - prev) > 1e-12 && ++n < 200);
    const tmp = sinU1 * sinS - cosU1 * cosS * cosA1;
    const lat2 = Math.atan2(sinU1 * cosS + cosU1 * sinS * cosA1, (1 - F) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp));
    const lam = Math.atan2(sinS * sinA1, cosU1 * cosS - sinU1 * sinS * cosA1);
    const C = F / 16 * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
    const L = lam - (1 - C) * F * sinAlpha * (sigma + C * sinS * (cos2SM + C * cosS * (-1 + 2 * cos2SM ** 2)));
    let lon2 = p[0] + L / RAD;
    lon2 = ((lon2 + 180) % 360 + 360) % 360 - 180;
    return [lon2, lat2 / RAD];
}

// Eight places that between them cover a mid-latitude cadastre, both hemispheres, the equator, a
// UTM zone edge, high latitude and the antimeridian.
export const PLACES = Object.freeze({
    zagreb: [16.01, 45.78],
    newYork: [-74.0, 40.7],
    quito: [-78.5, -0.2],
    sydney: [151.2, -33.9],
    reykjavik: [-21.9, 64.1],
    svalbard: [15.6, 78.2],
    equatorZoneEdge: [5.99, 0.0],
    fiji: [179.99, -16.5]
});
