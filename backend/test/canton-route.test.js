// Canton provider failures must be observable server-side without exposing the
// provider's OAuth or ledger response to public callers.
import { describe, expect, it, vi } from 'vitest';
import { sendCantonUnavailable } from '../routes/canton.js';

describe('Canton route failures', () => {
  it('logs the operation and returns a sanitized service-unavailable response', () => {
    const providerError = new Error('invalid client secret from upstream');
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    sendCantonUnavailable({ status }, 'parcel-counts', providerError);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      error: 'Canton ledger is temporarily unavailable',
      code: 'canton_unavailable',
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain('client secret');
    expect(consoleSpy).toHaveBeenCalledWith('[canton] parcel-counts failed:', providerError);
    consoleSpy.mockRestore();
  });
});
