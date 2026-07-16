export const LIFECYCLE_STATUSES = Object.freeze(['Active', 'Executed', 'Cancelled', 'Expired', 'draft']);

const CANONICAL_BY_NORMALIZED = new Map(LIFECYCLE_STATUSES.map(status => [status.toLowerCase(), status]));

export function canonicalizeLifecycleStatus(value, options = {}) {
    const { allowLegacyApplicationWords = false, fallback = null } = options;
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (allowLegacyApplicationWords && (normalized === 'applied' || normalized === 'unapplied')) {
        return 'Active';
    }
    return CANONICAL_BY_NORMALIZED.get(normalized) || null;
}

export function resolveIncomingLifecycleStatus(payload = {}) {
    const hasExplicit = payload.lifecycleStatus !== undefined && payload.lifecycleStatus !== null;
    const raw = hasExplicit ? payload.lifecycleStatus : payload.status;
    const status = canonicalizeLifecycleStatus(raw, {
        allowLegacyApplicationWords: !hasExplicit,
        fallback: 'Active'
    });
    if (!status) {
        return {
            ok: false,
            error: `lifecycleStatus must be one of: ${LIFECYCLE_STATUSES.join(', ')}.`
        };
    }
    return { ok: true, value: status };
}

export function effectiveLifecycleStatus(value, expiresAt, now = new Date()) {
    const canonical = canonicalizeLifecycleStatus(value, { fallback: 'Active' }) || 'Active';
    if (canonical === 'Executed' || canonical === 'Cancelled' || canonical === 'Expired' || canonical === 'draft') {
        return canonical;
    }
    const expiry = expiresAt ? new Date(expiresAt) : null;
    if (expiry && Number.isFinite(expiry.getTime()) && expiry.getTime() <= new Date(now).getTime()) {
        return 'Expired';
    }
    return 'Active';
}

