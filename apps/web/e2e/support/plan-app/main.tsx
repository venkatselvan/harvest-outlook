/**
 * Test-only entry for the season e2e: mounts /farm and /farm/plan/:planId without editing App.tsx (Fable wires the real
 * route). Same session bootstrap, mode banner and global styles as the real app.
 */
import { render } from "solid-js/web";
import type { ParentProps } from "solid-js";
import { Navigate, Route, Router } from "@solidjs/router";
import { ModeBanner } from "../../../src/components/ModeBanner";
import { FarmPage } from "../../../src/routes/farm/FarmPage";
import { PlanPage } from "../../../src/routes/plan";
import { ensureSession } from "../../../src/lib/session";
import "../../../src/styles.css";

void ensureSession();

function Layout(props: ParentProps) {
  return (
    <>
      <header class="app-header">
        <span class="brand">Harvest Outlook</span>
        <ModeBanner />
      </header>
      <main id="main" tabindex="-1">{props.children}</main>
    </>
  );
}

render(
  () => (
    <Router root={Layout}>
      <Route path="/farm" component={FarmPage} />
      <Route path="/farm/plan/:planId" component={PlanPage} />
      <Route path="/explore" component={() => <h1>Explore (placeholder in e2e entry)</h1>} />
      <Route path="*" component={() => <Navigate href="/farm" />} />
    </Router>
  ),
  document.getElementById("root")!,
);
