import { createSignal } from "solid-js";

export type Theme = "light" | "dark";
const storageKey = "ho.theme";
const validTheme = (value: unknown): value is Theme =>
  value === "light" || value === "dark";
const [theme, setTheme] = createSignal<Theme>(
  typeof document !== "undefined" &&
    document.documentElement.dataset.theme === "dark"
    ? "dark"
    : "light",
);
export { theme };

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(storageKey);
    return validTheme(value) ? value : null;
  } catch {
    return null;
  }
}
function applyTheme(value: Theme) {
  document.documentElement.dataset.theme = value;
  document.documentElement.style.colorScheme = value;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", value === "dark" ? "#111417" : "#ffffff");
  setTheme(value);
}
/** Follow the system preference until the grower explicitly chooses a theme. */
export function installTheme() {
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = storedTheme();
  const update = () =>
    applyTheme(preference ?? (system.matches ? "dark" : "light"));
  update();
  const systemChanged = () => {
    if (!preference) update();
  };
  const storageChanged = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = storedTheme();
    update();
  };
  const selected = (event: Event) => {
    const value = (event as CustomEvent<Theme>).detail;
    if (!validTheme(value)) return;
    preference = value;
    applyTheme(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      /* Theme still works when storage is blocked. */
    }
  };
  system.addEventListener("change", systemChanged);
  window.addEventListener("storage", storageChanged);
  window.addEventListener("ho:theme", selected);
  return () => {
    system.removeEventListener("change", systemChanged);
    window.removeEventListener("storage", storageChanged);
    window.removeEventListener("ho:theme", selected);
  };
}
export function toggleTheme() {
  window.dispatchEvent(
    new CustomEvent("ho:theme", {
      detail: theme() === "dark" ? "light" : "dark",
    }),
  );
}
