import { SkeletonPage } from "../components/SkeletonPage";

export { ExplorePage as Explore } from "./explore";
export { FarmPage as Farm } from "./farm/FarmPage";
export { JournalPage as Journal } from "./journal";
export { PlanPage as Plan } from "./plan";
export const Ask = () => (
  <SkeletonPage title="Ask" description="Ask questions about your plan, in English, Tamil or Hindi. Placeholder." />
);
