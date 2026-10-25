// Ogun's broken propertyName filter requires a reviewed schema guard before full-schema reads.
// Only native IDs and unchanged geometry leave this guard; schema changes fail closed.
import { SaxesParser } from 'saxes';
import { providerHttpError, upstreamError } from './source-contract.js';
import { concatBytes } from './byte-utils.js';

const ENDPOINT = 'https://geoserver.ogunstate.gov.ng/geoserver/ows';
const XSD = 'http://www.w3.org/2001/XMLSchema';
const FIELDS = Object.freeze({
    fid: 'xsd:int', lga_name: 'xsd:string', lga_num: 'xsd:int', block_num: 'xsd:int',
    parcel_num: 'xsd:int', parcel_status: 'xsd:string', data_source: 'xsd:int',
    status: 'xsd:int', area: 'xsd:double', date_created: 'xsd:date',
    old_file: 'xsd:string', geom: 'gml:MultiSurfacePropertyType'
});
const changed = () => upstreamError('Ogun parcel schema changed; minimal-field access must be reviewed.');

export function createOgunWfsSchemaGuard(descriptor, { fetchImpl }) {
    if (descriptor.unfilteredSchemaProfile !== 'ng-ogun-parcels-v1'
        || descriptor.id !== 'ng-ogun-sdi-geonode-parcels' || descriptor.endpoint !== ENDPOINT
        || descriptor.featureType !== 'geonode:parcels' || descriptor.geometryField !== 'geom'
        || descriptor.version !== '2.0.0' || descriptor.nativeIdMode !== 'feature-id'
        || descriptor.requestProperties !== false || descriptor.idField !== null
        || descriptor.idType !== 'string' || descriptor.outFields?.length !== 0
        || descriptor.responseSrid !== undefined || descriptor.projection !== undefined
        || descriptor.idPattern !== '^parcels\\.[0-9]+$') {
        throw new Error('Invalid WFS unfiltered schema profile.');
    }
    async function verifySchema() {
        const params = new URLSearchParams({ service: 'WFS', version: '2.0.0',
            request: 'DescribeFeatureType', typeNames: 'geonode:parcels' });
        const signal = AbortSignal.timeout(15000);
        try {
            const response = await fetchImpl(`${ENDPOINT}?${params}`, {
                signal, redirect: 'error', cache: 'no-store', headers: { Accept: 'application/xml' }
            });
            if (!response.ok) throw providerHttpError(response);
            const reader = response.body?.getReader();
            if (!reader) throw changed();
            const chunks = [];
            let size = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > 65536) throw changed();
                    chunks.push(value);
                }
            } finally {
                await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
            const fields = new Map();
            let schema = false, parcelType = false, parcelElement = false;
            const parser = new SaxesParser({ xmlns: true });
            parser.on('doctype', () => { throw changed(); });
            parser.on('opentag', tag => {
                if (tag.uri !== XSD) return;
                const attr = key => tag.attributes[key]?.value;
                if (tag.local === 'schema') schema = attr('targetNamespace') === 'http://www.geonode.org/';
                if (tag.local === 'complexType' && attr('name') === 'parcelsType') parcelType = true;
                if (tag.local !== 'element') return;
                const name = attr('name'), type = attr('type');
                // QName spelling alone does not identify a type: a schema can
                // rebind its prefixes while leaving every field name unchanged.
                const prefix = type?.split(':')[0];
                const typeNamespace = parser.resolve(prefix);
                const expectedNamespace = prefix === 'xsd' ? XSD
                    : prefix === 'gml' ? 'http://www.opengis.net/gml/3.2'
                        : prefix === 'geonode' ? 'http://www.geonode.org/' : null;
                if (!expectedNamespace || typeNamespace !== expectedNamespace) throw changed();
                if (name === 'parcels' && type === 'geonode:parcelsType') { parcelElement = true; return; }
                if (!Object.hasOwn(FIELDS, name) || FIELDS[name] !== type || fields.has(name)) throw changed();
                fields.set(name, type);
            });
            parser.write(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks))).close();
            if (!schema || !parcelType || !parcelElement || fields.size !== Object.keys(FIELDS).length) throw changed();
        } catch (error) {
            if (signal.aborted) throw upstreamError('Ogun parcel schema request timed out.', 504);
            if (error.status) throw error;
            throw changed();
        }
    }
    return Object.freeze({
        // Runtime adapters are long-lived: recheck before each operation rather than
        // trusting an old schema after the provider may have added personal fields.
        verify: verifySchema,
        minimize(feature) {
            const props = feature?.properties;
            if (!props || typeof props !== 'object' || Array.isArray(props)
                || Object.keys(props).some(key => key === 'geom' || !Object.hasOwn(FIELDS, key))
                || !Number.isSafeInteger(props.fid) || props.fid < 0
                || feature.id !== `parcels.${props.fid}`) throw changed();
            return { type: feature.type, id: feature.id, geometry: feature.geometry, properties: {} };
        }
    });
}
