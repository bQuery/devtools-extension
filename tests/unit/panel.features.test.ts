import { describe, expect, test } from 'bun:test';
import {
  classifyFailure,
  emptyMessage,
  featureAvailable,
  featuresForHandshake,
  featureTitle,
  featureUnsupported,
  initialFeatures,
  retryAll,
  shouldAttempt,
  withFeature,
  type FeatureState,
} from '../../src/panel/features';
import { BridgeMethodError, BridgeTimeoutError } from '../../src/protocol/client';

const state = (overrides: Partial<FeatureState> = {}): FeatureState => ({
  status: 'unknown',
  detail: '',
  advertised: false,
  ...overrides,
});

describe('handshake', () => {
  test('starts with nothing attempted and nothing advertised', () => {
    const features = initialFeatures();
    expect(features.signals.status).toBe('unknown');
    expect(features.signals.advertised).toBe(false);
  });

  test('records what the page advertised without asserting it works', () => {
    const features = featuresForHandshake(new Set(['signals', 'timeline'] as const));
    expect(features.signals.advertised).toBe(true);
    expect(features.stores.advertised).toBe(false);
    // Advertised is not the same as proven.
    expect(features.signals.status).toBe('unknown');
  });

  test('replacing one feature leaves the others untouched', () => {
    const before = initialFeatures();
    const after = withFeature(before, 'stores', featureAvailable(before.stores));
    expect(after.stores.status).toBe('available');
    expect(after.signals).toBe(before.signals);
  });
});

describe('classifyFailure', () => {
  test('treats an unimplemented method as permanent', () => {
    const next = classifyFailure(
      state({ advertised: true }),
      new BridgeMethodError('getSnapshot', 'Unknown method: getSnapshot')
    );
    expect(next.status).toBe('unsupported');
  });

  test('a timeout on an advertised feature is transient', () => {
    const next = classifyFailure(state({ advertised: true }), new BridgeTimeoutError('x', 5000));
    expect(next.status).toBe('failed');
  });

  test('a timeout on a feature nobody advertised is permanent', () => {
    // Nothing suggests the page has it, so re-probing would only stall every
    // future refresh for the request timeout.
    const next = classifyFailure(state(), new BridgeTimeoutError('x', 5000));
    expect(next.status).toBe('unsupported');
  });

  test('an application error is transient and keeps the page’s wording', () => {
    const next = classifyFailure(
      state({ advertised: true }),
      new BridgeMethodError('getSnapshot', 'devtools are disabled')
    );
    expect(next.status).toBe('failed');
    // The client's own framing is stripped; the page's sentence survives.
    expect(next.detail).toBe('devtools are disabled');
  });

  test('a non-Error rejection still classifies', () => {
    expect(classifyFailure(state(), 'boom').status).toBe('failed');
  });
});

describe('retry policy', () => {
  test('only an unsupported verdict stops the panel asking again', () => {
    expect(shouldAttempt(state(), false)).toBe(true);
    expect(shouldAttempt(state({ status: 'failed' }), false)).toBe(true);
    expect(shouldAttempt(state({ status: 'available' }), false)).toBe(true);
    expect(shouldAttempt(state({ status: 'unsupported' }), false)).toBe(false);
  });

  test('an explicit refresh overrides it', () => {
    expect(shouldAttempt(state({ status: 'unsupported' }), true)).toBe(true);
  });

  test('retrying clears permanent verdicts and leaves the rest alone', () => {
    const before = withFeature(
      initialFeatures(),
      'stores',
      featureUnsupported(state(), 'no such method')
    );
    const graded = withFeature(before, 'signals', featureAvailable(before.signals));
    const after = retryAll(graded);
    expect(after.stores.status).toBe('unknown');
    expect(after.signals.status).toBe('available');
  });
});

describe('wording', () => {
  test('separates "the page cannot" from "the app has none"', () => {
    expect(emptyMessage(state({ status: 'available' }), 'stores', 'No stores.')).toBe('No stores.');
    expect(
      emptyMessage(state({ status: 'unsupported', detail: 'no such method' }), 'stores', '')
    ).toMatch(/does not provide stores: no such method/);
    expect(emptyMessage(state({ status: 'failed', detail: 'boom' }), 'stores', '')).toMatch(
      /Could not load stores: boom/
    );
  });

  test('an unadvertised, untried feature is reported as not yet seen', () => {
    expect(emptyMessage(state(), 'stores', '')).toMatch(/has not reported stores yet/);
    expect(emptyMessage(state({ advertised: true }), 'stores', '')).toMatch(/Loading stores/);
  });

  test('badge titles describe evidence, not advertisement', () => {
    expect(featureTitle('stores', state({ status: 'available' }))).toMatch(/serves "stores"/);
    expect(featureTitle('stores', state({ advertised: true }))).toMatch(/advertised "stores"/);
    expect(featureTitle('stores', state())).toMatch(/did not advertise/);
  });
});
