import { Match, Switch, onMount } from "solid-js";
import { capabilitiesState, refreshCapabilities } from "../lib/capabilities";

export function SkeletonPage(props: { title: string; description: string }) {
  onMount(() => {
    document.title = `${props.title} · Harvest Outlook`;
    void refreshCapabilities();
  });
  const s = capabilitiesState;
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title" tabindex="-1">
        {props.title}
      </h1>
      <p>{props.description}</p>
      <div class="card" aria-busy={s().status === "loading"}>
        <h2>Runtime status</h2>
        <Switch>
          <Match when={s().status === "loading"}>
            <p>Loading server capabilities…</p>
          </Match>
          <Match when={s().status === "error"}>
            <p role="alert">
              Could not load capabilities:{" "}
              {(s() as { error: Error }).error.message}. Check that the API is
              running.
            </p>
            <button
              type="button"
              class="btn"
              onClick={() => void refreshCapabilities()}
            >
              Retry
            </button>
          </Match>
          <Match when={s().status === "ready"}>
            {(() => {
              const env = () =>
                (s() as Extract<ReturnType<typeof s>, { status: "ready" }>)
                  .envelope;
              return (
                <dl class="facts">
                  <dt>Mode</dt>
                  <dd>{env().data?.mode}</dd>
                  <dt>Languages</dt>
                  <dd>{env().data?.languages.join(", ")}</dd>
                  <dt>Database</dt>
                  <dd>
                    {env().data?.database.reachable
                      ? "reachable"
                      : "unreachable"}
                  </dd>
                  <dt>Meta provider</dt>
                  <dd>
                    {env().data?.providers.meta
                      ? "configured"
                      : "not configured"}
                  </dd>
                  <dt>Server time</dt>
                  <dd>{env().asOf}</dd>
                </dl>
              );
            })()}
          </Match>
        </Switch>
      </div>
    </section>
  );
}
