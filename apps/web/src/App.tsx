import type { ParentProps } from "solid-js";
import { Navigate, Route, Router } from "@solidjs/router";
import { BottomNav } from "./components/BottomNav";
import { ModeBanner } from "./components/ModeBanner";
import { Ask, Explore, Farm, Journal } from "./routes/pages";

function Layout(props: ParentProps) {
  return (
    <>
      <a class="skip-link" href="#main">Skip to content</a>
      <header class="app-header">
        <span class="brand">Harvest Outlook</span>
        <ModeBanner />
      </header>
      <main id="main" tabindex="-1">{props.children}</main>
      <BottomNav />
    </>
  );
}

export function App() {
  return (
    <Router root={Layout}>
      <Route path="/" component={() => <Navigate href="/explore" />} />
      <Route path="/explore" component={Explore} />
      <Route path="/farm" component={Farm} />
      <Route path="/journal" component={Journal} />
      <Route path="/ask" component={Ask} />
      <Route path="*" component={() => <Navigate href="/explore" />} />
    </Router>
  );
}
