import { describe, expect, test } from 'bun:test';
import {
  buildDrainExpression,
  buildSendExpression,
  EvalTransport,
  type Evaluator,
} from '../../src/transports/evalTransport';
import { helloMessage, requestMessage } from '../../src/protocol/messages';
import type { TransportStatus } from '../../src/protocol/transport';

/** Records evaluated expressions and lets the test answer them. */
class FakeEvaluator {
  public readonly expressions: string[] = [];
  public queued: unknown[] = [];
  public failing = false;

  public readonly evaluate: Evaluator = (expression, callback) => {
    this.expressions.push(expression);
    if (this.failing) {
      callback(undefined, { isError: true });
      return;
    }
    if (expression.startsWith('window.postMessage')) {
      callback(undefined, undefined);
      return;
    }
    const drained = this.queued;
    this.queued = [];
    callback(JSON.stringify(drained), undefined);
  };
}

describe('generated expressions', () => {
  test('the drain expression is syntactically valid', () => {
    expect(() => new Function(`return ${buildDrainExpression(10)};`)).not.toThrow();
  });

  test('the drain expression installs the relay and empties the queue', () => {
    const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
    const fakeWindow: Record<string, unknown> = {
      addEventListener: (_type: string, listener: (event: never) => void) => {
        listeners.push(listener as never);
      },
    };
    const run = new Function('window', `return ${buildDrainExpression(3)};`) as (
      win: Record<string, unknown>
    ) => string;

    expect(JSON.parse(run(fakeWindow))).toEqual([]);
    expect(listeners).toHaveLength(1);

    const pageMessage = { source: 'bquery-devtools', channel: 'page', v: 1, kind: 'init' };
    listeners[0]?.({ source: fakeWindow, data: pageMessage });
    // Foreign traffic on the same bus is ignored.
    listeners[0]?.({ source: fakeWindow, data: { source: 'other' } });
    listeners[0]?.({ source: {}, data: pageMessage });

    expect(JSON.parse(run(fakeWindow))).toEqual([pageMessage]);
    // A second call does not add another listener.
    expect(listeners).toHaveLength(1);
  });

  test('the in-page queue is bounded', () => {
    const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
    const fakeWindow: Record<string, unknown> = {
      addEventListener: (_type: string, listener: (event: never) => void) => {
        listeners.push(listener as never);
      },
    };
    const run = new Function('window', `return ${buildDrainExpression(3)};`) as (
      win: Record<string, unknown>
    ) => string;
    run(fakeWindow);
    for (let index = 0; index < 10; index += 1) {
      listeners[0]?.({
        source: fakeWindow,
        data: { source: 'bquery-devtools', channel: 'page', v: 1, kind: 'event', index },
      });
    }
    const drained = JSON.parse(run(fakeWindow)) as Array<{ index: number }>;
    expect(drained).toHaveLength(3);
    expect(drained[0]?.index).toBe(7);
  });

  test('a message is embedded as data, never as source', () => {
    const hostile = requestMessage(1, "');globalThis.pwned=true;('", { note: '</script>' });
    const expression = buildSendExpression(hostile);
    let posted: unknown = null;
    const run = new Function('window', `return ${expression};`) as (win: {
      postMessage: (data: unknown, origin: string) => void;
    }) => void;
    run({ postMessage: data => (posted = data) });
    expect(posted).toEqual(hostile as unknown as Record<string, unknown>);
    expect((globalThis as Record<string, unknown>)['pwned']).toBeUndefined();
  });
});

describe('EvalTransport', () => {
  test('reports open on the first successful poll and dispatches messages', () => {
    const evaluator = new FakeEvaluator();
    const transport = new EvalTransport({ evaluate: evaluator.evaluate, pollIntervalMs: 10_000 });
    const statuses: TransportStatus[] = [];
    const received: unknown[] = [];

    evaluator.queued = [{ kind: 'init' }];
    transport.start({
      onMessage: message => received.push(message),
      onStatus: status => statuses.push(status),
    });

    expect(statuses.map(status => status.kind)).toEqual(['connecting', 'open']);
    expect(received).toEqual([{ kind: 'init' }]);
    transport.dispose();
  });

  test('send evaluates a postMessage expression', () => {
    const evaluator = new FakeEvaluator();
    const transport = new EvalTransport({ evaluate: evaluator.evaluate, pollIntervalMs: 10_000 });
    transport.start({ onMessage: () => undefined, onStatus: () => undefined });
    transport.send(helloMessage());
    expect(evaluator.expressions.at(-1)).toStartWith('window.postMessage(JSON.parse(');
    transport.dispose();
  });

  test('an evaluation failure is reported once, not on every poll', () => {
    const evaluator = new FakeEvaluator();
    evaluator.failing = true;
    const transport = new EvalTransport({ evaluate: evaluator.evaluate, pollIntervalMs: 10_000 });
    const statuses: TransportStatus[] = [];
    transport.start({ onMessage: () => undefined, onStatus: status => statuses.push(status) });
    transport.send(helloMessage());
    transport.send(helloMessage());
    expect(statuses.filter(status => status.kind === 'error')).toHaveLength(1);
    transport.dispose();
  });

  test('nothing is dispatched after dispose', () => {
    const evaluator = new FakeEvaluator();
    const transport = new EvalTransport({ evaluate: evaluator.evaluate, pollIntervalMs: 10_000 });
    const received: unknown[] = [];
    transport.start({ onMessage: message => received.push(message), onStatus: () => undefined });
    transport.dispose();
    const before = evaluator.expressions.length;
    transport.send(helloMessage());
    expect(evaluator.expressions).toHaveLength(before);
  });
});
