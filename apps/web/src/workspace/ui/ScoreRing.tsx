import "./ui.css";

/** Clamp to 0..100 and round; the ring and its label always agree. */
export const ringValue = (score: number) =>
  Number.isFinite(score) ? Math.round(Math.min(100, Math.max(0, score))) : 0;

/** Small circular 0 to 100 score. The number is drawn inside; the accessible name states the scale. */
export function ScoreRing(props: { score: number; size?: number; label?: string }) {
  const size = () => props.size ?? 40;
  const stroke = () => Math.max(3, Math.round(size() / 10));
  const radius = () => (size() - stroke()) / 2;
  const circumference = () => 2 * Math.PI * radius();
  const value = () => ringValue(props.score);
  return (
    <span
      class="ui-score-ring"
      style={{ width: `${size()}px`, height: `${size()}px` }}
      role="img"
      aria-label={props.label ?? `Score ${value()} out of 100`}
    >
      <svg
        width={size()}
        height={size()}
        viewBox={`0 0 ${size()} ${size()}`}
        aria-hidden="true"
      >
        <circle
          class="ui-score-ring-track"
          cx={size() / 2}
          cy={size() / 2}
          r={radius()}
          stroke-width={stroke()}
          fill="none"
        />
        <circle
          class="ui-score-ring-value"
          cx={size() / 2}
          cy={size() / 2}
          r={radius()}
          stroke-width={stroke()}
          fill="none"
          stroke-linecap="round"
          stroke-dasharray={`${circumference()}`}
          stroke-dashoffset={`${circumference() * (1 - value() / 100)}`}
          transform={`rotate(-90 ${size() / 2} ${size() / 2})`}
        />
      </svg>
      <span
        class="ui-score-ring-num"
        style={{ "font-size": `${Math.max(10, Math.round(size() * 0.34))}px` }}
        aria-hidden="true"
      >
        {value()}
      </span>
    </span>
  );
}
