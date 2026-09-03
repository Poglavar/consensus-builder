(function attachParcelIngest(global) {
    'use strict';

    // Rendering infrastructure shared by every ParcelPresenter layer. Geometry ingestion below
    // is domain-only and never edits Leaflet, caches, or persistent records.
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

    function normalizeFeatureParcelId(feature) {
        if (!feature || typeof feature !== 'object') return null;
        const props = feature.properties || (feature.properties = {});
        let id = props.parcelId ?? props.parcel_id ?? props.PARCEL_ID ?? props.id;
        if ((id === undefined || id === null || id === '')
            && props.maticni_broj_ko !== undefined && props.broj_cestice !== undefined) {
            id = `HR-${props.maticni_broj_ko}-${props.broj_cestice}`;
        }
        if (id === undefined || id === null || String(id).trim() === '') return null;
        props.parcelId = String(id).trim();
        props.id = props.parcelId;
        return props.parcelId;
    }

    // Explicit cadastral boundary used by deterministic fixtures and import tools. It deliberately
    // delegates conversion, identity validation, deduplication, caching and live-fabric provisioning
    // to the repository. There is no generic "parcel ingest": generated live parcels may only be
    // committed by a ProposalManager mutation, while cadastral facts may only enter here.
    async function ingestCadastralParcelFeatures(rawFeatures, options = {}) {
        const repository = global.CadastralParcelRepository;
        if (!repository || typeof repository.acceptFeatures !== 'function') {
            throw new Error('Cadastral parcel repository is unavailable.');
        }
        return repository.acceptFeatures(Array.isArray(rawFeatures) ? rawFeatures : [], {
            ...(options.city ? { city: options.city } : {}),
            ...(options.mutation ? { mutation: options.mutation } : {}),
            skipConversion: options.skipConversion === true
        });
    }

    global.parcelCanvasRenderer = parcelCanvasRenderer;
    global.normalizeFeatureParcelId = normalizeFeatureParcelId;
    global.ingestCadastralParcelFeatures = ingestCadastralParcelFeatures;
})(typeof window !== 'undefined' ? window : globalThis);
