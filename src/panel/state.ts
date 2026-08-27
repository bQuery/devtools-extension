/**
 * Panel state container.
 *
 * Holds every piece of state the panel views render from, as bQuery signals,
 * and owns the conversation with the {@link BridgeClient}. Views subscribe;
 * they never talk to the bridge directly.
 *
 * @module panel/state
 */
import { computed, signal, type Signal } from '@bquery/bquery/reactive';
import type { BridgeClient } from '../protocol/client';
import type { BridgeCapability, ComponentTreeNode, TimelineEntry } from '../protocol/messages';
import {
  parseComponentTree,
  parseSnapshot,
  parseTimeline,
  type ComponentView,
  type SignalView,
  type StoreView,
} from '../protocol/results';
import { TimelineBuffer, type TimelineFilterState } from './timeline';
import { reconstructAt, type Reconstruction, type TimeTravelBase } from './timeTravel';

/** How many entries the initial `getTimeline` request asks for. */
const TIMELINE_SEED_LIMIT = 200;

/**
 * Identity of a timeline entry across the two ways it can reach the panel
 * (streamed as an `event`, or returned by `getTimeline`). The framework does
 * not assign ids, so the recorded fields are the identity.
 */
const entryKey = (entry: TimelineEntry): string =>
  `${entry.timestamp}|${entry.type}|${entry.detail}|${entry.source ?? ''}`;

/** Panel state and the commands the views issue against it. */
export class PanelState {
  /** Component tree as last fetched. */
  public readonly tree: Signal<readonly ComponentTreeNode[]> = signal<readonly ComponentTreeNode[]>(
    []
  );
  /** Flat component registry (tag → instance count). */
  public readonly components: Signal<readonly ComponentView[]> = signal<readonly ComponentView[]>(
    []
  );
  /** Live signal snapshots. */
  public readonly signals: Signal<readonly SignalView[]> = signal<readonly SignalView[]>([]);
  /** Live store snapshots. */
  public readonly stores: Signal<readonly StoreView[]> = signal<readonly StoreView[]>([]);
  /** Search box contents for the component tree. */
  public readonly treeSearch: Signal<string> = signal('');
  /** Currently selected tree path, as a dotted key. */
  public readonly selectedPath: Signal<string> = signal('');
  /** Timeline filter. */
  public readonly timelineFilter: Signal<TimelineFilterState> = signal<TimelineFilterState>({
    types: new Set<string>(),
    search: '',
  });
  /** Bumped whenever the timeline buffer changes, to drive re-renders. */
  public readonly timelineRevision: Signal<number> = signal(0);
  /** When `true`, streamed events are dropped instead of buffered. */
  public readonly paused: Signal<boolean> = signal(false);
  /** Index being replayed, or `null` while following live state. */
  public readonly timeTravelIndex: Signal<number | null> = signal<number | null>(null);
  /** Last error surfaced to the user. */
  public readonly lastError: Signal<string> = signal('');
  /** `true` while a refresh request is in flight. */
  public readonly loading: Signal<boolean> = signal(false);

  /** The reconstruction for {@link timeTravelIndex}, or `null` when live. */
  public readonly reconstruction = computed<Reconstruction | null>(() => {
    const index = this.timeTravelIndex.value;
    if (index === null) return null;
    // Touch the revision so the view recomputes as the buffer grows.
    void this.timelineRevision.value;
    return reconstructAt(this.base.value, this.buffer.all(), index);
  });

  private readonly client: BridgeClient;
  private readonly buffer: TimelineBuffer;
  /** Reactive so a refreshed snapshot re-bases an active replay. */
  private readonly base: Signal<TimeTravelBase> = signal<TimeTravelBase>({
    signals: [],
    stores: [],
    capturedAt: Date.now(),
  });
  private disposers: Array<() => void> = [];

  constructor(client: BridgeClient, buffer: TimelineBuffer) {
    this.client = client;
    this.buffer = buffer;
  }

  /** The bridge client backing this state. */
  public get bridge(): BridgeClient {
    return this.client;
  }

  /** Buffered timeline entries, oldest first. */
  public entries(): readonly TimelineEntry[] {
    return this.buffer.all();
  }

