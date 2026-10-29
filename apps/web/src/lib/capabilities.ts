import { createRoot, createSignal } from "solid-js";
import { ApiError, getCapabilities, type Envelope, type Capabilities } from "./api";

export type CapabilitiesState =
  | { status: "loading" }
  | { status: "ready"; envelope: Envelope<Capabilities> }
  | { status: "error"; error: ApiError };

const store = createRoot(() => {
  const [state, setState] = createSignal<CapabilitiesState>({ status: "loading" });
  return { state, setState };
});

export const capabilitiesState = store.state;

/** Fetches GET /api/v1/capabilities. Each page calls this on mount; the banner reads the shared state. */
export async function refreshCapabilities(): Promise<void> {
  try {
    store.setState({ status: "ready", envelope: await getCapabilities() });
  } catch (e) {
    store.setState({ status: "error", error: e instanceof ApiError ? e : new ApiError("unknown", "Unexpected error", 0) });
  }
}
