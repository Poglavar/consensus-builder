(function attachParcelIngest(global) {
    'use strict';

    // Rendering infrastructure shared by every ParcelPresenter layer.
    let parcelCanvas = null;
    function parcelCanvasRenderer() {
        if (parcelCanvas) return parcelCanvas;
        if (!global.L || typeof global.L.canvas !== 'function') return undefined;
        const proto = global.L.Canvas && global.L.Canvas.prototype;
        const extendable = proto && typeof global.L.Canvas.extend === 'function'
            && typeof proto._requestRedraw === 'function'
            && typeof proto._extendRedrawBounds === 'function'
            && typeof proto._draw === 'function';
        if (!extendable) {
            parcelCanvas = global.L.canvas({ padding: 0.5 });
            return parcelCanvas;
        }
        const stats = {
            fullDraws: 0, fullLastMs: 0, fullMaxMs: 0, fullTotalMs: 0,
            partialDraws: 0, partialLastMs: 0, partialMaxMs: 0, partialTotalMs: 0,
            redrawsCoalesced: 0
        };
        const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
        const ParcelCanvas = global.L.Canvas.extend({
            _requestRedraw(layer) {
                if (this._holdDepth) {
                    if (!this._map) return;
                    if (layer) this._extendRedrawBounds(layer);
                    this._heldRedraw = true;
                    stats.redrawsCoalesced += 1;
                    return;
                }
                return global.L.Canvas.prototype._requestRedraw.call(this, layer);
            },
            _draw() {
                const full = !this._redrawBounds;
                const started = now();
                const result = global.L.Canvas.prototype._draw.call(this);
                const elapsed = now() - started;
                if (full) {
                    stats.fullDraws += 1;
                    stats.fullLastMs = elapsed;
                    stats.fullTotalMs += elapsed;
                    stats.fullMaxMs = Math.max(stats.fullMaxMs, elapsed);
                } else {
                    stats.partialDraws += 1;
                    stats.partialLastMs = elapsed;
                    stats.partialTotalMs += elapsed;
                    stats.partialMaxMs = Math.max(stats.partialMaxMs, elapsed);
                }
                return result;
            },
            holdRedraws() {
                this._holdDepth = (this._holdDepth || 0) + 1;
            },
            releaseRedraws() {
                if (this._holdDepth) this._holdDepth -= 1;
                if (!this._holdDepth && this._heldRedraw) {
                    this._heldRedraw = false;
                    if (this._map) {
                        this._redrawRequest = this._redrawRequest
                            || global.L.Util.requestAnimFrame(this._redraw, this);
                    }
                }
            }
        });
        parcelCanvas = new ParcelCanvas({ padding: 0.5 });
        global.__parcelCanvasStats = stats;
        return parcelCanvas;
    }

    global.parcelCanvasRenderer = parcelCanvasRenderer;
})(typeof window !== 'undefined' ? window : globalThis);
