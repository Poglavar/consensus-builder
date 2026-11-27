import * as z from 'zod/v4';
import BuildingUnitLinks from '../../frontend/js/building-unit-links.js';

export const apartmentUnitLocator = z.string().max(1024)
    .refine(value => Boolean(BuildingUnitLinks.apartmentUnitLocator(value)), 'Use a flat address such as 6::1.')
    .meta({
        description: 'X-ray address within the building, written level::flat. Use a safe integer for the storey (0 at street level, negative below) and a flat number from 1 to 9999, with no leading zeros. A round stores its permanent inventory identifier in unitId.',
        examples: ['6::1']
    });
