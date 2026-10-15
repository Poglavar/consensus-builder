import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Signals = require('../../frontend/traffic/signal-plan.js');
const Traffic = require('../../frontend/traffic/simulation.js');

const light = (id, offset = 0, phases = ['axis:0', 'axis:1']) => ({ id, phases, offset });

afterEach(() => Signals.clearOverrides());

describe('traffic signal overrides', () => {
    it('counts scheduled red and green intervals across negative offsets and cycle boundaries', () => {
        const signal = light('negative-offset', -5);

        expect(Signals.state(signal, 'axis:0', 0)).toMatchObject({ aspect: 'red', remaining: 5 });
        expect(Signals.state(signal, 'axis:0', 5)).toMatchObject({ aspect: 'green', remaining: 24 });
        expect(Signals.state(signal, 'axis:0', 29)).toMatchObject({ aspect: 'amber', remaining: 3 });
        expect(Signals.state(signal, 'axis:0', 32)).toMatchObject({ aspect: 'red', remaining: 31 });
    });

    it('cycles red, green, amber, red and resumes its own schedule when the override expires', () => {
        const signal = light('cycle', -5);

        expect(Signals.cycle(signal, 'axis:0', 32)).toMatchObject({ aspect: 'green', remaining: 24, overridden: true });
        expect(Signals.cycle(signal, 'axis:0', 33)).toMatchObject({ aspect: 'amber', remaining: 3, overridden: true });
        expect(Signals.cycle(signal, 'axis:0', 34)).toMatchObject({ aspect: 'red', remaining: 31, overridden: true });
        expect(Signals.aspect(signal, 'axis:0', 64.99)).toBe('red');
        expect(Signals.state(signal, 'axis:0', 65)).toMatchObject({
            aspect: 'green', overridden: false, reverted: true
        });
        expect(Signals.state(signal, 'axis:0', 68)).toMatchObject({ aspect: 'green', reverted: false });
    });

    it('keeps overrides independent between signal heads and uses each head’s red duration', () => {
        const short = light('short', 0, ['axis:0', 'axis:1']);
        const long = light('long', 0, ['axis:0', 'axis:1', 'axis:2']);
        const untouched = light('untouched', 0, ['axis:0', 'axis:1']);

        Signals.cycle(short, 'axis:0', 27); // scheduled red → forced green
        Signals.cycle(long, 'axis:0', 27);  // scheduled red → forced green
        Signals.cycle(long, 'axis:0', 28);  // forced amber
        Signals.cycle(long, 'axis:0', 29);  // forced red for its full 3-phase red interval

        expect(Signals.state(short, 'axis:0', 29)).toMatchObject({ aspect: 'green', remaining: 22, overridden: true });
        expect(Signals.state(long, 'axis:0', 29)).toMatchObject({ aspect: 'red', remaining: 60, overridden: true });
        expect(Traffic.signalAspect(short, 'axis:0', 50)).toBe('green');
        expect(Signals.aspect(long, 'axis:0', 50)).toBe('red');
        expect(Signals.aspect(untouched, 'axis:0', 29)).toBe('red');
        expect(Traffic.signalState({ signals: new Map([[short.id, short]]) },
            { signals: [{ signalId: short.id, phase: 'axis:0', stopS: 10 }] }, 50, true, 0)).toBe('green');
    });
});
