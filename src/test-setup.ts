import { vi } from "vitest";

// jsdom doesn't implement layout APIs; stub the ones our components call.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
} else {
  Element.prototype.scrollIntoView = vi.fn();
}
