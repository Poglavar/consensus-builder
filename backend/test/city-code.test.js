// Server record labels are opaque; city aliases are resolved by the frontend consumer.
import {describe,it,expect} from 'vitest';
import {normalizeCityCode} from '../utils/city-code.js';
describe('consumer record labels',()=>{
    it('accepts arbitrary labels without app city inference',()=>{
        expect(normalizeCityCode('  independent_client  ')).toBe('independent_client');
        expect(normalizeCityCode('  NY  ')).toBe('ny');
        expect(normalizeCityCode('new_york')).toBe('new_york');
        expect(normalizeCityCode(null)).toBeNull();
    });
});
