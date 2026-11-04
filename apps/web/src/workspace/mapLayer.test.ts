import { describe, expect, it } from "vitest";
import { DEFAULT_PADDING, fitPadding, isMapTab, mapLayerState, pinAnchor, ringCentre } from "./mapLayer";

describe("map layer fallback", () => {
  it("shows the map only for a located farm whose imagery loads", () => {
    expect(mapLayerState({ located: false, tilesLoaded: 5, tileErrors: 0 })).toBe("flat");
    expect(mapLayerState({ located: true, tilesLoaded: 0, tileErrors: 0 })).toBe("map");
    expect(mapLayerState({ located: true, tilesLoaded: 0, tileErrors: 3 })).toBe("flat");
    // One failed edge tile next to loaded ones keeps the map.
    expect(mapLayerState({ located: true, tilesLoaded: 4, tileErrors: 1 })).toBe("map");
  });
  it("promotes the backdrop on Today and Actions only", () => {
    expect(isMapTab("today")).toBe(true);
    expect(isMapTab("actions")).toBe(true);
    for (const tab of ["year", "harvest", "soil", "modify"] as const) expect(isMapTab(tab)).toBe(false);
    expect(isMapTab(undefined)).toBe(false);
  });
  it("fits the farm into the open centre, clamped to the screen, and falls back without one", () => {
    const viewport = { width: 1440, height: 900 };
    expect(fitPadding(null, viewport)).toEqual(DEFAULT_PADDING);
    expect(fitPadding({ top: 220, left: 560, right: 1040, bottom: 2400 }, viewport)).toEqual({ topLeft: [560, 220], bottomRight: [400, 24] });
    // A centre narrower than the minimum box uses the default padding.
    expect(fitPadding({ top: 220, left: 700, right: 760, bottom: 800 }, viewport)).toEqual(DEFAULT_PADDING);
  });
  it("anchors the pin under the outline and centres field chips on their box", () => {
    const ring = [[76, 12], [76.02, 12], [76.02, 12.01], [76, 12.01], [76, 12]];
    const [lat, lon] = ringCentre(ring)!;
    expect(lat).toBeCloseTo(12.005, 9);
    expect(lon).toBeCloseTo(76.01, 9);
    const [pinLat, pinLon] = pinAnchor(ring, null)!;
    expect(pinLat).toBe(12);
    expect(pinLon).toBeCloseTo(76.01, 9);
    expect(pinAnchor(undefined, [13, 77])).toEqual([13, 77]);
    expect(ringCentre([[76, 12]])).toBeNull();
  });
});
