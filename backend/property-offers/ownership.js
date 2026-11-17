// Resolve immutable property-offer parcel references against a lens ownership registry.
// The devnet registry stores Croatian cadastral parcels under their official HR-* IDs;
// every other lookup remains qualified by the offer's source and optional snapshot.
import { parcelUid } from '../lens/property-offer-decision.js';

const HR_PARCEL_ID = /^HR-[0-9]+-.+$/;

export function registryParcelKey(ref) {
    if (ref?.sourceId === 'oss-wfs' && ref.snapshotId == null && HR_PARCEL_ID.test(ref.id || '')) return ref.id;
    return parcelUid(ref);
}

/** Read mapped registry keys and return owner sets under the offer's canonical parcel UIDs. */
export async function readOwnership(refs, identity) {
    if (!Array.isArray(refs) || refs.length === 0 || refs.length > 200) throw new TypeError('Property offer ownership requires 1 to 200 parcel references.');
    if (typeof identity?.ownerSets !== 'function') throw new TypeError('Property offer ownership requires identity.ownerSets.');
    const canonical = refs.map(ref => {
        if (!ref || typeof ref.sourceId !== 'string' || !ref.sourceId || typeof ref.id !== 'string' || !ref.id) throw new TypeError('Invalid source-qualified property-offer parcel reference.');
        return { uid: parcelUid(ref), registryKey: registryParcelKey(ref) };
    });
    const byRegistryKey = new Map();
    const seenUids = new Set();
    for (const item of canonical) {
        if (seenUids.has(item.uid)) throw new Error(`Duplicate canonical property-offer parcel ${item.uid}.`);
        seenUids.add(item.uid);
        const previous = byRegistryKey.get(item.registryKey);
        if (previous && previous !== item.uid) throw new Error(`Ownership registry key collision for ${item.registryKey}.`);
        byRegistryKey.set(item.registryKey, item.uid);
    }
    const observed = await identity.ownerSets([...byRegistryKey.keys()]);
    if (!(observed instanceof Map)) throw new Error('Ownership registry returned no parcel map.');
    return new Map(canonical.map(({ uid, registryKey }) => [uid, observed.get(registryKey) || []]));
}
