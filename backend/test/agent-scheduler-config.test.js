import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const app = require('../agents/ecosystem.config.cjs').apps[0];

describe('daily LLM agent schedule', () => {
    it('is one opt-in, non-restarting daily process with hard public limits', () => {
        expect(app).toMatchObject({
            name: 'consensus-builder-agents',
            script: 'agents/run.mjs',
            instances: 1,
            autorestart: false,
            cron_restart: '0 2 * * *'
        });
        expect(app.args).toContain('--persona densifier-01');
        expect(app.args).toContain('--candidates 4');
        expect(app.env).toMatchObject({
            AGENT_LLM_MODEL: 'claude-opus-5',
            AGENT_LLM_DAILY_CAP_USD: '0.25',
            AGENT_DAILY_ACTION_CAP: '3',
            AGENT_DAILY_USDC_CAP: '0.35'
        });
    });
});
