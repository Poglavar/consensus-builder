import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE_PROCESSOR, IMAGE_SCHEMA, buildImageRequest, dispositionKind, parseImageReading,
} from '../floor-plans/image-reading.js';

const reading = (overrides = {}) => ({
  kind: 'photo', containsPlan: false, envelopeEvidence: false, confidence: 'high', reason: 'Clear photograph with no floor layout.',
  ...overrides,
});

describe('listing image kind reading', () => {
  it('uses the stable processor identity and permits confirmed photo discard only', () => {
    expect(IMAGE_PROCESSOR).toBe('listing-image-kind-v2');
    expect(parseImageReading(reading())).toMatchObject({ kind: 'photo', discardConfirmed: true });
  });

  it('confirms a clear render as discardable when no floor plan is present', () => {
    expect(parseImageReading(reading({ kind: 'render', reason: 'Clearly computer-generated room image.' })))
      .toMatchObject({ kind: 'render', containsPlan: false, confidence: 'high', discardConfirmed: true });
  });

  it.each([
    ['plan', { kind: 'floor_plan', containsPlan: true }],
    ['uncertain', { kind: 'uncertain', confidence: 'low' }],
    ['possible composite plan', { kind: 'uncertain', containsPlan: true, confidence: 'low' }],
    ['low confidence photo', { kind: 'photo', confidence: 'low' }],
    ['possible plan in photo', { kind: 'photo', containsPlan: true }],
    ['inconsistent floor-plan negative', { kind: 'floor_plan', containsPlan: false }],
    ['exterior render', { kind: 'render', envelopeEvidence: true }],
    ['exterior photo', { kind: 'photo', envelopeEvidence: true }],
    ['section drawing', { kind: 'drawing' }],
  ])('retains %s classifications', (_name, overrides) => {
    expect(parseImageReading(reading(overrides)).discardConfirmed).toBe(false);
  });

  it.each([
    ['unknown enum', reading({ kind: 'diagram' })],
    ['wrong boolean type', reading({ containsPlan: 'false' })],
    ['missing envelope flag', (({ envelopeEvidence, ...rest }) => rest)(reading())],
    ['wrong envelope type', reading({ envelopeEvidence: 'yes' })],
    ['wrong confidence enum', reading({ confidence: 'medium' })],
    ['empty reason', reading({ reason: '  ' })],
    ['overlong reason', reading({ reason: 'x'.repeat(241) })],
    ['extra key', { ...reading(), delete: true }],
  ])('rejects malformed %s results', (_name, value) => {
    expect(() => parseImageReading(value)).toThrow();
  });

  it('keeps envelope evidence: exterior views and non-plan drawings are retained as their own kind', () => {
    expect(dispositionKind(parseImageReading(reading({ kind: 'render', envelopeEvidence: true })))).toBe('envelope');
    expect(dispositionKind(parseImageReading(reading({ kind: 'drawing' })))).toBe('envelope');
    expect(dispositionKind(parseImageReading(reading({ kind: 'drawing', containsPlan: true })))).toBe('floor_plan');
    expect(dispositionKind(parseImageReading(reading({ kind: 'render', envelopeEvidence: true, confidence: 'low' })))).toBe('uncertain');
    expect(dispositionKind(parseImageReading(reading()))).toBe('photo');
  });

  it('parses JSON text and rejects non-JSON text', () => {
    expect(parseImageReading(JSON.stringify(reading())).discardConfirmed).toBe(true);
    expect(() => parseImageReading('{bad json')).toThrow();
  });

  it('builds one cheap-tier image request with only sanitized URL context and strict bounded output', () => {
    const llm = { batchRequest: vi.fn((_id, request) => ({ _id, ...request })) };
    const task = { id: 'a'.repeat(64), source_url: 'https://user:pass@agency.test/listing/image.jpg?token=secret#x' };
    const request = buildImageRequest(llm, task, { width: 1200, height: 800, data: Buffer.from([1, 2, 3]) });

    expect(llm.batchRequest).toHaveBeenCalledOnce();
    expect(request).toMatchObject({ _id: task.id, tier: 'cheap', schema: IMAGE_SCHEMA, schemaName: 'listing_image_kind', maxTokens: 1024 });
    expect(request.content).toHaveLength(2);
    expect(request.content[0].text).toContain('https://agency.test/listing/image.jpg');
    expect(request.content[0].text).not.toMatch(/secret|user|pass/);
    expect(request.content[1]).toMatchObject({ type: 'image', mediaType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') });
    expect(JSON.stringify(request.content)).not.toMatch(/geometry|coordinates/i);
    expect(request.system).toContain('untrusted source data');
  });

  it('rejects invalid image payloads and output budgets before calling the batch API', () => {
    const llm = { batchRequest: vi.fn() };
    expect(() => buildImageRequest(llm, { id: 'id' }, { width: 1, height: 1 })).toThrow(/PNG data/);
    expect(() => buildImageRequest(llm, { id: 'id' }, { width: 1, height: 1, data: Buffer.from([1]) }, { maxOutputTokens: 1025 }))
      .toThrow(/output limit/);
    expect(llm.batchRequest).not.toHaveBeenCalled();
  });
});
