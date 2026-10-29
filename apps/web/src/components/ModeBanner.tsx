import { Match, Switch } from "solid-js";
import { capabilitiesState } from "../lib/capabilities";

export function ModeBanner() {
  const s = capabilitiesState;
  return (
    <div role="status" aria-live="polite" class="mode-banner" data-mode={s().status === "ready" ? (s() as { envelope: { mode: string } }).envelope.mode : s().status}>
      <Switch>
        <Match when={s().status === "loading"}>Checking runtime mode…</Match>
        <Match when={s().status === "error"}>Server unreachable — runtime mode unknown. Nothing shown here should be treated as real data.</Match>
        <Match when={(s() as { envelope?: { mode: string } }).envelope?.mode === "synthetic"}>SYNTHETIC MODE — fixtures, not real data</Match>
        <Match when={(s() as { envelope?: { mode: string } }).envelope?.mode === "replay"}>REPLAY MODE — historical snapshot, not live data</Match>
        <Match when={(s() as { envelope?: { mode: string } }).envelope?.mode === "live"}>LIVE MODE — live providers where configured</Match>
      </Switch>
    </div>
  );
}
