// Official OS control points verify both transform directions and fail-closed grid integrity.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fromWgs84, initializeOstn15, toWgs84 } from '../parcels/osgb36-projection.js';

const gridDir = new URL('../parcels/grids/ostn15/', import.meta.url);
const readCsv = async (name) => (await readFile(new URL(name, gridDir), 'utf8'))
    .trim().split(/\r?\n/).slice(1).map((line) => line.split(','));
const horizontalMeters = (a, b) => Math.hypot(
    (a[0] - b[0]) * 111_000 * Math.cos(b[1] * Math.PI / 180),
    (a[1] - b[1]) * 111_000
);

describe('OSGB36 OSTN15 projection', () => {
    it('requires a valid grid before transforming', () => {
        expect(() => toWgs84([530000, 180000])).toThrow(/not initialized/);
    });

    it('matches the official OS control points in both directions', async () => {
        const grid = await readFile(new URL('OSTN15_NTv2_OSGBtoETRS.gsb', gridDir));
        await initializeOstn15(grid);

        const [osgbInput, etrsOutput] = await Promise.all([
            readCsv('OSTN15_TestInput_OSGBtoETRS.txt'),
            readCsv('OSTN15_TestOutput_OSGBtoETRS.txt')
        ]);
        let maxForwardError = 0;
        for (let i = 0; i < osgbInput.length; i += 1) {
            const [, easting, northing] = osgbInput[i];
            const [, latitude, longitude] = etrsOutput[i];
            maxForwardError = Math.max(maxForwardError, horizontalMeters(
                toWgs84([Number(easting), Number(northing)]),
                [Number(longitude), Number(latitude)]
            ));
        }

        const [etrsInput, osgbOutput] = await Promise.all([
            readCsv('OSTN15_TestInput_ETRStoOSGB.txt'),
            readCsv('OSTN15_TestOutput_ETRStoOSGB.txt')
        ]);
        let maxInverseError = 0;
        for (let i = 0; i < etrsInput.length; i += 1) {
            const [, latitude, longitude] = etrsInput[i];
            const [, easting, northing] = osgbOutput[i];
            const actual = fromWgs84([Number(longitude), Number(latitude)]);
            maxInverseError = Math.max(maxInverseError, Math.hypot(
                actual[0] - Number(easting), actual[1] - Number(northing)
            ));
        }
        expect(osgbInput).toHaveLength(40);
        expect(etrsInput).toHaveLength(40);
        expect(maxForwardError).toBeLessThan(0.01);
        expect(maxInverseError).toBeLessThan(0.01);
    });

    it('rejects invalid and out-of-grid inputs rather than returning a fallback', () => {
        expect(() => toWgs84([NaN, 180000])).toThrow(/finite numbers/);
        expect(() => fromWgs84([20, 0])).toThrow(/outside OSTN15 grid coverage/);
    });

    it('rejects corrupted grid bytes even after a valid grid has initialized', async () => {
        const grid = await readFile(new URL('OSTN15_NTv2_OSGBtoETRS.gsb', gridDir));
        grid[grid.length - 100] ^= 1;
        await expect(initializeOstn15(grid)).rejects.toThrow(/integrity/);
    });
});
