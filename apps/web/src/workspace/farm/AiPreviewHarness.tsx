import { render } from 'solid-js/web';
import { SoilReviewView } from './SoilReviewPanel';
import { readyModelReview, SOIL_FIXTURE_FARM_ID } from './soilReviewFixtures';
/** Development-only mount of the real soil review component for the AI guide's example screen. */
export function mountSoil(container: HTMLElement) {
  if (!import.meta.env.DEV) throw new Error('Preview capture is development-only');
  container.style.cssText = 'position:relative;z-index:10;width:600px;max-width:100%;padding:16px;background:var(--surface);';
  return render(() => <SoilReviewView review={readyModelReview} farmId={SOIL_FIXTURE_FARM_ID} refreshing={false} refreshError="" onRefresh={() => {}}/>, container);
}
