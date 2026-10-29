/**
 * Test-only shell for the Explore e2e: the real ExplorePage and ModeBanner under the real router, with a stub /farm
 * route. Used until Fable wires ExplorePage into App.tsx/pages.tsx; then e2e can target the real app (E2E_BASE_URL).
 */
import { render } from "solid-js/web";
import type { ParentProps } from "solid-js";
import { Navigate, Route, Router, useLocation } from "@solidjs/router";
import { ModeBanner } from "../../../src/components/ModeBanner";
import { ExplorePage } from "../../../src/routes/explore";
import "../../../src/styles.css";

function Layout(props: ParentProps) {
  return (
    <>
      <header class="app-header">
        <span class="brand">Harvest Outlook (explore e2e harness)</span>
        <ModeBanner />
      </header>
      <main id="main">{props.children}</main>
    </>
  );
}

function FarmStub() {
  const loc = useLocation();
  return (
    <div>
      <h1>My farm (stub)</h1>
      <p data-testid="farm-query">{loc.search}</p>
      <p data-testid="selected-crop">{sessionStorage.getItem("ho.selectedCrop") ?? ""}</p>
    </div>
  );
}

render(
  () => (
    <Router root={Layout}>
      <Route path="/" component={() => <Navigate href="/explore" />} />
      <Route path="/explore" component={ExplorePage} />
      <Route path="/farm" component={FarmStub} />
    </Router>
  ),
  document.getElementById("root")!,
);
