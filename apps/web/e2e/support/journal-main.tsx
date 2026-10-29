/** Test-only mount of the Journal page until Fable wires /journal in routes/pages.tsx. Not part of the app bundle. */
import { render } from "solid-js/web";
import { JournalPage } from "../../src/routes/journal";
import { ensureSession } from "../../src/lib/session";
import "../../src/styles.css";

void ensureSession();
render(
  () => (
    <main id="main" style={{ padding: "16px" }}>
      <JournalPage />
    </main>
  ),
  document.getElementById("root")!,
);
