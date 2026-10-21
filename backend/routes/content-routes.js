// Registers the publish routes of plan-design-agreement.md M2: the pin courier (POST /pins), the design
// index (/designs) and the agreement index with its owner-decision relay (/agreements). index.js calls
// it once with the database pool, as it does setupProposalsRoute; everything else has a default that
// a test may replace.
import { setupPinsRoute } from './pins.js';
import { setupDesignsRoute } from './designs.js';
import { setupAgreementsRoute } from './agreements.js';
import { defaultThumbnailQueue } from '../thumbnails/thumbnail-queue.js';
import { pinBytes } from '../storage/pinning.js';

/**
 * @param app express app
 * @param pool pg pool
 * @param overrides optional { thumbnailQueue, pinBytes, baseUrl, decisionStore, now, uploadRateLimiter }:
 *   the thumbnail queue (thumbnails/thumbnail-queue.js), the pinning call (storage/pinning.js), the
 *   origin stored thumbnail URLs get (PUBLIC_API_BASE_URL by default), the decision store
 *   (agreements/decisions.js), the clock, and the per-client limiter of the two pinning routes
 *   (one fresh utils/nft-asset-upload.js limiter per route by default)
 */
export function registerContentRoutes(app, pool, overrides = {}) {
    const deps = { pool, thumbnailQueue: defaultThumbnailQueue(), pinBytes, ...overrides };
    setupPinsRoute(app, deps);
    setupDesignsRoute(app, deps);
    setupAgreementsRoute(app, deps);
}
