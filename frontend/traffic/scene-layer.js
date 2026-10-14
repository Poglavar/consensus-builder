// Both road surfaces and vehicles participate in Leaflet's own pan/zoom transform.
(function (root) {
    'use strict';
    root.TrafficSceneLayer = L.Layer.extend({
        initialize(canvases, redraw) { this.canvases = canvases; this.redraw = redraw; this.padding = .25; },
        onAdd(map) {
            this.map = map;
            this.container = L.DomUtil.create('div', 'traffic-scene leaflet-zoom-animated');
            const pane = map.createPane('traffic-scene'); pane.style.zIndex = 450; pane.style.pointerEvents = 'none';
            pane.append(this.container);
            for (const canvas of this.canvases) this.container.append(canvas);
            this.reset();
        },
        getEvents() { return { zoomanim: this.animateZoom, zoomend: this.reset, moveend: this.reset, resize: this.reset, viewreset: this.reset }; },
        animateZoom(event) {
            this.zooming = true;
            const scale = this.map.getZoomScale(event.zoom, this.zoom);
            const panePosition = this.map.layerPointToContainerPoint([0, 0]);
            const pixelOrigin = this.map.project(event.center, event.zoom).subtract(this.map.getSize().divideBy(2)).add(panePosition).round();
            const offset = this.offset.add(this.pixelOrigin).multiplyBy(scale).subtract(pixelOrigin);
            L.DomUtil.setTransform(this.container, offset, scale);
        },
        reset() {
            if (!this.map) return;
            this.zooming = false; this.zoom = this.map.getZoom();
            this.offset = this.map.containerPointToLayerPoint(this.map.getSize().multiplyBy(-this.padding)).floor();
            this.size = this.map.getSize().multiplyBy(1 + this.padding * 2).ceil();
            this.pixelOrigin = this.map.getPixelOrigin().clone();
            L.DomUtil.setPosition(this.container, this.offset);
            const dpr = Math.min(root.devicePixelRatio || 1, 2);
            for (const canvas of this.canvases) {
                canvas.width = Math.round(this.size.x * dpr); canvas.height = Math.round(this.size.y * dpr);
                canvas.style.width = `${this.size.x}px`; canvas.style.height = `${this.size.y}px`;
                canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
            }
            this.redraw();
        },
        project(latlng) { return this.map.project(latlng, this.zoom).subtract(this.pixelOrigin).subtract(this.offset); },
        point(containerPoint) { return this.map.containerPointToLayerPoint(containerPoint).subtract(this.offset); },
        onRemove() { this.container.remove(); }
    });
})(window);
