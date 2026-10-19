// Production identity adapter for the reference lens member: Certilia eOsobna OIDC, matching the
// OIB claim to the land-registry owner as the EVM oracle-voting draft specifies. Interface stub only;
// every method refuses with "not configured" and there is no network code yet.
//
// What a real implementation needs (consensus-builder-oracle-voting/oracle-voting.md):
//   - Authorization code flow with PKCE (S256 code_challenge; verifier kept server-side per request).
//   - `state` bound to the (parcelUid, wallet) request and a `nonce` checked against the ID token.
//   - ID token signature verified against Certilia's JWKS; iss, aud, exp and nonce checked.
//   - The OIB claim matched to the land-registry owner list of the parcel inside this process;
//     the OIB is never logged, stored, returned or put in an attestation (evidenceRef stays opaque).
//   - An assurance-level claim at or above "high" (eOsobna card), refusing lower levels.
//   - The wallet binding still proven by a signed challenge, as in devnet-registry.js.
// Config it would read: CERTILIA_ISSUER, CERTILIA_CLIENT_ID, CERTILIA_CLIENT_SECRET,
// CERTILIA_REDIRECT_URI, CERTILIA_MIN_ASSURANCE.

import { LensError } from '../errors.js';

function notConfigured() {
    throw new LensError(501, 'identity_not_configured', 'certilia identity adapter is not configured');
}

export function createCertiliaIdentity() {
    return {
        kind: 'certilia',
        assertReady: notConfigured,
        ownerSet: async () => notConfigured(),
        issueChallenge: async () => notConfigured(),
        verifyOwner: async () => notConfigured(),
        consume: notConfigured
    };
}
