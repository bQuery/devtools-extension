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
import {
  KNOWN_CAPABILITIES,
  type ComponentTreeNode,
  type TimelineEntry,
} from '../protocol/messages';
import {
  parseComponentTree,
  parseSnapshot,
  parseTimelineResult,
  type ComponentView,
  type SignalView,
  type StoreView,
} from '../protocol/results';
import {
  classifyFailure,
  featureAvailable,
  featuresForHandshake,
  featureUnsupported,
  featureUnusable,
  initialFeatures,
  retryAll,
  shouldAttempt,
  withFeature,
  type FeatureMap,
  type FeatureName,
  type FeatureState,
} from './features';
import { TimelineBuffer, type TimelineFilterState } from './timeline';
import { reconstructAt, type Reconstruction, type TimeTravelBase } from './timeTravel';

/** Outcome of one section fetch: usable data, or an answer the panel cannot read. */
type AttemptOutcome = 'ok' | 'unusable';

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
  /** `true` while at least one section fetch is in flight. */
  public readonly loading: Signal<boolean> = signal(false);
  /**
   * What the page has actually proved it can serve.
   *
   * Kept apart from {@link BridgeClient.capabilities}, which is only what the
   * page *claimed* in its handshake. See `panel/features`.
   */
  public readonly features: Signal<FeatureMap> = signal<FeatureMap>(initialFeatures());

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
  /** `true` once a snapshot the panel could read has established a replay base. */
  private baseCaptured = false;
  /** Section fetches in flight, so `loading` reflects all of them, not the last. */
  private inflight = 0;
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

  /** Availability of one feature on the current connection. */
  public feature(name: FeatureName): FeatureState {
    return this.features.value[name];
  }

  /**
   * Whether the scrubber can reconstruct anything.
   *
   * Time travel is performed *by the panel*, by replaying recorded events onto
   * the connect-time snapshot — the page is never asked to do anything. So it
   * is gated on having the two ingredients, not on the page advertising a
   * `time-travel` capability: a partial bridge that answers `getSnapshot` and
   * streams events supports it whether or not it says so.
   */
  public canTimeTravel(): boolean {
    return this.baseCaptured && this.buffer.size > 0;
  }

  /** Start listening to the bridge; refetches on every (re)connect. */
  public start(): void {
    this.disposers.push(
      this.client.onReady(capabilities => {
        // A new handshake is a new page: nothing it proved before still holds.
        this.features.value = featuresForHandshake(capabilities);
        this.baseCaptured = false;
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

  /**
   * Refetch every section.
   *
   * The three fetches are independent and are *not* chained: a page that
   * implements `getTimeline` but not `getSnapshot` must still get a timeline.
   * Nothing here rejects — each section records its own verdict — so one
   * missing bridge method can never take the rest of the panel down with it.
   *
   * @param options - `retry` clears the "this page cannot serve it" verdicts
   *   first, so an explicit user refresh probes everything again.
   */
  public async refreshAll(options: { retry?: boolean } = {}): Promise<void> {
    const force = options.retry === true;
    if (force) this.features.value = retryAll(this.features.value);
    await Promise.all([
      this.refreshTree(force),
      this.refreshSnapshot(force),
      this.seedTimeline(force),
    ]);
    this.lastError.value = this.summarizeFailures();
  }

  /** Refetch the component tree. */
  public async refreshTree(force = false): Promise<void> {
    await this.attempt(['components'], force, async () => {
      const result = parseComponentTree(await this.client.request('getComponentTree'));
      if (!result) return 'unusable';
      this.tree.value = result.tree;
      // Assigned even when empty: a page that unmounted every component must
      // clear the registry, not keep showing the previous counts.
      this.components.value = result.flat;
      return 'ok';
    });
  }

  /**
   * Refetch signals, stores and components, and re-base time travel.
   *
   * One request backs two features, and they are graded separately: a snapshot
   * that carries `signals` but omits `stores` — exactly what an app that never
   * loaded the store module produces — leaves the signals view working and
   * tells the stores view the page does not report any, rather than showing a
   * confident and wrong "0 stores".
   */
  public async refreshSnapshot(force = false): Promise<void> {
    await this.attempt(['signals', 'stores'], force, async () => {
      const snapshot = parseSnapshot(await this.client.request('getSnapshot'));
      if (!snapshot) return 'unusable';

      if (snapshot.reported.signals) this.signals.value = snapshot.signals;
      if (snapshot.reported.stores) this.stores.value = snapshot.stores;
      // Only overwrite the registry when the snapshot actually carried one;
      // otherwise a snapshot-only page would wipe what `getComponentTree` found.
      if (snapshot.reported.components) this.components.value = snapshot.components;

      this.base.value = {
        signals: snapshot.signals,
        stores: snapshot.stores,
        capturedAt: snapshot.exportedAt,
      };
      this.baseCaptured = snapshot.reported.signals || snapshot.reported.stores;

      this.gradeSnapshotSection('signals', snapshot.reported.signals);
      this.gradeSnapshotSection('stores', snapshot.reported.stores);
      return 'ok';
    });
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
  public async seedTimeline(force = false): Promise<void> {
    await this.attempt(['timeline'], force, async () => {
      const entries = parseTimelineResult(
        await this.client.request('getTimeline', { limit: TIMELINE_SEED_LIMIT })
      );
      if (!entries) return 'unusable';
      // Read the buffer *after* awaiting, not before: events that arrive while
      // the request is in flight are in it by now, and a snapshot taken earlier
      // would silently drop exactly those.
      const streamed = [...this.buffer.all()];
      const seeded = new Set(entries.map(entryKey));
      this.buffer.reset(entries);
      this.buffer.extend(streamed.filter(entry => !seeded.has(entryKey(entry))));
      this.timelineRevision.value += 1;
      return 'ok';
    });
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

  /**
   * Run one section fetch and record what it proved.
   *
   * `names` are the features this request backs — more than one when a single
   * method feeds several views. Every outcome, success or failure, is recorded
   * against each of them; nothing propagates out, because a caller that has to
   * catch is a caller that can forget to.
   */
  private async attempt(
    names: readonly FeatureName[],
    force: boolean,
    run: () => Promise<AttemptOutcome>
  ): Promise<void> {
    const wanted = names.filter(name => shouldAttempt(this.features.value[name], force));
    if (wanted.length === 0) return;

    this.inflight += 1;
    this.loading.value = true;
    const before = this.features.value;
    try {
      const outcome = await run();
      for (const name of wanted) {
        // A run that graded a feature itself — a snapshot that parsed but
        // carried no stores, say — knows more than "the request succeeded",
        // so its verdict stands.
        if (this.features.value[name] !== before[name]) continue;
        this.updateFeature(name, current =>
          outcome === 'ok' ? featureAvailable(current) : featureUnusable(current)
        );
      }
    } catch (error) {
      for (const name of wanted) {
        this.updateFeature(name, current => classifyFailure(current, error));
      }
    } finally {
      this.inflight -= 1;
      if (this.inflight === 0) this.loading.value = false;
    }
  }

  /**
   * Grade one collection of a snapshot that parsed but may not carry it.
   *
   * Graded in both directions, so the verdict follows the page: a section
   * written off when the app had not loaded that module comes back by itself
   * once a later snapshot carries it.
   */
  private gradeSnapshotSection(name: FeatureName, reported: boolean): void {
    this.updateFeature(name, current =>
      reported
        ? featureAvailable(current)
        : featureUnsupported(current, "the page's snapshot does not include them")
    );
  }

  private updateFeature(name: FeatureName, next: (current: FeatureState) => FeatureState): void {
    const map = this.features.value;
    this.features.value = withFeature(map, name, next(map[name]));
  }

  /**
   * One line for the status bar covering sections that *should* work and did
   * not. Features the page simply cannot serve are not errors — the views say
   * so themselves — so they are deliberately left out.
   */
  private summarizeFailures(): string {
    const map = this.features.value;
    const failed = KNOWN_CAPABILITIES.filter(name => map[name].status === 'failed');
    const first = failed[0];
    if (first === undefined) return '';
    const others = failed.length > 1 ? ` (and ${failed.length - 1} more)` : '';
    return `Could not load ${failed.join(', ')}: ${map[first].detail}${others}`;
  }

  /** Leave time travel and resume following live state. */
  public resumeLive(): void {
    this.timeTravelIndex.value = null;
    this.paused.value = false;
    // `refreshSnapshot` records its own verdict and never rejects; a failure
    // leaves the last known values on screen and says so in the status bar.
    void this.refreshSnapshot();
  }
}
