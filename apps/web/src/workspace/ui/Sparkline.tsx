import { For, Show } from "solid-js";
import "./ui.css";

export interface SparklineGeometry {
  /** SVG path data, one "M ... L ..." run per contiguous stretch of values (nulls break the line). */
  path: string;
  /** Point coordinates in viewBox units; null where the value is missing. */
  points: ({ x: number; y: number } | null)[];
  min: number | null;
  max: number | null;
}

/**
 * Pure geometry for a sparkline in a `width` x `height` viewBox. Missing values (null or non-finite) leave gaps rather
 * than being interpolated, so a month without quotes never looks like a quoted price.
 */
export function sparklineGeometry(
  values: readonly (number | null)[],
  width: number,
  height: number,
  pad = 3,
): SparklineGeometry {
  const finite = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (!finite.length) return { path: "", points: values.map(() => null), min: null, max: null };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const step = values.length > 1 ? (width - 2 * pad) / (values.length - 1) : 0;
  const points = values.map((v, i) =>
    typeof v === "number" && Number.isFinite(v)
      ? {
          x: Number((pad + i * step).toFixed(2)),
          y: Number(
            (max === min
              ? height / 2
              : height - pad - ((v - min) / span) * (height - 2 * pad)
            ).toFixed(2),
          ),
        }
      : null,
  );
  let path = "";
  let open = false;
  for (const p of points) {
    if (!p) {
      open = false;
      continue;
    }
    path += `${open ? " L" : `${path ? " " : ""}M`} ${p.x} ${p.y}`;
    open = true;
  }
  return { path, points, min, max };
}

/**
 * Compact trend line. Decorative geometry is hidden from assistive technology; `label` must state what the line shows
 * in words (range, latest value, period). `marks` highlights indices (for example the harvest month in past years).
 */
export function Sparkline(props: {
  values: readonly (number | null)[];
  label: string;
  marks?: readonly number[];
  width?: number;
  height?: number;
  class?: string;
}) {
  const width = () => props.width ?? 300;
  const height = () => props.height ?? 56;
  const geometry = () => sparklineGeometry(props.values, width(), height());
  return (
    <svg
      class={`ui-sparkline${props.class ? ` ${props.class}` : ""}`}
      viewBox={`0 0 ${width()} ${height()}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={props.label}
    >
      <Show when={geometry().path}>
        <For each={props.marks ?? []}>
          {(index) => {
            const p = () => geometry().points[index];
            return (
              <Show when={p()}>
                {(point) => (
                  <line
                    class="ui-sparkline-mark"
                    x1={point().x}
                    x2={point().x}
                    y1={0}
                    y2={height()}
                    vector-effect="non-scaling-stroke"
                  />
                )}
              </Show>
            );
          }}
        </For>
        <path
          class="ui-sparkline-line"
          d={geometry().path}
          fill="none"
          vector-effect="non-scaling-stroke"
        />
      </Show>
    </svg>
  );
}
