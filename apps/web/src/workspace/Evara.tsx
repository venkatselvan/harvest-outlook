/** The supplied Evara character is shared by the launcher, chat, onboarding and model activity. */
export function Evara(props: {
  size?: number;
  class?: string;
  title?: string;
}) {
  return (
    <img
      class={`evara-mascot ${props.class ?? ""}`}
      src="/brand/evara-mascot.png"
      width={props.size ?? 42}
      height={props.size ?? 42}
      alt={props.title ?? ""}
      aria-hidden={props.title ? undefined : "true"}
      title={props.title}
      draggable={false}
      decoding="async"
    />
  );
}
