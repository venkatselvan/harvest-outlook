/** The farmer workspace uses one tinted forest theme, independent of device and old stored preferences. */
export type Theme = "dark";
export const theme = (): Theme => "dark";

export function installTheme() {
  const apply = () => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#14251b");
  };
  apply();
  // Older open tabs may still dispatch this event. They cannot switch this workspace to a retired theme.
  window.addEventListener("ho:theme", apply);
  return () => window.removeEventListener("ho:theme", apply);
}
