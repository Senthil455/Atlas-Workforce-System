import "@testing-library/jest-dom";

// Recharts ResponsiveContainer needs ResizeObserver, which jsdom does not
// provide. Stub it so chart components render (at zero size) in unit tests
// instead of throwing.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
