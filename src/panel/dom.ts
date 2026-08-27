/**
 * Tiny DOM builder used by the panel views.
 *
 * Everything the panel renders is derived from the inspected page, which is
 * untrusted: the builder therefore only ever sets **text**, never markup, so
 * a component named `<img src=x onerror=…>` is displayed rather than
 * executed. `safeHtml` is used for the static chrome around it.
 *
 * @module panel/dom
 */
import { $ } from '@bquery/bquery/core';

/** Attributes and listeners accepted by {@link el}. */
export interface ElementOptions {
  readonly class?: string;
  readonly text?: string;
  readonly title?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  /**
   * Inline styles, applied through the CSSOM.
   *
   * A `style` *attribute* would be refused by the panel's CSP
   * (`style-src 'self'`, no `unsafe-inline`); `style.setProperty` is not.
   */
  readonly style?: Readonly<Record<string, string>>;
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
}

/** Create an element with text content, attributes and listeners. */
export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly (Node | null)[] = []
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title !== undefined) node.title = options.title;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  for (const [name, value] of Object.entries(options.style ?? {})) {
    node.style.setProperty(name, value);
  }
  for (const [name, listener] of Object.entries(options.on ?? {})) {
    node.addEventListener(name, listener);
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
};

/** Replace an element's children in one shot. */
export const replaceChildren = (host: Element, children: readonly (Node | null)[]): void => {
  $(host as HTMLElement).empty();
  for (const child of children) if (child) host.appendChild(child);
};

/** Format a timestamp as `hh:mm:ss.mmm` in the local timezone. */
export const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3
  )}`;
};
