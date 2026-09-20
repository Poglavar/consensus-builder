import { createRequire } from 'node:module';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const app = require('../agents/ecosystem.config.cjs').apps[0];

describe('daily algorithmic agent schedule', () => {
    it('is one opt-in, non-restarting daily process with hard public limits', () => {
        expect(app).toMatchObject({
            name: 'consensus-builder-agents',
            script: 'agents/run.mjs',
            instances: 1,
            autorestart: false,
            cron_restart: '0 2 * * *',
            merge_logs: true
        });
        expect(app.args).toContain('--persona densifier-01');
        expect(app.args).toContain('--candidates 4');
        expect(app.args).toContain('--controller algorithm');
        expect(app.env).toMatchObject({
            AGENT_DAILY_ACTION_CAP: '4',
            AGENT_DAILY_USDC_CAP: '0.35'
        });
        expect(app.env).not.toHaveProperty('AGENT_LLM_MODEL');
        expect(app.env).not.toHaveProperty('AGENT_LLM_DAILY_CAP_USD');
    });

    it('emits an outcome sentinel only from the successful runner path', () => {
        const source = fs.readFileSync(new URL('../agents/run.mjs', import.meta.url), 'utf8');
        expect(source).toContain('AGENT DAILY RUN — status=completed');
        expect(source.indexOf('AGENT DAILY RUN — status=completed')).toBeGreaterThan(source.indexOf('if (failures.length)'));
    });
});
