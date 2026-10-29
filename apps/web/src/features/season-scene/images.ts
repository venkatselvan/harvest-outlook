/** Preloads an image once; resolves null on error so a missing keyframe degrades to the schematic. No retries, no network on later prop changes. */
export function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    const img = new Image();
    const done = (v: HTMLImageElement | null) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const onAbort = () => done(null);
    signal?.addEventListener("abort", onAbort, { once: true });
    img.onload = () => done(img.naturalWidth > 0 ? img : null);
    img.onerror = () => done(null);
    img.decoding = "async";
    img.src = url;
  });
}
