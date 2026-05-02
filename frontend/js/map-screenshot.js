(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope || !globalScope.document) {
        return;
    }

    let leafletImageLoaded = typeof globalScope.leafletImage === 'function';
    let leafletImageLoading = false;
    const DEFAULT_TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';
    const TILE_SIZE = 256;
    const DEFAULT_STITCH_ZOOM = 19;
    const MAX_STITCH_TILES_PER_AXIS = 6; // Target max ~36 tiles (6x6)

    // ─────────────────────────────────────────────────────────────────────────
    // Tile math: convert WGS84 (lat/lng) ⇔ tile coordinates at zoom z
    // ─────────────────────────────────────────────────────────────────────────

    function lngToTileX(lng, z) {
        return Math.floor(((lng + 180) / 360) * Math.pow(2, z));
    }

    function latToTileY(lat, z) {
        const latRad = (lat * Math.PI) / 180;
        const n = Math.pow(2, z);
        return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    }

    function tileBbox(x, y, z) {
        const n = Math.pow(2, z);
        const lngMin = (x / n) * 360 - 180;
        const lngMax = ((x + 1) / n) * 360 - 180;
        const latMax = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
        const latMin = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
        return { lngMin, lngMax, latMin, latMax };
    }

    /**
     * Convert a WGS84 coordinate to pixel position within a stitched tile grid.
     * @param {number} lng - longitude
     * @param {number} lat - latitude
     * @param {number} xMin - leftmost tile X index
     * @param {number} yMin - topmost tile Y index
     * @param {number} z - zoom level
     * @returns {{px: number, py: number}}
     */
    function lngLatToPixel(lng, lat, xMin, yMin, z) {
        const n = Math.pow(2, z);
        // Global pixel x/y at this zoom
        const globalX = ((lng + 180) / 360) * n * TILE_SIZE;
        const latRad = (lat * Math.PI) / 180;
        const globalY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * TILE_SIZE;
        // Offset by top-left tile origin
        const px = globalX - xMin * TILE_SIZE;
        const py = globalY - yMin * TILE_SIZE;
        return { px, py };
    }

    /**
     * Fetch a tile image as an HTMLImageElement via a proxy-free approach.
     * Uses crossOrigin='anonymous' and falls back to opaque load if tainted.
     */
    function fetchTileImage(url, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            const timer = setTimeout(() => {
                img.onload = img.onerror = null;
                reject(new Error(`Tile fetch timeout: ${url}`));
            }, timeoutMs);
            img.onload = () => {
                clearTimeout(timer);
                resolve(img);
            };
            img.onerror = () => {
                clearTimeout(timer);
                reject(new Error(`Tile fetch failed: ${url}`));
            };
            img.src = url;
        });
    }

    /**
     * Expand tile URL template. Supports {s}, {x}, {y}, {z}.
     */
    function expandTileUrl(template, x, y, z) {
        const subdomains = ['a', 'b', 'c'];
        const s = subdomains[(x + y) % subdomains.length];
        return template
            .replace('{s}', s)
            .replace('{x}', String(x))
            .replace('{y}', String(y))
            .replace('{z}', String(z));
    }

    /**
     * Compute the best zoom level so that the bbox fits within maxTilesPerAxis tiles.
     * Returns a zoom between minZoom and maxZoom.
     */
    function computeBestZoomForBbox(lngMin, lngMax, latMin, latMax, maxTilesPerAxis = MAX_STITCH_TILES_PER_AXIS, minZoom = 14, maxZoom = 19) {
        for (let z = maxZoom; z >= minZoom; z--) {
            const xMin = lngToTileX(lngMin, z);
            const xMax = lngToTileX(lngMax, z);
            const yMin = latToTileY(latMax, z);
            const yMax = latToTileY(latMin, z);
            const tilesX = xMax - xMin + 1;
            const tilesY = yMax - yMin + 1;
            if (tilesX <= maxTilesPerAxis && tilesY <= maxTilesPerAxis) {
                return z;
            }
        }
        return minZoom;
    }

    /**
     * Stitch tiles covering a bounding box and draw polygon overlays.
     * Returns a data URL of the resulting PNG.
     *
     * @param {Object} opts
     * @param {number} opts.lngMin
     * @param {number} opts.lngMax
     * @param {number} opts.latMin
     * @param {number} opts.latMax
     * @param {number} [opts.zoom=19]
     * @param {string} [opts.tileUrl]
     * @param {Array} [opts.polygons] - Array of { coords: [[lng,lat],...], style: {...} }
     * @param {string} [opts.label]
     * @returns {Promise<string>} data URL
     */
    async function stitchTilesAndDrawPolygons(opts) {
        const {
            lngMin,
            lngMax,
            latMin,
            latMax,
            zoom = DEFAULT_STITCH_ZOOM,
            tileUrl = DEFAULT_TILE_URL,
            polygons = [],
            label = null,
            badge = null
        } = opts;

        const now = () => (globalScope.performance && typeof globalScope.performance.now === 'function')
            ? globalScope.performance.now()
            : Date.now();
        const tStart = now();


        // Compute tile range
        const xMin = lngToTileX(lngMin, zoom);
        const xMax = lngToTileX(lngMax, zoom);
        const yMin = latToTileY(latMax, zoom); // note: higher lat = lower tile Y
        const yMax = latToTileY(latMin, zoom);

        const tilesX = xMax - xMin + 1;
        const tilesY = yMax - yMin + 1;

        if (tilesX * tilesY > 50) {
            console.warn('[stitchTiles] Large tile fetch:', { tilesX, tilesY, total: tilesX * tilesY });
        }
        const MAX_TILES = 100;
        if (tilesX * tilesY > MAX_TILES) {
            throw new Error(`[stitchTiles] Tile request too large (${tilesX * tilesY} tiles)`);
        }

        const canvasWidth = tilesX * TILE_SIZE;
        const canvasHeight = tilesY * TILE_SIZE;

        const tAfterSetup = now();


        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('2d');

        // Fill with light gray in case tiles fail
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        const tTileStart = now();

        // Fetch and draw tiles
        const tilePromises = [];
        let loadedCount = 0;
        let failedCount = 0;
        for (let ty = yMin; ty <= yMax; ty++) {
            for (let tx = xMin; tx <= xMax; tx++) {
                const url = expandTileUrl(tileUrl, tx, ty, zoom);
                const dx = (tx - xMin) * TILE_SIZE;
                const dy = (ty - yMin) * TILE_SIZE;
                tilePromises.push(
                    fetchTileImage(url)
                        .then(img => {
                            ctx.drawImage(img, dx, dy, TILE_SIZE, TILE_SIZE);
                            loadedCount++;
                        })
                        .catch(err => {
                            console.warn(`[stitchTiles] Failed to load tile ${tx},${ty}: ${err.message}`);
                            failedCount++;
                            // Leave gray background for this tile
                        })
                );
            }
        }
        await Promise.all(tilePromises);


        const tAfterTiles = now();

        // Draw polygons
        const traceRing = (ring) => {
            let first = true;
            for (const coord of ring) {
                const lng = coord[0];
                const lat = coord[1];
                const { px, py } = lngLatToPixel(lng, lat, xMin, yMin, zoom);
                if (first) {
                    ctx.moveTo(px, py);
                    first = false;
                } else {
                    ctx.lineTo(px, py);
                }
            }
            ctx.closePath();
        };

        for (const poly of polygons) {
            const { coords, style = {} } = poly;
            if (!coords) {
                continue;
            }

            // Support polygons with holes: coords can be [ring, hole1, ...] or flat [[lng,lat],...]
            const rings = (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) ? coords : [coords];
            const outerRing = rings[0];
            if (!outerRing || outerRing.length < 3) {
                continue;
            }

            ctx.beginPath();
            rings.forEach(traceRing);

            if (style.fillColor && style.fillOpacity > 0) {
                ctx.fillStyle = hexToRgba(style.fillColor, style.fillOpacity || 0.2);
                ctx.fill('evenodd');
            }
            if (style.color) {
                ctx.strokeStyle = style.color;
                ctx.lineWidth = style.weight || 2;
                ctx.lineJoin = style.lineJoin || 'round';
                ctx.lineCap = style.lineCap || 'round';
                if (style.dashArray) {
                    const dashes = style.dashArray.split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
                    ctx.setLineDash(dashes);
                } else {
                    ctx.setLineDash([]);
                }
                ctx.globalAlpha = style.opacity !== undefined ? style.opacity : 1;
                // Stroke only outer ring for clarity
                ctx.stroke();
                ctx.globalAlpha = 1;
                ctx.setLineDash([]);
            }
        }
        // Draw label if provided
        if (label) {
            // Find center of first polygon (the main proposal polygon)
            if (polygons.length > 0 && polygons[0].coords && polygons[0].coords.length > 0) {
                let sumLng = 0, sumLat = 0;
                for (const c of polygons[0].coords) {
                    sumLng += c[0];
                    sumLat += c[1];
                }
                const centerLng = sumLng / polygons[0].coords.length;
                const centerLat = sumLat / polygons[0].coords.length;
                const { px, py } = lngLatToPixel(centerLng, centerLat, xMin, yMin, zoom);

                ctx.font = 'bold 14px "Helvetica Neue", Arial, sans-serif';
                const metrics = ctx.measureText(label);
                const textWidth = metrics.width;
                const textHeight = 14;
                const padX = 8, padY = 4;
                const boxX = px - textWidth / 2 - padX;
                const boxY = py - textHeight / 2 - padY;
                const boxW = textWidth + padX * 2;
                const boxH = textHeight + padY * 2;

                // Background
                ctx.fillStyle = 'rgba(255,255,255,0.86)';
                ctx.strokeStyle = '#0f172a';
                ctx.lineWidth = 1;
                ctx.beginPath();
                roundRect(ctx, boxX, boxY, boxW, boxH, 6);
                ctx.fill();
                ctx.stroke();

                // Text
                ctx.fillStyle = '#0f172a';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, px, py);
            }
        }

        if (badge && badge.text) {
            drawBadge(ctx, badge, canvasWidth, canvasHeight);
        }

        const tAfterPolygons = now();

        const dataUrl = canvas.toDataURL('image/png');

        const tAfterEncode = now();

        // Optionally log timing breakdowns when debugging map screenshots
        const timings = {
            setup: Number((tAfterSetup - tStart).toFixed(1)),
            tileFetch: Number((tAfterTiles - tTileStart).toFixed(1)),
            draw: Number((tAfterPolygons - tAfterTiles).toFixed(1)),
            encode: Number((tAfterEncode - tAfterPolygons).toFixed(1)),
            total: Number((tAfterEncode - tStart).toFixed(1))
        };
        if (window?.__DEBUG_SCREENSHOT_TIMING__) {
            console.debug('[stitchTiles timings]', timings);
        }

        return dataUrl;
    }

    function hexToRgba(hex, alpha) {
        let c = hex.replace('#', '');
        if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
        const r = parseInt(c.substring(0, 2), 16);
        const g = parseInt(c.substring(2, 4), 16);
        const b = parseInt(c.substring(4, 6), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
    }

    function drawBadge(ctx, badge, canvasWidth, canvasHeight) {
        if (!ctx || !badge || !badge.text) return;
        const size = Number.isFinite(badge.size) ? badge.size : 56;
        const margin = Number.isFinite(badge.margin) ? badge.margin : 12;
        const radius = Math.min(size / 4, 14);
        const x = margin;
        const y = margin;

        ctx.save();
        ctx.beginPath();
        roundRect(ctx, x, y, size, size, radius);
        ctx.fillStyle = badge.background || 'rgba(255,255,255,0.94)';
        ctx.shadowColor = 'rgba(0,0,0,0.25)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 4;
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = 2;
        ctx.strokeStyle = badge.borderColor || '#000';
        ctx.stroke();

        ctx.fillStyle = badge.color || '#000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = badge.font || '28px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
        ctx.fillText(badge.text, x + size / 2, y + size / 2 + 1);
        ctx.restore();
    }

    async function overlayBadgeOnDataUrl(dataUrl, badge) {
        if (!badge || !badge.text || !dataUrl || typeof dataUrl !== 'string') {
            return dataUrl;
        }

        return new Promise((resolve) => {
            try {
                const img = new Image();
                img.onload = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        drawBadge(ctx, badge, canvas.width, canvas.height);
                        resolve(canvas.toDataURL('image/png'));
                    } catch (err) {
                        console.warn('Failed to overlay badge on screenshot', err);
                        resolve(dataUrl);
                    }
                };
                img.onerror = () => resolve(dataUrl);
                img.src = dataUrl;
            } catch (_) {
                resolve(dataUrl);
            }
        });
    }

    /**
     * High-level function to capture a proposal polygon image via tile stitching.
     * This avoids leaflet-image entirely.
     *
     * @param {Object} options
     * @param {Array} options.polygon - Polygon coordinates (various formats supported)
     * @param {Object} [options.bounds] - Leaflet LatLngBounds for coordinate disambiguation
     * @param {number} [options.padding=0.05] - Fractional padding around bounds
     * @param {string} [options.tileUrl] - Tile URL template
     * @param {Array} [options.parcelPolygons] - Additional parcel outlines
     * @param {Array} [options.neighbours] - Neighbour polygons
     * @param {string} [options.parcelLabel] - Label to draw at center
     * @param {number} [options.zoom=19] - Tile zoom level
     * @returns {Promise<string>} data URL
     */
    async function captureViaTileStitch(options = {}) {
        if (window?.__DEBUG_SCREENSHOT_TIMING__) {
            console.debug('[captureViaTileStitch] options', {
                polygonLength: options.polygon?.length,
                polygonSample: options.polygon?.slice ? options.polygon.slice(0, 3) : options.polygon,
                bounds: options.bounds ? 'present' : 'null',
                padding: options.padding,
                parcelPolygonsCount: options.parcelPolygons?.length,
                zoom: options.zoom,
                tileUrl: options.tileUrl || DEFAULT_TILE_URL,
                polygonOrder: options.polygonOrder || 'auto',
                fitToPolygonOnly: !!options.fitToPolygonOnly
            });
        }

        const {
            polygon,
            bounds = null,
            padding = 0.05,
            tileUrl = DEFAULT_TILE_URL,
            parcelPolygons = [],
            neighbours = [],
            parcelLabel = null,
            zoom = DEFAULT_STITCH_ZOOM,
            badge = null,
            polygonOrder = 'auto',
            parcelPolygonOrder = 'auto',
            fitToPolygonOnly = false
        } = options;

        // Normalize polygon to GeoJSON-order [lng, lat] rings
        const geoCoords = normalizeToGeoJSON(polygon, bounds, polygonOrder);

        // Log actual coordinate values for debugging
        if (Array.isArray(geoCoords) && geoCoords.length > 0) {
            const firstCoord = Array.isArray(geoCoords[0]) && Array.isArray(geoCoords[0][0]) ? geoCoords[0][0] : geoCoords[0];
        }

        // Allow polygons with holes: [[outer], [hole1], ...]. Validate outer ring length.
        const ringArray = (Array.isArray(geoCoords) && Array.isArray(geoCoords[0]) && Array.isArray(geoCoords[0][0]))
            ? geoCoords
            : (Array.isArray(geoCoords) && Array.isArray(geoCoords[0]) && typeof geoCoords[0][0] === 'number')
                ? [geoCoords]
                : null;
        const outerRing = ringArray && ringArray[0];

        if (!outerRing || outerRing.length < 3) {
            console.error('[captureViaTileStitch] Invalid polygon - geoCoords:', geoCoords);
            throw new Error('Invalid polygon for tile stitch capture');
        }

        // Compute bbox from all coordinates
        let lngMin = Infinity, lngMax = -Infinity, latMin = Infinity, latMax = -Infinity;
        const expandBbox = (coords) => {
            const walk = (node) => {
                if (!Array.isArray(node)) return;
                if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
                    if (node[0] < lngMin) lngMin = node[0];
                    if (node[0] > lngMax) lngMax = node[0];
                    if (node[1] < latMin) latMin = node[1];
                    if (node[1] > latMax) latMax = node[1];
                    return;
                }
                node.forEach(walk);
            };
            walk(coords);
        };
        expandBbox(geoCoords);


        // Sanity check: detect swapped lat/lng coordinates
        // GeoJSON format is [lng, lat]. Zagreb: lng ~15.97, lat ~45.80
        // If we see lngMin ~45 and latMin ~15, coordinates are swapped (lat ended up in lng slot)
        // Detection heuristics:
        // 1. If lng > 90 or < -180, definitely swapped (lat can't be > 90)
        // 2. For European cities where lat > lng: if computed lngMin > latMax, likely swapped
        // 3. Check if the "lat" values look like Zagreb longitude (~14-17) and "lng" values look like Zagreb latitude (~45-46)
        const obviouslySwapped = (lngMin > 90 || lngMax > 90 || latMin < -90 || latMax < -90);
        const zagrebSwapped = (lngMin > 40 && lngMax < 50 && latMin > 10 && latMax < 20); // lat in lng slot, lng in lat slot
        const coordsLookSwapped = obviouslySwapped || zagrebSwapped;


        if (coordsLookSwapped) {
            console.warn('[captureViaTileStitch] Detected swapped lat/lng coordinates, fixing...');
            // Swap lng and lat
            const tmpLngMin = lngMin, tmpLngMax = lngMax;
            lngMin = latMin;
            lngMax = latMax;
            latMin = tmpLngMin;
            latMax = tmpLngMax;
        }

        // Expand bbox for parcels and neighbours (unless explicitly disabled)
        const allPolygons = [
            { coords: geoCoords, style: { color: '#ff6600', weight: 3, opacity: 0.9, fillColor: '#ff6600', fillOpacity: 0.18, lineJoin: 'round', lineCap: 'round' } }
        ];

        const normalizeOrder = (order) => (order === 'lnglat' || order === 'latlng') ? order : 'auto';

        if (Array.isArray(parcelPolygons)) {
            let parcelIdx = 0;
            for (const p of parcelPolygons) {
                parcelIdx++;
                const norm = normalizeToGeoJSON(p, bounds, normalizeOrder(parcelPolygonOrder || polygonOrder));
                const normRings = (Array.isArray(norm) && Array.isArray(norm[0]) && Array.isArray(norm[0][0])) ? norm : (norm ? [norm] : null);
                const hasOuter = normRings && normRings[0] && normRings[0].length >= 3;
                if (hasOuter) {
                    if (!fitToPolygonOnly) {
                        expandBbox(norm);
                    }
                    allPolygons.push({ coords: norm, style: { color: '#000', weight: 2.5, opacity: 1, dashArray: '3 2' } });
                }
            }
        }

        if (Array.isArray(neighbours)) {
            for (const p of neighbours) {
                const norm = normalizeToGeoJSON(p, bounds, normalizeOrder(parcelPolygonOrder || polygonOrder));
                const normRings = (Array.isArray(norm) && Array.isArray(norm[0]) && Array.isArray(norm[0][0])) ? norm : (norm ? [norm] : null);
                const hasOuter = normRings && normRings[0] && normRings[0].length >= 3;
                if (hasOuter) {
                    // Neighbours are context only — they never influence the screenshot's bounds.
                    // The main proposal polygon (and parcelPolygons, the proposal's own parent parcels)
                    // define the framing; neighbours only get drawn as outlines if they overlap.
                    allPolygons.push({ coords: norm, style: { color: '#000000', weight: 4, opacity: 1, dashArray: '6 4' } });
                }
            }
        }

        // Final sanity check on bbox before padding - if still looks wrong, abort with error
        const bboxLooksInvalid = (lngMin > 180 || lngMax > 180 || lngMin < -180 || lngMax < -180 ||
            latMin > 90 || latMax > 90 || latMin < -90 || latMax < -90 ||
            (lngMax - lngMin) > 10 || (latMax - latMin) > 10); // More than 10 degrees span is suspicious
        if (bboxLooksInvalid) {
            console.error('[captureViaTileStitch] Final bbox looks invalid, aborting:', { lngMin, lngMax, latMin, latMax });
            throw new Error('Invalid bounding box computed for tile stitch - coordinates may be malformed');
        }

        // Apply padding
        const lngSpan = lngMax - lngMin;
        const latSpan = latMax - latMin;
        const padLng = lngSpan * padding;
        const padLat = latSpan * padding;
        lngMin -= padLng;
        lngMax += padLng;
        latMin -= padLat;
        latMax += padLat;

        // Compute best zoom so we don't request too many tiles
        const effectiveZoom = computeBestZoomForBbox(lngMin, lngMax, latMin, latMax, MAX_STITCH_TILES_PER_AXIS, 14, zoom);
        if (effectiveZoom !== zoom) {
        }


        const dataUrl = await stitchTilesAndDrawPolygons({
            lngMin,
            lngMax,
            latMin,
            latMax,
            zoom: effectiveZoom,
            tileUrl,
            polygons: allPolygons,
            label: parcelLabel,
            badge
        });

        return dataUrl;
    }

    /**
     * Normalize various polygon formats to GeoJSON [lng, lat] array.
     * The input may come in different formats:
     * - GeoJSON: [[lng, lat], ...]
     * - Leaflet: [[lat, lng], ...] or [{lat, lng}, ...]
     * - Nested: [[[lng, lat], ...]] (polygon with outer ring)
     * @param {string|boolean} inputOrder - 'lnglat' (already GeoJSON), 'latlng' (Leaflet order, needs swap), 'auto' or false/true for legacy
     */
    let normalizeToGeoJSONCallDepth = 0;
    function normalizeToGeoJSON(polygon, fallbackBounds, inputOrder = 'auto') {
        normalizeToGeoJSONCallDepth++;
        const depth = normalizeToGeoJSONCallDepth;
        if (depth > 20) {
            console.error('[normalizeToGeoJSON] RECURSION LIMIT REACHED, depth:', depth);
            normalizeToGeoJSONCallDepth--;
            return null;
        }
        if (!polygon) {
            normalizeToGeoJSONCallDepth--;
            return null;
        }

        // Normalize legacy boolean to string
        let orderHint = inputOrder;
        if (inputOrder === true) orderHint = 'lnglat';
        else if (inputOrder === false) orderHint = 'auto';

        const normalizePair = (a, b) => {
            if (orderHint === 'lnglat') return [a, b];
            if (orderHint === 'latlng') return [b, a];

            // Use bounds heuristic when available
            if (fallbackBounds && typeof fallbackBounds.contains === 'function' && globalScope.L) {
                const asLatLng = globalScope.L.latLng(a, b);
                const asLngLat = globalScope.L.latLng(b, a);
                const containsLatLng = fallbackBounds.contains(asLatLng);
                const containsLngLat = fallbackBounds.contains(asLngLat);
                if (containsLatLng && !containsLngLat) return [b, a];
                if (containsLngLat && !containsLatLng) return [a, b];
                const center = fallbackBounds.getCenter();
                if (center && typeof center.distanceTo === 'function') {
                    const distLatLng = center.distanceTo(asLatLng);
                    const distLngLat = center.distanceTo(asLngLat);
                    return distLatLng < distLngLat ? [b, a] : [a, b];
                }
            }

            // Magnitude heuristic
            if (Math.abs(a) > 90 && Math.abs(b) <= 90) return [a, b];
            if (Math.abs(b) > 90 && Math.abs(a) <= 90) return [b, a];
            // Default to Leaflet order
            return [b, a];
        };

        // If already [[lng,lat],...] GeoJSON style or nested rings
        if (Array.isArray(polygon) && polygon.length > 0) {
            const first = polygon[0];

            // MultiPolygon: [[[ [lng,lat], ... ]], [[...]], ...] → flatten to array of rings
            if (Array.isArray(first) && Array.isArray(first[0]) && Array.isArray(first[0][0]) && typeof first[0][0][0] === 'number') {
                normalizeToGeoJSONCallDepth--;
                return polygon
                    .flatMap(poly => Array.isArray(poly) ? poly : [])
                    .map(ring => Array.isArray(ring) ? ring.map(c => normalizePair(c[0], c[1])) : ring)
                    .filter(ring => Array.isArray(ring) && ring.length >= 3);
            }

            // Polygon with rings/holes: [ring, hole1, ...]
            if (Array.isArray(first) && Array.isArray(first[0]) && first[0].length >= 2 && typeof first[0][0] === 'number') {
                normalizeToGeoJSONCallDepth--;
                return polygon.map(ring => ring.map(c => normalizePair(c[0], c[1])));
            }

            // Array of [number, number]
            if (Array.isArray(first) && first.length >= 2 && typeof first[0] === 'number') {
                normalizeToGeoJSONCallDepth--;
                return polygon.map(c => normalizePair(c[0], c[1]));
            }

            // Array of {lat, lng} objects
            if (typeof first === 'object' && 'lat' in first && 'lng' in first) {
                normalizeToGeoJSONCallDepth--;
                return polygon.map(c => [c.lng, c.lat]);
            }

            // Nested rings (polygon with holes) - recurse on first ring
            if (Array.isArray(first) && Array.isArray(first[0])) {
                const result = normalizeToGeoJSON(first, fallbackBounds, inputOrder);
                normalizeToGeoJSONCallDepth--;
                return result;
            }
        }

        // GeoJSON object support
        if (polygon && typeof polygon === 'object' && typeof polygon.type === 'string' && Array.isArray(polygon.coordinates)) {
            if (polygon.type === 'Polygon' && Array.isArray(polygon.coordinates[0])) {
                normalizeToGeoJSONCallDepth--;
                return polygon.coordinates.map(ring => ring.map(c => normalizePair(c[0], c[1])));
            }
            if (polygon.type === 'MultiPolygon' && Array.isArray(polygon.coordinates[0])) {
                const firstPoly = polygon.coordinates[0];
                if (Array.isArray(firstPoly)) {
                    normalizeToGeoJSONCallDepth--;
                    return firstPoly.map(ring => ring.map(c => normalizePair(c[0], c[1])));
                }
            }
        }

        // Leaflet LatLng or similar
        if (polygon && typeof polygon.lat === 'number' && typeof polygon.lng === 'number') {
            normalizeToGeoJSONCallDepth--;
            return [[polygon.lng, polygon.lat]];
        }

        normalizeToGeoJSONCallDepth--;
        return null;
    }

    function waitForTileLayer(tileLayer, timeoutMs = 2000) {
        if (!tileLayer || typeof tileLayer.on !== 'function') {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            let resolved = false;
            const done = () => {
                if (resolved) return;
                resolved = true;
                tileLayer.off('load', onLoad);
                tileLayer.off('error', onLoad);
                clearTimeout(timer);
                resolve();
            };
            const onLoad = () => done();
            const timer = setTimeout(done, timeoutMs);
            tileLayer.on('load', onLoad);
            tileLayer.on('error', onLoad);
        });
    }

    function loadLeafletImage() {
        if (leafletImageLoaded) return Promise.resolve();
        if (leafletImageLoading) {
            return new Promise(resolve => {
                const check = setInterval(() => {
                    if (leafletImageLoaded) {
                        clearInterval(check);
                        resolve();
                    }
                }, 100);
            });
        }
        leafletImageLoading = true;
        return new Promise((resolve, reject) => {
            if (typeof globalScope.leafletImage === 'function') {
                leafletImageLoaded = true;
                leafletImageLoading = false;
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = '/vendor/leaflet-image.js';
            script.onload = () => {
                leafletImageLoaded = typeof globalScope.leafletImage === 'function';
                leafletImageLoading = false;
                if (leafletImageLoaded) {
                    resolve();
                } else {
                    reject(new Error('leaflet-image script loaded but leafletImage function unavailable'));
                }
            };
            script.onerror = () => {
                leafletImageLoading = false;
                reject(new Error('Failed to load leaflet-image library'));
            };
            document.head.appendChild(script);
        });
    }

    function normalizePolygon(polygon, fallbackBounds, polygonOrder = 'auto') {
        if (!globalScope.L) {
            return null;
        }

        const isLatLng = (value) => value && typeof value.lat === 'number' && typeof value.lng === 'number';
        const isPointLike = (value) => {
            if (!value) return false;
            if (Array.isArray(value) && value.length >= 2) {
                return Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
            }
            if (typeof value.lat === 'number' && typeof value.lng === 'number') return true;
            if (typeof value.latitude === 'number' && typeof value.longitude === 'number') return true;
            return false;
        };

        const canUseBounds = fallbackBounds && typeof fallbackBounds.contains === 'function' && typeof fallbackBounds.getCenter === 'function';
        const chooseByBounds = (latLngCandidate, swappedCandidate) => {
            if (!canUseBounds || !latLngCandidate || !swappedCandidate || !globalScope.L || typeof latLngCandidate.distanceTo !== 'function') {
                return null;
            }
            const containsLatLng = fallbackBounds.contains(latLngCandidate);
            const containsSwapped = fallbackBounds.contains(swappedCandidate);
            if (containsLatLng && !containsSwapped) return latLngCandidate;
            if (containsSwapped && !containsLatLng) return swappedCandidate;
            const center = fallbackBounds.getCenter();
            if (!center || typeof center.distanceTo !== 'function') return null;
            const distLatLng = center.distanceTo(latLngCandidate);
            const distSwapped = center.distanceTo(swappedCandidate);
            return distLatLng <= distSwapped ? latLngCandidate : swappedCandidate;
        };

        const normalizeRing = (ring) => {
            const latLngs = [];
            const pushLatLng = (lat, lng) => {
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                    return;
                }
                latLngs.push(globalScope.L.latLng(lat, lng));
            };

            (Array.isArray(ring) ? ring : []).forEach(coord => {
                if (!coord) return;
                if (Array.isArray(coord) && coord.length >= 2) {
                    let a = Number(coord[0]);
                    let b = Number(coord[1]);
                    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
                    // Handle explicit order hints
                    if (polygonOrder === 'lnglat') {
                        // Input is [lng, lat], need to push as (lat, lng) for L.latLng
                        pushLatLng(b, a);
                        return;
                    }
                    if (polygonOrder === 'latlng') {
                        // Input is [lat, lng], push directly
                        pushLatLng(a, b);
                        return;
                    }
                    const latLngCandidate = globalScope.L ? globalScope.L.latLng(a, b) : null;
                    const swappedCandidate = globalScope.L ? globalScope.L.latLng(b, a) : null;
                    const boundsChoice = chooseByBounds(latLngCandidate, swappedCandidate);
                    if (boundsChoice) {
                        latLngs.push(boundsChoice);
                        return;
                    }
                    // Treat GeoJSON order [lng, lat] as default; fall back to [lat, lng] when obvious
                    const looksLikeLonLat = Math.abs(a) <= 180 && Math.abs(b) <= 90;
                    if (looksLikeLonLat) {
                        pushLatLng(b, a);
                    } else if (Math.abs(a) > 90 && Math.abs(b) <= 90) {
                        pushLatLng(b, a);
                    } else {
                        pushLatLng(a, b);
                    }
                } else if (typeof coord.lat === 'number' && typeof coord.lng === 'number') {
                    pushLatLng(coord.lat, coord.lng);
                } else if (typeof coord.latitude === 'number' && typeof coord.longitude === 'number') {
                    pushLatLng(coord.latitude, coord.longitude);
                }
            });

            if (latLngs.length >= 3) {
                const first = latLngs[0];
                const last = latLngs[latLngs.length - 1];
                if (!first.equals(last)) {
                    latLngs.push(first);
                }
                return latLngs;
            }
            return null;
        };

        const normalizeLatLngs = (input) => {
            if (!Array.isArray(input) || input.length === 0) return null;

            // Ring: [ [lat,lng], ... ] or [ {lat,lng}, ... ]
            if (isPointLike(input[0])) {
                return normalizeRing(input);
            }

            // Polygon with holes: [ ring, hole1, hole2... ]
            if (Array.isArray(input[0]) && input[0].length && isPointLike(input[0][0])) {
                const rings = input.map(normalizeRing).filter(r => r && r.length >= 3);
                return rings.length ? rings : null;
            }

            // MultiPolygon: [ [rings...], [rings...] ... ]
            if (Array.isArray(input[0]) && Array.isArray(input[0][0]) && input[0][0].length && isPointLike(input[0][0][0])) {
                const polys = input
                    .map(polyRings => (Array.isArray(polyRings) ? polyRings : []).map(normalizeRing).filter(r => r && r.length >= 3))
                    .filter(rings => rings.length > 0);
                return polys.length ? polys : null;
            }

            return null;
        };

        const normalized = normalizeLatLngs(polygon);
        if (normalized) {
            return normalized;
        }

        if (fallbackBounds && typeof fallbackBounds.getSouthWest === 'function') {
            const sw = fallbackBounds.getSouthWest();
            const ne = fallbackBounds.getNorthEast();
            return [
                globalScope.L.latLng(sw.lat, sw.lng),
                globalScope.L.latLng(sw.lat, ne.lng),
                globalScope.L.latLng(ne.lat, ne.lng),
                globalScope.L.latLng(ne.lat, sw.lng),
                globalScope.L.latLng(sw.lat, sw.lng)
            ];
        }

        return null;
    }

    // Extract the first ring from a normalized polygon and ensure it has enough points
    function hasValidRing(norm, minPoints = 3) {
        if (!Array.isArray(norm) || norm.length === 0) return false;

        // Simple ring: [LatLng, LatLng, ...]
        if (!Array.isArray(norm[0])) {
            return norm.length >= minPoints;
        }

        // Polygon with holes: [[LatLng...], [LatLng...], ...]
        if (Array.isArray(norm[0]) && !Array.isArray(norm[0][0])) {
            return norm[0].length >= minPoints;
        }

        // MultiPolygon: [[[LatLng...], ...], ...]
        if (Array.isArray(norm[0]) && Array.isArray(norm[0][0])) {
            const firstRing = norm[0][0];
            return Array.isArray(firstRing) && firstRing.length >= minPoints;
        }

        return false;
    }

    function destroyPreviewMap(container) {
        if (container && container._leafletPreviewMap) {
            try {
                container._leafletPreviewMap.remove();
            } catch (_) { }
            container._leafletPreviewMap = null;
        }
        if (container) {
            container.innerHTML = '';
        }
    }

    function renderPolygonPreview(container, options = {}) {
        if (window?.__DEBUG_SCREENSHOT_TIMING__) {
            console.debug('[renderPolygonPreview] options', {
                hasPolygon: !!options.polygon,
                polygonLength: options.polygon?.length,
                parcelPolygonsCount: options.parcelPolygons?.length,
                fitToPolygonOnly: options.fitToPolygonOnly,
                polygonOrder: options.polygonOrder
            });
        }
        if (!globalScope.L) {
            throw new Error('Leaflet library is not available.');
        }
        if (!container) {
            throw new Error('Preview container is required.');
        }

        const {
            polygon,
            bounds = null,
            padding = 0.05,
            tileUrl = DEFAULT_TILE_URL,
            tileOptions = {},
            parcelPolygons = [],
            neighbours = [],
            parcelLabel = null,
            fitToPolygonOnly = false,
            polygonOrder = 'auto',
            parcelPolygonOrder = 'auto'
        } = options;

        destroyPreviewMap(container);

        const normalized = normalizePolygon(polygon, bounds, polygonOrder);
        if (!normalized) {
            container.textContent = 'Preview unavailable';
            container.style.color = '#999';
            return;
        }

        const polygonLayer = globalScope.L.polygon(normalized, {
            color: '#ff6600',
            weight: 3,
            opacity: 0.9,
            fillColor: '#ff6600',
            fillOpacity: 0.18,
            lineJoin: 'round',
            lineCap: 'round'
        });

        const parcelLayers = [];
        if (Array.isArray(parcelPolygons) && parcelPolygons.length) {
            parcelPolygons.forEach(poly => {
                const norm = normalizePolygon(poly, bounds, parcelPolygonOrder || polygonOrder);
                if (hasValidRing(norm)) {
                    try {
                        parcelLayers.push(globalScope.L.polygon(norm, {
                            color: '#000',
                            weight: 2.5,
                            opacity: 1,
                            dashArray: '3 2',
                            fill: false,
                            lineJoin: 'round',
                            lineCap: 'round'
                        }));
                    } catch (err) {
                        console.warn('Failed to prepare parcel polygon for preview', err);
                    }
                }
            });
        }

        const neighbourLayers = [];
        if (Array.isArray(neighbours) && neighbours.length) {
            neighbours.forEach(poly => {
                const norm = normalizePolygon(poly, bounds, parcelPolygonOrder || polygonOrder);
                if (hasValidRing(norm)) {
                    try {
                        neighbourLayers.push(globalScope.L.polygon(norm, {
                            color: '#000000',
                            weight: 4,
                            opacity: 1,
                            dashArray: '6 4',
                            fill: false,
                            lineJoin: 'round',
                            lineCap: 'round'
                        }));
                    } catch (err) {
                        console.warn('Failed to prepare neighbour polygon for capture', err);
                    }
                }
            });
        }

        // Expand view to include neighbours/parcel outlines if they extend beyond the main polygon
        let combinedBounds = polygonLayer.getBounds();
        const expandBoundsWithLayer = (layer) => {
            if (layer && typeof layer.getBounds === 'function') {
                const b = layer.getBounds();
                if (b && typeof combinedBounds.extend === 'function') {
                    combinedBounds.extend(b);
                }
            }
        };
        if (!fitToPolygonOnly) {
            parcelLayers.forEach(expandBoundsWithLayer);
        }

        const paddedBounds = typeof combinedBounds.pad === 'function'
            ? combinedBounds.pad(Math.max(0, padding || 0))
            : combinedBounds;

        const mapContainer = document.createElement('div');
        mapContainer.style.width = '100%';
        mapContainer.style.height = '100%';
        mapContainer.style.pointerEvents = 'none';
        container.appendChild(mapContainer);

        const map = globalScope.L.map(mapContainer, {
            attributionControl: false,
            zoomControl: false,
            zoomAnimation: false,
            boxZoom: false,
            doubleClickZoom: false,
            scrollWheelZoom: false,
            dragging: false,
            keyboard: false,
            tap: false,
            touchZoom: false
        });

        const tileLayer = globalScope.L.tileLayer(tileUrl, Object.assign({
            maxZoom: 19,
            crossOrigin: true
        }, tileOptions)).addTo(map);

        map.fitBounds(paddedBounds, { animate: false });
        map.whenReady(() => {
            try {
                polygonLayer.addTo(map);
            } catch (err) {
                console.warn('Failed to render proposal polygon for preview', err);
                map.remove();
                container.innerHTML = '';
                container.style.color = '#999';
                container.textContent = 'Preview unavailable';
                container._leafletPreviewMap = null;
                return;
            }

            if (parcelLayers.length > 0) {
                const parcelGroup = globalScope.L.layerGroup().addTo(map);
                parcelLayers.forEach(layer => {
                    try {
                        layer.addTo(parcelGroup);
                    } catch (err) {
                        console.warn('Failed to render parcel polygon for preview', err);
                    }
                });
                try { parcelGroup.bringToFront(); } catch (_) { }
            }

            if (neighbourLayers.length > 0) {
                const neighbourGroup = globalScope.L.layerGroup().addTo(map);
                neighbourLayers.forEach(layer => {
                    try {
                        layer.addTo(neighbourGroup);
                    } catch (err) {
                        console.warn('Failed to render neighbour polygon for preview', err);
                    }
                });
                try { neighbourGroup.bringToFront(); } catch (_) { }
            }

            if (parcelLabel) {
                try {
                    const labelLatLng = polygonLayer.getBounds().getCenter();
                    const labelMarker = globalScope.L.marker(labelLatLng, {
                        interactive: false,
                        icon: globalScope.L.divIcon({
                            className: 'parcel-label-marker',
                            html: `<div style="padding:4px 8px;border:1px solid #0f172a;border-radius:6px;background:rgba(255,255,255,0.86);color:#0f172a;font:700 14px/1.2 'Helvetica Neue', Arial, sans-serif;box-shadow:0 1px 4px rgba(0,0,0,0.18);">${parcelLabel}</div>`,
                            iconSize: null
                        })
                    }).addTo(map);
                    try { labelMarker.bringToFront(); } catch (_) { }
                } catch (err) {
                    console.warn('Failed to render parcel label for preview', err);
                }
            }

            setTimeout(() => map.invalidateSize(), 0);
        });

        container._leafletPreviewMap = map;
    }

    async function capturePolygonImage(options = {}) {
        if (!globalScope.L) throw new Error('Leaflet library is not available.');

        const {
            polygon,
            bounds = null,
            padding = 0.05,
            size = 512,
            tileUrl = DEFAULT_TILE_URL,
            tileOptions = {},
            parcelPolygons = [],
            neighbours = [],
            parcelLabel = null,
            badge = null,
            polygonOrder = 'auto',
            parcelPolygonOrder = 'auto'
        } = options;

        const normalized = normalizePolygon(polygon, bounds, polygonOrder);
        if (!normalized) {
            throw new Error('Invalid polygon supplied for capture.');
        }

        await loadLeafletImage();

        const container = document.createElement('div');
        container.style.position = 'absolute';
        container.style.top = '-10000px';
        container.style.left = '-10000px';
        container.style.width = `${size}px`;
        container.style.height = `${size}px`;
        container.style.pointerEvents = 'none';
        container.style.opacity = '0';
        document.body.appendChild(container);

        const polygonLayer = globalScope.L.polygon(normalized, {
            color: '#ff6600',
            weight: 3,
            opacity: 0.9,
            fillColor: '#ff6600',
            fillOpacity: 0.18,
            lineJoin: 'round',
            lineCap: 'round'
        });

        const parcelLayers = [];
        if (Array.isArray(parcelPolygons) && parcelPolygons.length) {
            parcelPolygons.forEach(poly => {
                const norm = normalizePolygon(poly, bounds, parcelPolygonOrder || polygonOrder);
                if (hasValidRing(norm)) {
                    try {
                        parcelLayers.push(globalScope.L.polygon(norm, {
                            color: '#0f172a',
                            weight: 2.5,
                            opacity: 1,
                            dashArray: '3 2',
                            fill: false,
                            lineJoin: 'round',
                            lineCap: 'round'
                        }));
                    } catch (err) {
                        console.warn('Failed to prepare parcel polygon for capture', err);
                    }
                }
            });
        }

        const neighbourLayers = [];
        if (Array.isArray(neighbours) && neighbours.length) {
            neighbours.forEach(poly => {
                const norm = normalizePolygon(poly, bounds, parcelPolygonOrder || polygonOrder);
                if (hasValidRing(norm)) {
                    try {
                        neighbourLayers.push(globalScope.L.polygon(norm, {
                            color: '#000000',
                            weight: 4,
                            opacity: 1,
                            dashArray: '6 4',
                            fill: false,
                            lineJoin: 'round',
                            lineCap: 'round'
                        }));
                    } catch (err) {
                        console.warn('Failed to prepare neighbour polygon for capture', err);
                    }
                }
            });
        }

        // Fit view to proposal polygon + parcel outlines, but NOT neighbours
        // (neighbours provide context but can be clipped by the viewport)
        let combinedBounds = polygonLayer.getBounds();
        const expandBoundsWithLayer = (layer) => {
            if (layer && typeof layer.getBounds === 'function') {
                const b = layer.getBounds();
                if (b && typeof combinedBounds.extend === 'function') {
                    combinedBounds.extend(b);
                }
            }
        };
        parcelLayers.forEach(expandBoundsWithLayer);

        const paddedBounds = typeof combinedBounds.pad === 'function'
            ? combinedBounds.pad(Math.max(0, padding || 0))
            : combinedBounds;

        const map = globalScope.L.map(container, {
            attributionControl: false,
            zoomControl: false,
            zoomAnimation: false,
            fadeAnimation: false,
            inertia: false
        });

        const tileLayer = globalScope.L.tileLayer(tileUrl, Object.assign({
            maxZoom: 19,
            crossOrigin: true
        }, tileOptions)).addTo(map);

        map.fitBounds(paddedBounds, { animate: false });
        await new Promise(resolve => map.whenReady(resolve));

        // Wait for tiles to load (with timeout fallback)
        await waitForTileLayer(tileLayer, 5000);

        try {
            polygonLayer.addTo(map);
        } catch (err) {
            map.remove();
            container.remove();
            throw new Error(`Failed to render proposal polygon for capture: ${err.message || err}`);
        }

        if (parcelLayers.length > 0) {
            const parcelGroup = globalScope.L.layerGroup().addTo(map);
            parcelLayers.forEach(layer => {
                try {
                    layer.addTo(parcelGroup);
                } catch (err) {
                    console.warn('Failed to render parcel polygon in capture', err);
                }
            });
            try { parcelGroup.bringToFront(); } catch (_) { }
        }

        if (neighbourLayers.length > 0) {
            const neighbourGroup = globalScope.L.layerGroup().addTo(map);
            neighbourLayers.forEach(layer => {
                try {
                    layer.addTo(neighbourGroup);
                } catch (err) {
                    console.warn('Failed to render neighbour polygon for capture', err);
                }
            });
            try { neighbourGroup.bringToFront(); } catch (_) { }
        }

        let labelMarker = null;
        if (parcelLabel) {
            try {
                const labelLatLng = polygonLayer.getBounds().getCenter();
                labelMarker = globalScope.L.marker(labelLatLng, {
                    interactive: false,
                    icon: globalScope.L.divIcon({
                        className: 'parcel-label-marker',
                        html: `<div style="padding:4px 8px;border:1px solid #0f172a;border-radius:6px;background:rgba(255,255,255,0.86);color:#0f172a;font:700 14px/1.2 'Helvetica Neue', Arial, sans-serif;box-shadow:0 1px 4px rgba(0,0,0,0.18);">${parcelLabel}</div>`,
                        iconSize: null
                    })
                }).addTo(map);
                try { labelMarker.bringToFront(); } catch (_) { }
            } catch (err) {
                console.warn('Failed to render parcel label for capture', err);
            }
        }

        const dataUrl = await new Promise((resolve, reject) => {
            globalScope.leafletImage(map, (err, canvas) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(canvas.toDataURL('image/png'));
            });
        });

        map.remove();
        container.remove();

        const finalUrl = await overlayBadgeOnDataUrl(dataUrl, badge);
        return finalUrl;
    }

    /**
     * Capture an image from an existing preview map container.
     * This reuses the tiles that are already loaded in the preview, avoiding a re-fetch.
     * @param {HTMLElement} container - The container that was passed to renderPolygonPreview
     * @returns {Promise<string>} - A data URL of the captured image
     */
    async function captureFromPreview(container, options = {}) {
        if (!container) {
            throw new Error('Preview container is required for capture.');
        }

        const { badge = null } = options || {};

        const map = container._leafletPreviewMap;
        if (!map) {
            throw new Error('No preview map found in container. Ensure renderPolygonPreview was called first.');
        }

        try {
            await loadLeafletImage();
        } catch (loadErr) {
            throw new Error(`Failed to load leaflet-image library: ${loadErr.message}`);
        }

        // Wait for the base tile layer to finish so we don't capture a blank canvas
        const tileLayer = (() => {
            let found = null;
            if (map && typeof map.eachLayer === 'function' && globalScope.L && globalScope.L.TileLayer) {
                map.eachLayer(layer => {
                    if (!found && layer instanceof globalScope.L.TileLayer) {
                        found = layer;
                    }
                });
            }
            return found;
        })();
        if (tileLayer) {
            await waitForTileLayer(tileLayer, 5000);
        }

        if (typeof globalScope.leafletImage !== 'function') {
            throw new Error('leafletImage function not available after loading.');
        }

        const dataUrl = await new Promise((resolve, reject) => {
            try {
                globalScope.leafletImage(map, (err, canvas) => {
                    if (err) {
                        reject(new Error(`leafletImage callback error: ${err.message || err}`));
                        return;
                    }
                    if (!canvas) {
                        reject(new Error('leafletImage returned no canvas'));
                        return;
                    }
                    try {
                        const url = canvas.toDataURL('image/png');
                        resolve(url);
                    } catch (canvasErr) {
                        reject(new Error(`Canvas toDataURL failed: ${canvasErr.message}`));
                    }
                });
            } catch (callErr) {
                reject(new Error(`leafletImage call failed: ${callErr.message}`));
            }
        });

        const finalUrl = await overlayBadgeOnDataUrl(dataUrl, badge);
        return finalUrl;
    }

    globalScope.MapScreenshot = {
        renderPolygonPreview,
        capturePolygonImage,
        captureFromPreview,
        captureViaTileStitch
    };
})();

