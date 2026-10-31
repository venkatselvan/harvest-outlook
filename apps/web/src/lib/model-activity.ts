import { createRoot, createSignal } from "solid-js";
const store = createRoot(() => createSignal(0));
export const foregroundModelRequests = store[0];
/** Request lifetime only changes polling frequency. It never claims that a provider was invoked. */
export function trackForegroundModelRequest(
  path: string,
  method?: string,
): () => void {
  const invokes =
    method?.toUpperCase() === "POST" &&
    /\/assistant\/turns$|\/boundary-assessments$|\/planning-review$|\/soil-reports(?:\/sample)?$|\/speech\/transcriptions$|\/analysis$|\/segmentation$|\/visuals$/.test(
      path,
    );
  if (!invokes) return () => {};
  store[1]((n) => n + 1);
  let finished = false;
  return () => {
    if (!finished) {
      finished = true;
      store[1]((n) => Math.max(0, n - 1));
    }
  };
}
