import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount + reset the DOM between tests (RTL auto-registers this only when it detects an
// `afterEach` global; register it explicitly so it's robust regardless of config).
afterEach(() => cleanup());

// jsdom doesn't implement matchMedia; stub it so any component that probes a media query
// (e.g. reduced-motion) renders instead of throwing. Returns "no match" for everything.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
