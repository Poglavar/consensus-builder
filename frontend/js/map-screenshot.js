(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope || !globalScope.document) {
        return;
    }

    let leafletImageLoaded = typeof globalScope.leafletImage === 'function';
    let leafletImageLoading = false;

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
            tileUrl = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            tileOptions = {},
            parcelPolygons = []
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

        const polygonBounds = polygonLayer.getBounds();
        const paddedBounds = typeof polygonBounds.pad === 'function'
            ? polygonBounds.pad(Math.max(0, padding || 0))
            : polygonBounds;

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

        globalScope.L.tileLayer(tileUrl, Object.assign({
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
            tileUrl = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            tileOptions = {},
            parcelPolygons = []
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

        const polygonBounds = polygonLayer.getBounds();
        const paddedBounds = typeof polygonBounds.pad === 'function'
            ? polygonBounds.pad(Math.max(0, padding || 0))
            : polygonBounds;

        const map = globalScope.L.map(container, {
            attributionControl: false,
            zoomControl: false,
            zoomAnimation: false,
            fadeAnimation: false,
            inertia: false
        });

        globalScope.L.tileLayer(tileUrl, Object.assign({
            maxZoom: 19,
            crossOrigin: true
        }, tileOptions)).addTo(map);

        map.fitBounds(paddedBounds, { animate: false });
        await new Promise(resolve => map.whenReady(resolve));

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

        return dataUrl;
    }

    globalScope.MapScreenshot = {
        renderPolygonPreview,
        capturePolygonImage
    };
})();

