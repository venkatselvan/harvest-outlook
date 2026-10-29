import { render } from "solid-js/web";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { ensureSession } from "./lib/session";
import "./styles.css";

registerSW({ immediate: true });

// Guest session bootstrap: do not block first paint. Pages that call the API go through apiRequest(), which
// also retries once after a 401. These listeners cover a server that was down at startup.
void ensureSession();
window.addEventListener("online", () => void ensureSession());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void ensureSession();
});

render(() => <App />, document.getElementById("root")!);
