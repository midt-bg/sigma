import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from './report-export';

// downloadBlob touches DOM + object-URL APIs, so it lives in the jsdom project (*.test.tsx). jsdom
// implements neither URL.createObjectURL nor navigation, so both are stubbed here.
describe('downloadBlob (jsdom)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('creates an object URL, triggers the anchor download, and revokes it on a later tick', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    // Add the methods without replacing the URL constructor — jsdom's URL parser backs `a.href`.
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    let anchor: HTMLAnchorElement | undefined;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      anchor = this; // captured while still attached, with href/download set, before .remove()
    });

    const blob = new Blob(['hi'], { type: 'text/plain' });
    downloadBlob(blob, 'отчет.docx');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(anchor?.download).toBe('отчет.docx');
    expect(anchor?.href).toContain('blob:mock-url');
    expect(document.querySelector('a')).toBeNull(); // detached again after the click
    expect(revokeObjectURL).not.toHaveBeenCalled(); // deferred so the browser can read the blob first
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});
