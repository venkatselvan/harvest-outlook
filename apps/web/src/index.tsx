import { render } from "solid-js/web";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { installOffline } from "./features/offline/install";
import { ensureSession } from "./lib/session";
import { installTheme } from "./lib/theme";
import "./styles.css";
import "./workspace/glass.css";

installTheme();

registerSW({ immediate: true });

// Offline support: snapshot cache for plans/farms/journal reads, journal sync queue, banner (features/offline).
installOffline();

// Guest session bootstrap: do not block first paint. Pages that call the API go through apiRequest(), which
// also retries once after a 401. These listeners cover a server that was down at startup.
void ensureSession();
window.addEventListener("online", () => void ensureSession());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void ensureSession();
});

render(() => <App />, document.getElementById("root")!);
