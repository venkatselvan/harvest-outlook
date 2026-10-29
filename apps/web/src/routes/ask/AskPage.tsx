import { onMount } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { AskPanel, type AskContext } from "../../features/ask/AskPanel";

const FARM_KEY = "ho.selectedFarm";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const date = /^\d{4}-\d{2}-\d{2}$/;

function savedFarm(): string | undefined {
  try {
    const v = localStorage.getItem(FARM_KEY);
    return v && uuid.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `/ask`: farm context from the saved farm selection; plan and date from `?planId=` and `?date=` (set by the plan screen link). */
export function AskPage() {
  const [q] = useSearchParams<{ planId?: string; date?: string }>();
  onMount(() => {
    document.title = "Ask · Harvest Outlook";
  });
  const context: AskContext = {
    farmId: savedFarm(),
    planId: q.planId && uuid.test(q.planId) ? q.planId : undefined,
    selectedDate: q.date && date.test(q.date) ? q.date : undefined,
  };
  return (
    <div class="ask-page-wrap">
      <h1>Ask</h1>
      <p class="ask-meta">Ask about your plan, in English, Tamil or Hindi. Only statements that pass the app's checks are shown. Numbers come from the app's calculations, not from the model.</p>
      <AskPanel context={context} />
    </div>
  );
}