  /** Entries evicted from the buffer since the last clear. */
  public droppedEntries(): number {
    return this.buffer.dropped;
  }

  /** Buffer capacity. */
  public bufferCapacity(): number {
    return this.buffer.capacity;
  }

  /** `true` when the page advertised `capability`. */
  public supports(capability: BridgeCapability): boolean {
    return this.client.capabilities.value.has(capability);
  }

  /** Start listening to the bridge; refetches on every (re)connect. */
  public start(): void {
    this.disposers.push(
      this.client.onReady(() => {
        void this.refreshAll();
      })
    );
    this.disposers.push(
      this.client.onEvent(entry => {
        if (this.paused.value) return;
        this.buffer.push(entry);
        this.timelineRevision.value += 1;
      })
    );
    this.client.start();
  }

  /** Stop listening; the client itself is disposed by the caller. */
  public dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  /** Refetch tree, snapshot and timeline seed. */
  public async refreshAll(): Promise<void> {
    this.loading.value = true;
    try {
      await Promise.all([this.refreshTree(), this.refreshSnapshot()]);
      await this.seedTimeline();
      this.lastError.value = '';
    } catch (error) {
      this.lastError.value = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading.value = false;
    }
  }

  /** Refetch the component tree. */
  public async refreshTree(): Promise<void> {
    if (!this.supports('components')) return;
    const result = parseComponentTree(await this.client.request('getComponentTree'));
    this.tree.value = result.tree;
    // Assigned even when empty: a page that unmounted every component must
    // clear the registry, not keep showing the previous counts.
    this.components.value = result.flat;
  }

  /** Refetch signals, stores and components, and re-base time travel. */
  public async refreshSnapshot(): Promise<void> {
    const snapshot = parseSnapshot(await this.client.request('getSnapshot'));
    if (!snapshot) return;
    this.signals.value = snapshot.signals;
    this.stores.value = snapshot.stores;
    this.components.value = snapshot.components;
    this.base.value = {
      signals: snapshot.signals,
      stores: snapshot.stores,
      capturedAt: snapshot.exportedAt,
    };
  }

  /**
   * Seed the buffer from the page's own timeline.
   *
   * Called on connect only: afterwards the buffer is authoritative, because
   * it also holds entries the page has already evicted from its own ring.
   *
   * Events streamed *while* the seed request is in flight are carried over
   * rather than overwritten — a page that emits during the handshake would
   * otherwise lose exactly the events the user was waiting for.
   */
  public async seedTimeline(): Promise<void> {
    if (!this.supports('timeline')) return;
    const entries = parseTimeline(
      await this.client.request('getTimeline', { limit: TIMELINE_SEED_LIMIT })
    );
    // Read the buffer *after* awaiting, not before: events that arrive while
    // the request is in flight are in it by now, and a snapshot taken earlier
    // would silently drop exactly those.
    const streamed = [...this.buffer.all()];
    const seeded = new Set(entries.map(entryKey));
    this.buffer.reset(entries);
    this.buffer.extend(streamed.filter(entry => !seeded.has(entryKey(entry))));
    this.timelineRevision.value += 1;
  }

  /** Drop every buffered entry and leave time travel. */
  public clearTimeline(): void {
    this.buffer.clear();
    this.timeTravelIndex.value = null;
    this.timelineRevision.value += 1;
  }

  /** Change the ring-buffer capacity. */
  public setBufferSize(size: number): void {
    this.buffer.resize(size);
    const index = this.timeTravelIndex.value;
    if (index !== null && index >= this.buffer.size) {
      this.timeTravelIndex.value = this.buffer.size - 1;
    }
    this.timelineRevision.value += 1;
  }

  /** Replay state as of `index`; pauses streaming so the view holds still. */
  public travelTo(index: number): void {
    if (this.buffer.size === 0) return;
    const clamped = Math.min(Math.max(index, 0), this.buffer.size - 1);
    this.paused.value = true;
    this.timeTravelIndex.value = clamped;
  }

  /** Leave time travel and resume following live state. */
  public resumeLive(): void {
    this.timeTravelIndex.value = null;
    this.paused.value = false;
    void this.refreshSnapshot().catch(() => {
      // A failed refresh leaves the last known values on screen.
    });
  }
}
