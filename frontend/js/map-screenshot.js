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

        console.log('[stitchTiles] Starting with opts:', { lngMin, lngMax, latMin, latMax, zoom, tileUrl, polygonCount: polygons.length });

        // Compute tile range
        const xMin = lngToTileX(lngMin, zoom);
        const xMax = lngToTileX(lngMax, zoom);
        const yMin = latToTileY(latMax, zoom); // note: higher lat = lower tile Y
        const yMax = latToTileY(latMin, zoom);

        const tilesX = xMax - xMin + 1;
        const tilesY = yMax - yMin + 1;

        console.log(`[stitchTiles] bbox: lng ${lngMin.toFixed(6)}..${lngMax.toFixed(6)}, lat ${latMin.toFixed(6)}..${latMax.toFixed(6)}`);
        console.log(`[stitchTiles] tiles: x=${xMin}..${xMax} (${tilesX}), y=${yMin}..${yMax} (${tilesY}), zoom=${zoom}`);
        if (tilesX * tilesY > 9) {
            console.warn('[stitchTiles] Large tile fetch:', { tilesX, tilesY });
        }

        const canvasWidth = tilesX * TILE_SIZE;
        const canvasHeight = tilesY * TILE_SIZE;

        console.log(`[stitchTiles] canvas size: ${canvasWidth}x${canvasHeight}`);

        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('2d');

        // Fill with light gray in case tiles fail
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

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

        console.log(`[stitchTiles] Tiles loaded: ${loadedCount}, failed: ${failedCount}`);

        // Draw polygons
        console.log(`[stitchTiles] Drawing ${polygons.length} polygons`);
        for (const poly of polygons) {
            const { coords, style = {} } = poly;
            if (!coords || coords.length < 3) {
                console.log('[stitchTiles] Skipping polygon with < 3 coords:', coords?.length);
                continue;
            }

            console.log(`[stitchTiles] Drawing polygon with ${coords.length} coords, first:`, coords[0]);

            ctx.beginPath();
            let first = true;
            for (const coord of coords) {
                // coord is [lng, lat] GeoJSON order
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

            if (style.fillColor && style.fillOpacity > 0) {
                ctx.fillStyle = hexToRgba(style.fillColor, style.fillOpacity || 0.2);
                ctx.fill();
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

        return canvas.toDataURL('image/png');
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
        console.log('[captureViaTileStitch] Called with options:', {
            polygonLength: options.polygon?.length,
            polygonSample: options.polygon?.slice ? options.polygon.slice(0, 3) : options.polygon,
            bounds: options.bounds ? 'present' : 'null',
            padding: options.padding,
            parcelPolygonsCount: options.parcelPolygons?.length,
            zoom: options.zoom,
            tileUrl: options.tileUrl || DEFAULT_TILE_URL
        });

        const {
            polygon,
            bounds = null,
            padding = 0.05,
            tileUrl = DEFAULT_TILE_URL,
            parcelPolygons = [],
            neighbours = [],
            parcelLabel = null,
            zoom = DEFAULT_STITCH_ZOOM,
            badge = null
        } = options;

        // Normalize polygon to GeoJSON-order [lng, lat] rings
        const geoCoords = normalizeToGeoJSON(polygon, bounds);
        console.log('[captureViaTileStitch] Normalized geoCoords:', geoCoords?.length, 'first 3:', geoCoords?.slice(0, 3));

        if (!geoCoords || geoCoords.length < 3) {
            console.error('[captureViaTileStitch] Invalid polygon - geoCoords:', geoCoords);
            throw new Error('Invalid polygon for tile stitch capture');
        }

        // Compute bbox from all coordinates
        let lngMin = Infinity, lngMax = -Infinity, latMin = Infinity, latMax = -Infinity;
        const expandBbox = (coords) => {
            for (const c of coords) {
                if (c[0] < lngMin) lngMin = c[0];
                if (c[0] > lngMax) lngMax = c[0];
                if (c[1] < latMin) latMin = c[1];
                if (c[1] > latMax) latMax = c[1];
            }
        };
        expandBbox(geoCoords);

        console.log('[captureViaTileStitch] Initial bbox from main polygon:', { lngMin, lngMax, latMin, latMax });

        // Expand bbox for parcels and neighbours
        const allPolygons = [
            { coords: geoCoords, style: { color: '#ff6600', weight: 3, opacity: 0.9, fillColor: '#ff6600', fillOpacity: 0.18, lineJoin: 'round', lineCap: 'round' } }
        ];

        if (Array.isArray(parcelPolygons)) {
            for (const p of parcelPolygons) {
                const norm = normalizeToGeoJSON(p, bounds);
                if (norm && norm.length >= 3) {
                    expandBbox(norm);
                    allPolygons.push({ coords: norm, style: { color: '#000', weight: 2.5, opacity: 1, dashArray: '3 2' } });
                }
            }
        }

        if (Array.isArray(neighbours)) {
            for (const p of neighbours) {
                const norm = normalizeToGeoJSON(p, bounds);
                if (norm && norm.length >= 3) {
                    expandBbox(norm);
                    allPolygons.push({ coords: norm, style: { color: '#000000', weight: 4, opacity: 1, dashArray: '6 4' } });
                }
            }
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

        console.log('[captureViaTileStitch] Final bbox after padding:', { lngMin, lngMax, latMin, latMax });
        console.log('[captureViaTileStitch] Total polygons to draw:', allPolygons.length);

        const dataUrl = await stitchTilesAndDrawPolygons({
            lngMin,
            lngMax,
            latMin,
            latMax,
            zoom,
            tileUrl,
            polygons: allPolygons,
            label: parcelLabel,
            badge
        });

        console.log('[captureViaTileStitch] Result data URL length:', dataUrl?.length);
        return dataUrl;
    }

    /**
     * Normalize various polygon formats to GeoJSON [lng, lat] array.
     * The input may come in different formats:
     * - GeoJSON: [[lng, lat], ...]
     * - Leaflet: [[lat, lng], ...] or [{lat, lng}, ...]
     * - Nested: [[[lng, lat], ...]] (polygon with outer ring)
     */
    function normalizeToGeoJSON(polygon, fallbackBounds) {
        if (!polygon) return null;

        // If already [[lng,lat],...] GeoJSON style
        if (Array.isArray(polygon) && polygon.length > 0) {
            const first = polygon[0];

            // Array of [number, number]
            if (Array.isArray(first) && first.length >= 2 && typeof first[0] === 'number') {
                // Determine if this is [lat, lng] (Leaflet) or [lng, lat] (GeoJSON)
                // by looking at the first coordinate pair
                const a = first[0], b = first[1];

                // Heuristic: For European coordinates like Zagreb (lat ~45.8, lng ~15.9),
                // both values are within ±90, making it ambiguous.
                // Use fallbackBounds to disambiguate if available.
                let isLatLngOrder = false; // assume GeoJSON [lng, lat] by default

                if (fallbackBounds && typeof fallbackBounds.contains === 'function' && globalScope.L) {
                    // Test if [a, b] interpreted as [lat, lng] is within bounds
                    const asLatLng = globalScope.L.latLng(a, b);
                    const asLngLat = globalScope.L.latLng(b, a);
                    const containsLatLng = fallbackBounds.contains(asLatLng);
                    const containsLngLat = fallbackBounds.contains(asLngLat);

                    if (containsLatLng && !containsLngLat) {
                        isLatLngOrder = true;
                    } else if (containsLngLat && !containsLatLng) {
                        isLatLngOrder = false;
                    } else if (containsLatLng && containsLngLat) {
                        // Both interpretations are within bounds - use distance from center
                        const center = fallbackBounds.getCenter();
                        const distLatLng = center.distanceTo(asLatLng);
                        const distLngLat = center.distanceTo(asLngLat);
                        isLatLngOrder = distLatLng < distLngLat;
                    }
                    // If neither is contained, fallthrough to magnitude-based heuristic
                }

                // Fallback heuristic based on typical coordinate magnitudes
                if (!fallbackBounds) {
                    // If |a| > 90, a must be longitude (since lat is bounded [-90, 90])
                    if (Math.abs(a) > 90 && Math.abs(b) <= 90) {
                        isLatLngOrder = false; // a is lng, b is lat → [lng, lat]
                    } else if (Math.abs(b) > 90 && Math.abs(a) <= 90) {
                        isLatLngOrder = true; // a is lat, b is lng → [lat, lng]
                    }
                    // If both within ±90, assume Leaflet [lat, lng] order since that's
                    // what proposals.js uses for combinedPolygon
                    else {
                        isLatLngOrder = true;
                    }
                }

                return polygon.map(c => {
                    const v0 = c[0], v1 = c[1];
                    if (isLatLngOrder) {
                        return [v1, v0]; // [lat, lng] → [lng, lat]
                    } else {
                        return [v0, v1]; // already [lng, lat]
                    }
                });
            }

            // Array of {lat, lng} objects
            if (typeof first === 'object' && 'lat' in first && 'lng' in first) {
                return polygon.map(c => [c.lng, c.lat]);
            }

            // Nested rings (polygon with holes) - just use outer ring
            if (Array.isArray(first) && Array.isArray(first[0])) {
                return normalizeToGeoJSON(first, fallbackBounds);
            }
        }

        // Leaflet LatLng or similar
        if (polygon && typeof polygon.lat === 'number' && typeof polygon.lng === 'number') {
            return [[polygon.lng, polygon.lat]];
        }

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

    function normalizePolygon(polygon, fallbackBounds) {
        if (!globalScope.L) return null;

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
            parcelLabel = null
        } = options;

        destroyPreviewMap(container);

        const normalized = normalizePolygon(polygon, bounds);
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
                const norm = normalizePolygon(poly, bounds);
                if (norm && norm.length >= 3) {
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
                const norm = normalizePolygon(poly, bounds);
                if (norm && norm.length >= 2) {
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
        parcelLayers.forEach(expandBoundsWithLayer);
        neighbourLayers.forEach(expandBoundsWithLayer);

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
            badge = null
        } = options;

        const normalized = normalizePolygon(polygon, bounds);
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
                const norm = normalizePolygon(poly, bounds);
                if (norm && norm.length >= 3) {
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
                const norm = normalizePolygon(poly, bounds);
                if (norm && norm.length >= 2) {
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
        parcelLayers.forEach(expandBoundsWithLayer);
        neighbourLayers.forEach(expandBoundsWithLayer);

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

