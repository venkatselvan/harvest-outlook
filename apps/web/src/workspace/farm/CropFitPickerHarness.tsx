import { render } from "solid-js/web";
import CropFitView from "./CropFitView";
import { CropFitPicker, type CropFitPickerProps } from "./CropFitPicker";

/**
 * Test-only mount points for e2e/crop-fit.spec.ts, which imports this module through the Vite dev server so the picker
 * and the crop fit view run in a real browser before the year-plan swap sheet (which hosts the picker) exists. The app
 * never imports this file, so it is not part of the production bundle.
 */
export interface PickerSink { picked: unknown[]; closed: number }
export function mountPicker(container: HTMLElement, props: Omit<CropFitPickerProps, "onPick" | "onClose">, sink: PickerSink): () => void {
  return render(
    () => (
      <CropFitPicker
        {...props}
        onPick={(candidate) => {
          sink.picked.push(candidate);
        }}
        onClose={() => {
          sink.closed++;
        }}
      />
    ),
    container,
  );
}
export function mountView(container: HTMLElement, farmId: string): () => void {
  return render(() => <CropFitView farmId={farmId} />, container);
}
