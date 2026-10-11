// Fixed municipal ATOM archive profile; no descriptor can widen its publisher or ZIP member scope.
import { upstreamError } from './source-contract.js';

export const CATASTRO_ATOM_PROFILE = Object.freeze({
    sourceId: 'es-dgc-inspire-cp-atom-47900',
    endpoint: 'https://www.catastro.hacienda.gob.es/INSPIRE/CadastralParcels/47/47900-VALLADOLID/A.ES.SDGC.CP.47900.zip',
    parcelMember: 'A.ES.SDGC.CP.47900.cadastralparcel.gml',
    members: Object.freeze([
        'A.ES.SDGC.CP.47900.cadastralparcel.gml',
        'A.ES.SDGC.CP.47900.cadastralzoning.gml',
        'A.ES.SDGC.CP.MD..47900.xml'
    ])
});

export const CATASTRO_ATOM_GML_SCHEMA = Object.freeze({
    featureNamespace: 'http://inspire.ec.europa.eu/schemas/cp/4.0',
    featureName: 'CadastralParcel',
    idField: 'nationalCadastralReference',
    geometryField: 'geometry',
    gmlNamespace: 'http://www.opengis.net/gml/3.2',
    sourceCrs: 'EPSG:25830',
    axisOrder: 'easting-northing',
    localIdPattern: '^[A-Z0-9]{14}$'
});

export function catastroAtomProfile(descriptor) {
    if (descriptor.id !== CATASTRO_ATOM_PROFILE.sourceId) return null;
    if (descriptor.endpoint !== CATASTRO_ATOM_PROFILE.endpoint || descriptor.adapter !== 'gml-snapshot'
        || descriptor.countryCode !== 'ES' || descriptor.idField !== CATASTRO_ATOM_GML_SCHEMA.idField
        || descriptor.idPrefix !== 'ES-DGC-' || descriptor.idType !== 'string'
        || descriptor.idPattern !== CATASTRO_ATOM_GML_SCHEMA.localIdPattern
        || descriptor.parcelNumberField !== CATASTRO_ATOM_GML_SCHEMA.idField
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== CATASTRO_ATOM_GML_SCHEMA.idField) {
        throw new Error('Invalid Spanish ATOM parcel descriptor.');
    }
    return CATASTRO_ATOM_PROFILE;
}

// This public download needs no anonymous cookie session. Redirects, even to another
// official dataset, are refused rather than expanding the frozen source's authority.
export async function fetchCatastroAtomArchive(endpoint, { signal } = {}) {
    if (endpoint !== CATASTRO_ATOM_PROFILE.endpoint) throw upstreamError('Unsupported Spanish ATOM parcel archive endpoint.');
    const response = await globalThis.fetch(endpoint, { signal, redirect: 'manual', headers: {
        Accept: 'application/x-zip-compressed,application/zip,application/octet-stream,*/*'
    } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        throw upstreamError('Spanish ATOM parcel archive redirects are unsupported.');
    }
    return response;
}
