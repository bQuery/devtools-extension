/**
 * Shared doubles for bridge tests: a transport whose wire the test drives by
 * hand, and a clock that never actually waits.
 */
import { BRIDGE_SOURCE, type InboundMessage } from '../../src/protocol/messages';
import type { BridgeTransport, TransportHandlers } from '../../src/protocol/transport';

/** A transport whose wire the test drives by hand. */
export class FakeTransport implements BridgeTransport {
  public readonly kind = 'eval' as const;
  public readonly sent: InboundMessage[] = [];
  /** Request ids already answered, so a test helper can answer only new ones. */
  public readonly answered = new Set<number>();
  public disposed = false;
  private handlers: TransportHandlers | null = null;

  public start(handlers: TransportHandlers): void {
    this.handlers = handlers;
    handlers.onStatus({ kind: 'connecting' });
  }

  public send(message: InboundMessage): void {
    this.sent.push(message);
  }

  public dispose(): void {
    this.disposed = true;
  }

  public open(): void {
    this.handlers?.onStatus({ kind: 'open' });
  }

  public close(reason = 'gone'): void {
    this.handlers?.onStatus({ kind: 'closed', reason });
  }

  public deliver(message: unknown): void {
    this.handlers?.onMessage(message);
  }

  public init(capabilities: readonly string[]): void {
    this.deliver({ source: BRIDGE_SOURCE, channel: 'page', v: 1, kind: 'init', capabilities });
  }

  public event(entry: Record<string, unknown>): void {
    this.deliver({ source: BRIDGE_SOURCE, channel: 'page', v: 1, kind: 'event', entry });
  }

  public respond(id: number, body: Record<string, unknown>): void {
    this.deliver({ source: BRIDGE_SOURCE, channel: 'page', v: 1, kind: 'response', id, ...body });
  }
}

/** Manually advanced clock, so tests never wait in real time. */
export class FakeClock {
  private handle = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  private now = 0;

  public readonly setTimeout = (run: () => void, ms: number): number => {
    const id = this.handle++;
    this.timers.set(id, { at: this.now + ms, run });
    return id;
  };

  public readonly clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  public advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.now) {
        this.timers.delete(id);
        timer.run();
      }
    }
  }

  public get pending(): number {
    return this.timers.size;
  }
}
