// Continuous wheel and trackpad zoom for every Leaflet map, as Google Maps and Mapbox GL zoom: a pinch
// or two-finger scroll scales the map on every frame by what the fingers moved, a mouse-wheel notch
// eases there, and zoomend/moveend fire once when the gesture stops, so the work that listens to
// them (parcels, buildings, sources) runs once per gesture instead of on every step.
//
// The model (MapWheelZoom.createModel) is plain input -> zoom math with no DOM, tested in
// backend/test/map-wheel-zoom.test.js. The Leaflet part replaces the methods of Leaflet's own
// ScrollWheelZoom handler, so map.scrollWheelZoom.enable()/disable() and the scrollWheelZoom
// option ('center' included) keep working everywhere. Must load after Leaflet, before any map.
(function (global) {
    'use strict';

    // Safari and Firefox report each mouse-wheel notch as a multiple of this (Mapbox GL's test).
    var WHEEL_NOTCH = 4.000244140625;
    // Zoom levels per wheel pixel. A pinch reports 100 × ln(scale) (Chromium, Safari), so 1 / (100 ln 2)
    // follows the fingers exactly; a two-finger scroll moves ~3.5 levels over a 480 px swipe; a mouse
    // notch (~100 px) moves half a level, and a fast spin, sending larger deltas, moves more.
    var RATES = { pinch: 1 / (100 * Math.LN2), trackpad: 1 / 140, wheel: 1 / 200 };
    // One event never moves more than this many levels (a runaway delta from a free-spinning wheel).
    var MAX_LEVELS_PER_EVENT = 2;
    // A first event after a pause is held this long to see whether a stream (trackpad) follows.
    var CLASSIFY_MS = 40;
    var PAUSE_MS = 400;
    // A mouse notch eases to its zoom over this long; 0 jumps (reduced motion).
    var WHEEL_EASE_MS = 200;
    // The gesture has ended when no input has come for this long and the easing is done.
    var IDLE_MS = 150;

    function easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    // input(event, now) takes a wheel event's fields and says whether a frame is needed;
    // frame(now, zoom, minZoom, maxZoom) gives the zoom to show now (null: leave it) and whether
    // the gesture is done.
    function createModel(options) {
        var easeMs = options && Number.isFinite(options.easeMs) ? options.easeMs : WHEEL_EASE_MS;
        var type = null;          // 'pinch' | 'trackpad' | 'wheel' | null (not yet known)
        var pending = null;       // { value, at }: a first event waiting to be classified
        var delta = 0;            // levels to add on the next frame (positive zooms in)
        var target = null;        // the zoom the gesture is heading to
        var ease = null;          // { from, at }: a mouse notch easing from `from` since `at`
        var lastInputAt = -Infinity;

        function levels(value, kind) {
            return clamp(-value * RATES[kind], -MAX_LEVELS_PER_EVENT, MAX_LEVELS_PER_EVENT);
        }

        function input(event, now) {
            var value = event.deltaY;
            if (event.deltaMode === 1) value *= 40;
            else if (event.deltaMode === 2) value *= 800;
            if (!value) return false;
            var gap = now - lastInputAt;
            lastInputAt = now;
            if (type === 'pinch' && !event.ctrlKey) type = null;
            if (event.ctrlKey) {
                type = 'pinch';
            } else if (event.deltaMode !== 0 || value % WHEEL_NOTCH === 0) {
                type = 'wheel';
            } else if (Math.abs(value) < 4) {
                type = 'trackpad';
            } else if (gap > PAUSE_MS) {
                type = null;
                pending = { value: value, at: now };
                return true;
            } else if (!type) {
                // A trackpad streams small deltas a few milliseconds apart; a wheel sends larger ones further apart.
                type = Math.abs(gap * value) < 200 ? 'trackpad' : 'wheel';
            }
            if (pending) {
                delta += levels(pending.value, type);
                pending = null;
            }
            if (event.shiftKey) value /= 4;
            delta += levels(value, type);
            return true;
        }

        function frame(now, zoom, minZoom, maxZoom) {
            if (pending && now - pending.at >= CLASSIFY_MS) {
                type = 'wheel';
                delta += levels(pending.value, type);
                pending = null;
            }
            if (delta !== 0) {
                target = clamp((target === null ? zoom : target) + delta, minZoom, maxZoom);
                ease = type === 'wheel' && easeMs > 0 ? { from: zoom, at: now } : null;
                delta = 0;
            }
            var next = null;
            var settled = true;
            if (target !== null) {
                if (ease) {
                    var t = Math.min((now - ease.at) / easeMs, 1);
                    next = ease.from + (target - ease.from) * easeOutCubic(t);
                    settled = t >= 1;
                } else {
                    next = target;
                }
            }
            var done = settled && !pending && now - lastInputAt >= IDLE_MS;
            if (done) {
                target = null;
                ease = null;
            }
            return { zoom: next, done: done };
        }

        return { input: input, frame: frame };
    }

    var api = { createModel: createModel, RATES: RATES };
    global.MapWheelZoom = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    var L = global.L;
    if (!L || !L.Map || !L.Map.ScrollWheelZoom) return;

    // The center that keeps `anchor` (a container point) over the same ground at `zoom`, as
    // Leaflet's setZoomAround computes it.
    function centerAround(map, anchor, zoom) {
        var viewHalf = map.getSize().divideBy(2);
        var offset = anchor.subtract(viewHalf).multiplyBy(1 - 1 / map.getZoomScale(zoom));
        return map.containerPointToLatLng(viewHalf.add(offset));
    }

    L.Map.ScrollWheelZoom.include({
        addHooks: function () {
            this._model = createModel({ easeMs: this._map.options.zoomAnimation ? WHEEL_EASE_MS : 0 });
            L.DomEvent.on(this._map._container, 'wheel', this._onWheel, this);
        },

        removeHooks: function () {
            L.DomEvent.off(this._map._container, 'wheel', this._onWheel, this);
            if (this._frame) L.Util.cancelAnimFrame(this._frame);
            this._frame = null;
            this._end();
        },

        _onWheel: function (e) {
            L.DomEvent.stop(e);
            var map = this._map;
            this._anchor = map.options.scrollWheelZoom === 'center'
                ? map.getSize().divideBy(2)
                : map.mouseEventToContainerPoint(e);
            if (!this._model.input(e, global.performance.now())) return;
            if (!this._frame) this._frame = L.Util.requestAnimFrame(this._onFrame, this);
        },

        _onFrame: function () {
            this._frame = null;
            var map = this._map;
            // A keyboard or double-click zoom is still animating: let it land first.
            if (map._animatingZoom) {
                this._frame = L.Util.requestAnimFrame(this._onFrame, this);
                return;
            }
            var step = this._model.frame(global.performance.now(), map.getZoom(), map.getMinZoom(), map.getMaxZoom());
            if (step.zoom !== null && step.zoom !== map.getZoom()) {
                if (!this._moving) {
                    map._stop();
                    map._moveStart(true, false);
                    this._moving = true;
                }
                map._move(centerAround(map, this._anchor, step.zoom), step.zoom);
            }
            if (step.done) this._end();
            else this._frame = L.Util.requestAnimFrame(this._onFrame, this);
        },

        // One zoomend and moveend for the whole gesture.
        _end: function () {
            if (!this._moving) return;
            this._moving = false;
            this._map._moveEnd(true);
        }
    });
})(typeof window !== 'undefined' ? window : globalThis);
