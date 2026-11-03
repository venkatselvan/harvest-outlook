import { For, createMemo, createSignal } from "solid-js";
import { A } from "@solidjs/router";
import { Icon } from "../icons";
import { reportHref } from "./reportApi";
import "./report.css";

export interface LauncherCycle {
  id: string;
  cropId: string;
  cropName?: string | undefined;
  sowingDate: string;
  stage: string;
  fieldId?: string | undefined;
}

/** "Season report" button with a crop picker (Journal tab). Opens `/farm/report?cycle=<id>`. */
export function ReportLauncher(props: {
  cycles: readonly LauncherCycle[];
  cropName: (cropId: string) => string;
  fieldName?: (fieldId: string) => string | undefined;
  dateLabel: (iso: string) => string;
}) {
  const ordered = createMemo(() =>
    [...props.cycles].sort((a, b) => Number(b.stage !== "harvested") - Number(a.stage !== "harvested") || b.sowingDate.localeCompare(a.sowingDate)),
  );
  const [picked, setPicked] = createSignal("");
  const chosen = () => (ordered().some((c) => c.id === picked()) ? picked() : ordered()[0]?.id ?? "");
  const label = (c: LauncherCycle) => {
    const field = c.fieldId ? props.fieldName?.(c.fieldId) : undefined;
    return `${c.cropName ?? props.cropName(c.cropId)}${field ? ` · ${field}` : ""} · sown ${props.dateLabel(c.sowingDate)}${c.stage === "harvested" ? " · harvested" : ""}`;
  };
  return (
    <div class="report-launcher" data-testid="report-launcher">
      <label class="report-launcher-pick">
        <span>Crop for the season report</span>
        <select value={chosen()} onChange={(e) => setPicked(e.currentTarget.value)}>
          <For each={ordered()}>{(c) => <option value={c.id} selected={c.id === chosen()}>{label(c)}</option>}</For>
        </select>
      </label>
      <A class="btn secondary" href={reportHref({ cycleId: chosen() })}>
        <Icon name="journal" size={17} />
        Season report
      </A>
    </div>
  );
}
