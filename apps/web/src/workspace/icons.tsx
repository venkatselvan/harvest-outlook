import type { JSX } from "solid-js";
export function Icon(props: { name: string; size?: number; class?: string }) {
  const paths: Record<string, JSX.Element> = {
    satellite: <><path d="m9 9 6 6 4-4-6-6Z M3 7l4-4 4 4-4 4Z M13 17l4-4 4 4-4 4Z M5 15l4-4M3 14a7 7 0 0 0 7 7M3 18a3 3 0 0 0 3 3"/></>,
    camera: <><path d="M8 5 6 8H3v12h18V8h-3l-2-3Z"/><circle cx="12" cy="13" r="4"/></>,
    leaf: (
      <>
        <path d="M20 4c-7-1-14 1-14 8a6 6 0 0 0 6 6c7 0 9-7 8-14Z" />
        <path d="m4 21 11-11M9 16v-5m1 4h5" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
    map: (
      <>
        <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z" />
        <path d="M9 3v15m6-12v15" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v4m10-4v4M3 11h18m-14 4h3m4 0h3" />
      </>
    ),
    compare: (
      <>
        <path d="M4 5h16M7 3v4m10-4v4M6 11v10m6-14v14m6-6v6" />
      </>
    ),
    journal: (
      <>
        <path d="M5 3h14v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 17h16M8 7h7m-7 4h5" />
      </>
    ),
    chat: (
      <>
        <path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 0 1-1-5 9 9 0 0 1 18 0Z" />
        <path d="M8 11h.01M12 11h.01M16 11h.01" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    collapse: <path d="M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5" />,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></>,
    moon: <path d="M20.5 13.1A8.6 8.6 0 0 1 10.9 3.5a8.7 8.7 0 1 0 9.6 9.6Z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    mic: (
      <>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0m-7 7v3" />
      </>
    ),
    stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    swap: <path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" />,
    pin: (
      <>
        <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" />
        <circle cx="12" cy="10" r="2" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" />
      </>
    ),
    rain: (
      <>
        <path d="M7 15a5 5 0 1 1 1-10 6 6 0 0 1 11 3 4 4 0 0 1 0 8M8 17l-1 3m6-3-1 3m6-3-1 3" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    down: <path d="m6 9 6 6 6-6" />,
    target: (
      <>
        <circle cx="12" cy="12" r="7" />
        <circle cx="12" cy="12" r="2" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
      </>
    ),
    draw: (
      <>
        <path d="m5 5 14 2-2 13L4 17Z" />
        <circle cx="5" cy="5" r="2" />
        <circle cx="19" cy="7" r="2" />
        <circle cx="17" cy="20" r="2" />
        <circle cx="4" cy="17" r="2" />
      </>
    ),
    trend: (
      <>
        <path d="m3 17 6-6 4 4 8-10m-6 0h6v6" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="8" cy="7" r="3" />
        <circle cx="16" cy="17" r="3" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    send: (
      <>
        <path d="m22 2-7 20-4-9-9-4Z" />
        <path d="m11 13 11-11" />
      </>
    ),
    history: (
      <>
        <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8Zm-9 9 9 5 9-5m-18 5 9 5 9-5" />
      </>
    ),
  };
  return (
    <svg
      class={props.class}
      width={props.size ?? 20}
      height={props.size ?? 20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.65"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {paths[props.name] ?? paths.leaf}
    </svg>
  );
}
