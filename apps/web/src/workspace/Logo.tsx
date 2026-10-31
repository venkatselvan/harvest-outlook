/** The supplied Harvest mark is displayed unchanged; the surrounding UI provides contrast. */
export function Logo(props: { size?: number; class?: string; title?: string }) {
  return (
    <img
      class={`harvest-logo ${props.class ?? ""}`}
      src="/brand/harvest-logo.png"
      width={props.size ?? 38}
      height={props.size ?? 38}
      alt={props.title ?? ""}
      aria-hidden={props.title ? undefined : "true"}
      draggable={false}
      decoding="async"
    />
  );
}
