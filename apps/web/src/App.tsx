import { AllFarms } from "./workspace/dashboard/AllFarms";
import { CommodityCataloguePage } from "./workspace/CommodityCatalogue";
import { Navigate, Route, Router } from "@solidjs/router";
import { WorkspaceShell } from "./workspace/Shell";
import { FarmHome, FarmSetup } from "./workspace/FarmCommandCenter";
import { Farm, Journal, Plan } from "./routes/pages";
import { SeasonReportPage } from "./workspace/report/SeasonReportPage";
export function App() {
  return (
    <Router root={WorkspaceShell}>
      <Route path="/" component={() => <Navigate href="/farm" />} />
      <Route path="/farm" component={FarmHome} />
      <Route path="/farms" component={AllFarms} />
      <Route path="/farm/setup" component={FarmSetup} />
      <Route path="/farm/report" component={SeasonReportPage} />
      <Route path="/farm/manage" component={FarmHome} />
      <Route path="/farm/details" component={Farm} />
      <Route path="/farm/settings" component={FarmHome} />
      <Route path="/planner" component={FarmHome} />
      <Route path="/explore" component={FarmHome} />
      <Route path="/catalogue" component={CommodityCataloguePage} />
      <Route path="/outlook" component={FarmHome} />
      <Route path="/journal" component={FarmHome} />
      <Route path="/journal/detail" component={Journal} />
      <Route path="/farm/plan/:planId" component={Plan} />
      <Route path="/ask" component={FarmHome} />
      <Route path="*" component={() => <Navigate href="/farm" />} />
    </Router>
  );
}
