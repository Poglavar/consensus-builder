// Purpose: keep generated descendant parcel IDs unique even when cadastral number metadata disagrees.
(function attachSyntheticParcelIdentity(global) {
    function syntheticParcelAllocatorKey(rootParcelId, rootParcelNumber) {
        const id = rootParcelId === undefined || rootParcelId === null
            ? ''
            : String(rootParcelId).trim();
        if (id && id !== 'parcel') return `id:${id}`;

        const number = rootParcelNumber === undefined || rootParcelNumber === null
            ? ''
            : String(rootParcelNumber).trim();
        return `number:${number || 'parcel'}`;
    }

    global.syntheticParcelAllocatorKey = syntheticParcelAllocatorKey;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { syntheticParcelAllocatorKey };
    }
})(typeof window !== 'undefined' ? window : globalThis);
