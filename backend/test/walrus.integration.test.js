// Opt-in live round-trip against the public Walrus testnet. Skipped unless WALRUS_LIVE_TEST=1
// so CI never depends on the public publisher/aggregator. Run with:
//   WALRUS_LIVE_TEST=1 npx vitest run test/walrus.integration.test.js
import { describe, expect, it } from 'vitest';
import { putBlob } from '../storage/walrus.js';

const live = process.env.WALRUS_LIVE_TEST === '1' ? describe : describe.skip;

live('Walrus testnet live round-trip', () => {
    it('stores bytes and reads them back byte-for-byte', async () => {
        const payload = Buffer.from(JSON.stringify({ name: 'walrus integration', ts: Date.now() }));
        const result = await putBlob(payload, { env: { WALRUS_EPOCHS: '1' } });

        expect(result.blobId).toBeTruthy();
        expect(result.walrusUri).toBe(`walrus://${result.blobId}`);

        const res = await fetch(result.gatewayUrl);
        expect(res.status).toBe(200);
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(payload)).toBe(true);
    }, 60000);
});
