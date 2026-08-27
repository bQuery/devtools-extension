import { describe, expect, test } from 'bun:test';
import { ENVELOPE_SOURCE } from '../../src/protocol/envelope';
import { helloMessage } from '../../src/protocol/messages';
import type { TransportStatus } from '../../src/protocol/transport';
import { PortTransport, type PanelPort } from '../../src/transports/portTransport';

class FakePort implements PanelPort {
  public readonly sent: Array<Record<string, unknown>> = [];
  public disconnected = false;
  private messageListener: ((message: unknown) => void) | null = null;
  private disconnectListener: (() => void) | null = null;

  public postMessage(message: unknown): void {
    this.sent.push(message as Record<string, unknown>);
  }

  public disconnect(): void {
    this.disconnected = true;
  }

  public readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => {
      this.messageListener = listener;
    },
  };

  public readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListener = listener;
    },
  };

  public attached(token: string, tabId: number): void {
    this.messageListener?.({ source: ENVELOPE_SOURCE, type: 'attached', token, tabId });
  }

  public emit(message: unknown): void {
    this.messageListener?.(message);
  }

  public drop(): void {
    this.disconnectListener?.();
  }
}

interface Harness {
  readonly transport: PortTransport;
  readonly ports: FakePort[];
  readonly statuses: TransportStatus[];
  readonly received: unknown[];
  runTimers(): void;
}

const harness = (): Harness => {
  const ports: FakePort[] = [];
  const statuses: TransportStatus[] = [];
  const received: unknown[] = [];
  const timers: Array<() => void> = [];
  const transport = new PortTransport({
    tabId: 17,
    connect: () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    backoffMs: [1],
    setTimeout: handler => {
      timers.push(handler);
      return timers.length;
    },
  });
  transport.start({
    onMessage: message => received.push(message),
    onStatus: status => statuses.push(status),
  });
  return {
    transport,
    ports,
    statuses,
    received,
    runTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const run of pending) run();
    },
  };
};

describe('attach', () => {
  test('claims the inspected tab on connect', () => {
    const { ports } = harness();
    expect(ports[0]?.sent[0]).toEqual({ source: ENVELOPE_SOURCE, type: 'attach', tabId: 17 });
  });

  test('messages sent before attach are queued, then flushed with the token', () => {
    const { transport, ports } = harness();
    transport.send(helloMessage());
    expect(ports[0]?.sent).toHaveLength(1);

    ports[0]?.attached('token-1', 17);
    expect(ports[0]?.sent[1]).toEqual({
      source: ENVELOPE_SOURCE,
      type: 'to-page',
      token: 'token-1',
      payload: helloMessage(),
    });
  });

  test('attach opens the transport', () => {
    const { ports, statuses } = harness();
    ports[0]?.attached('token-1', 17);
    expect(statuses.map(status => status.kind)).toEqual(['connecting', 'open']);
  });
});

describe('routing', () => {
  test('page payloads are handed to the client', () => {
    const { ports, received } = harness();
    ports[0]?.attached('token-1', 17);
    ports[0]?.emit({ source: ENVELOPE_SOURCE, type: 'from-page', payload: { kind: 'init' } });
    expect(received).toEqual([{ kind: 'init' }]);
  });

  test('foreign envelopes are ignored', () => {
    const { ports, received } = harness();
    ports[0]?.attached('token-1', 17);
    ports[0]?.emit({ source: 'somewhere-else', type: 'from-page', payload: 'nope' });
    expect(received).toEqual([]);
  });
});

describe('reconnection', () => {
  test('a dropped port is reported and reopened', () => {
    const { ports, statuses, runTimers } = harness();
    ports[0]?.attached('token-1', 17);
    ports[0]?.drop();

    expect(statuses.at(-1)).toEqual({ kind: 'closed', reason: 'background worker disconnected' });
    runTimers();
    expect(ports).toHaveLength(2);
    expect(ports[1]?.sent[0]).toEqual({ source: ENVELOPE_SOURCE, type: 'attach', tabId: 17 });
  });

  test('the new port issues a new token, and the old one is not reused', () => {
    const { transport, ports, runTimers } = harness();
    ports[0]?.attached('token-1', 17);
    ports[0]?.drop();
    runTimers();
    ports[1]?.attached('token-2', 17);
    transport.send(helloMessage());
    expect(ports[1]?.sent.at(-1)).toMatchObject({ token: 'token-2' });
  });
});

describe('injection', () => {
  test('resolves when the router reports success', async () => {
    const { transport, ports } = harness();
    ports[0]?.attached('token-1', 17);
    const pending = transport.requestInjection();
    expect(ports[0]?.sent.at(-1)).toEqual({
      source: ENVELOPE_SOURCE,
      type: 'inject',
      token: 'token-1',
    });
    ports[0]?.emit({ source: ENVELOPE_SOURCE, type: 'inject-result', ok: true });
    await pending;
  });

  test('rejects with the reported reason', async () => {
    const { transport, ports } = harness();
    ports[0]?.attached('token-1', 17);
    const pending = transport.requestInjection();
    ports[0]?.emit({
      source: ENVELOPE_SOURCE,
      type: 'inject-result',
      ok: false,
      reason: 'no permission for this site',
    });
    await expect(pending).rejects.toThrow(/no permission for this site/);
  });

  test('rejects when the port dies mid-flight', async () => {
    const { transport, ports } = harness();
    ports[0]?.attached('token-1', 17);
    const pending = transport.requestInjection();
    ports[0]?.drop();
    await expect(pending).rejects.toThrow(/disconnected/);
  });

  test('rejects when not attached', async () => {
    const { transport } = harness();
    await expect(transport.requestInjection()).rejects.toThrow(/not attached/);
  });
});

describe('dispose', () => {
  test('disconnects the port and stops sending', () => {
    const { transport, ports } = harness();
    ports[0]?.attached('token-1', 17);
    const before = ports[0]?.sent.length ?? 0;
    transport.dispose();
    transport.send(helloMessage());
    expect(ports[0]?.disconnected).toBe(true);
    expect(ports[0]?.sent).toHaveLength(before);
  });
});
