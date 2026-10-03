// Configured WFS alternatives share the same canonical transport as other live cities.
import { readFileSync } from 'node:fs';
import { createWfsParcelSource } from './wfs-source.js';
const catalog = JSON.parse(readFileSync(new URL('./source-catalog.json', import.meta.url), 'utf8'));
export const legacyCityWfsDescriptors = catalog.sources.filter(source =>
    ['si-gurs-kn-parcele-wfs', 'ar-caba-idecaba-wfs-parcelas'].includes(source.id));
export function createLegacyCityWfsSource(city, options = {}) {
    const descriptor = legacyCityWfsDescriptors.find(source => source.cityIds.includes(city));
    if (!descriptor) throw new Error('Unknown legacy city WFS source.');
    return createWfsParcelSource(descriptor, options);
}
