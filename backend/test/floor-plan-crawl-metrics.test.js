import { describe, expect, it } from 'vitest';
import {
    crawlMetricCounters,
    crawlMetricTelemetry,
    emptyCrawlMetrics,
    recordCrawlAttempt,
    recordCrawlResponse,
    recordCrawlSuccess,
} from '../floor-plans/crawl-metrics.js';

describe('floor-plan crawl metrics', () => {
    it('counts unique requested hosts with www canonicalization and separates response bytes by kind', () => {
        let metrics = emptyCrawlMetrics();
        metrics = recordCrawlAttempt(metrics, 'https://www.agency.test/page');
        metrics = recordCrawlResponse(metrics, { status: 200, body: Buffer.from('page bytes') }, 'page');
        metrics = recordCrawlSuccess(metrics, 'https://www.agency.test/page');
        metrics = recordCrawlAttempt(metrics, 'https://agency.test/plan.pdf');
        metrics = recordCrawlResponse(metrics, { status: 200, body: Buffer.from('asset') }, 'asset');
        metrics = recordCrawlSuccess(metrics, 'https://agency.test/plan.pdf');

        expect(crawlMetricCounters(metrics)).toEqual({
            requestsAttempted: 2,
            fetched: 2,
            fetchResults: 2,
            successfulResponses: 2,
            decodedResponseBodyBytes: 15,
            pageDecodedBodyBytes: 10,
            assetDecodedBodyBytes: 5,
            uniqueHostsAttempted: 1,
            uniqueHostsSucceeded: 1,
        });
        expect(crawlMetricTelemetry(metrics)).toEqual({
            requestedHostKeys: ['agency.test'],
            successfulHostKeys: ['agency.test'],
        });
    });

    it('counts a 304 as a successful response with zero body bytes', () => {
        let metrics = recordCrawlAttempt(emptyCrawlMetrics(), 'https://agency.test/plan.pdf');
        metrics = recordCrawlResponse(metrics, { status: 304, notModified: true, body: Buffer.from('ignored') }, 'asset');
        metrics = recordCrawlSuccess(metrics, 'https://agency.test/plan.pdf');

        expect(crawlMetricCounters(metrics)).toMatchObject({
            requestsAttempted: 1,
            fetchResults: 1,
            successfulResponses: 1,
            decodedResponseBodyBytes: 0,
            assetDecodedBodyBytes: 0,
            uniqueHostsSucceeded: 1,
        });
    });

    it('counts blocked response bodies and failed attempts without inventing a response', () => {
        let metrics = recordCrawlAttempt(emptyCrawlMetrics(), 'https://www.agency.test/blocked');
        metrics = recordCrawlResponse(metrics, { status: 403, body: Buffer.from('blocked') }, 'page');
        metrics = recordCrawlAttempt(metrics, 'https://agency.test/throws');

        expect(crawlMetricCounters(metrics)).toMatchObject({
            requestsAttempted: 2,
            fetchResults: 1,
            successfulResponses: 0,
            decodedResponseBodyBytes: 7,
            pageDecodedBodyBytes: 7,
            assetDecodedBodyBytes: 0,
            uniqueHostsAttempted: 1,
            uniqueHostsSucceeded: 0,
        });
    });
});
