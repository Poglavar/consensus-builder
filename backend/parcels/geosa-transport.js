// Bind the public GEOSA parcel viewer referrer to its exact national parcel source.
export const GEOSA_SOURCE_ID = 'sa-geosa-ndm-landparcel';
export const GEOSA_ENDPOINT = 'https://www.geoportal.sa/portal/sharing/servers/c3b7cc00898344d99c5c1781c5f68e9a/rest/services/NDM/LandParcel/FeatureServer/0';
export const GEOSA_REFERER = 'https://apps.geoportal.sa/interactive_map/?page=English&locale=en';

export function isGeosaParcelSource(descriptor) {
    return descriptor.id === GEOSA_SOURCE_ID && descriptor.adapter === 'arcgis'
        && descriptor.endpoint === GEOSA_ENDPOINT;
}
