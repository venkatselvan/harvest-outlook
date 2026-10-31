import { Planner } from "../Planner";

/** Year plan tab content. Currently the existing Planner, unchanged; the Year plan rebuild replaces it here. */
export function YearPlanView() {
  return (
    <div class="farm-tab-scroll embedded-tool">
      <Planner />
    </div>
  );
}
