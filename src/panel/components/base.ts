/**
 * Base class for the panel's Web Components.
 *
 * Each view is a custom element that renders from {@link PanelState} signals.
 * Subscriptions are created in `connectedCallback` and disposed in
 * `disconnectedCallback`, so switching tabs cannot leak effects.
 *
 * @module panel/components/base
 */
import { effect } from '@bquery/bquery/reactive';
import type { PanelState } from '../state';

/** Panel state is injected once, before the first element is upgraded. */
let sharedState: PanelState | null = null;

/** Provide the state every panel element renders from. */
export const providePanelState = (state: PanelState): void => {
  sharedState = state;
};

/** The injected panel state. */
export const usePanelState = (): PanelState => {
  if (!sharedState) throw new Error('bQuery DevTools: panel state has not been provided');
  return sharedState;
};

/** A custom element that re-renders when the signals it reads change. */
export abstract class PanelElement extends HTMLElement {
  private disposers: Array<() => void> = [];

  /** The shared panel state. */
  protected get state(): PanelState {
    return usePanelState();
  }

  public connectedCallback(): void {
    this.track(effect(() => this.render()));
    this.onConnected();
  }

  public disconnectedCallback(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.onDisconnected();
  }

  /** Register a teardown callback tied to this element's lifetime. */
  protected track(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  /** Extra setup after the first render. */
  protected onConnected(): void {
    /* optional */
  }

  /** Extra teardown. */
  protected onDisconnected(): void {
    /* optional */
  }

  /** Render the element. Must read every signal it wants to react to. */
  protected abstract render(): void;
}

/** Define a custom element once; re-definition is a no-op. */
export const defineElement = (tag: string, ctor: CustomElementConstructor): void => {
  if (typeof customElements === 'undefined' || customElements.get(tag)) return;
  customElements.define(tag, ctor);
};
