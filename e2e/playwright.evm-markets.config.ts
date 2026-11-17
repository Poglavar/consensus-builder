import { defineConfig } from '@playwright/test';
import { enableBackgroundChromium } from './helpers/background-chromium.cjs';
enableBackgroundChromium();
// This contract-backed dialog test supplies its own document and isolated Anvil; no app API/server.
export default defineConfig({
    testDir: './tests', testMatch: 'evm-market-adapter.spec.ts', workers: 1, retries: 0,
    use: { channel: 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    reporter: 'list'
});
