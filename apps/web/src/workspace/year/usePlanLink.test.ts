import { describe, expect, it } from "vitest";
import { USE_PLAN_ALTERNATIVE_PARAM, USE_PLAN_OPTION_PARAM, usePlanHref } from "../evara/actions";
import { farmHref, selectedTab } from "../farmTabs";
import { replaceReview } from "./alternatives-fixtures";
import { hasUsePlanParams, usePlanTarget, withoutUsePlanParams } from "./usePlanLink";

const ownId = replaceReview.options[0]!.optionId;

describe("use_plan link", () => {
  it("is the Plan tab URL that farmHref and selectedTab route, with the two parameters appended", () => {
    const href = usePlanHref({ kind: "use_plan", optionId: "alt-1", fieldId: "field-a", alternative: true } as never, null);
    const url = new URL(href, "https://app.test");
    expect(url.pathname).toBe("/farm");
    expect(url.searchParams.get("tab")).toBe("year");
    expect(url.searchParams.get("field")).toBe("field-a");
    expect(url.searchParams.get(USE_PLAN_OPTION_PARAM)).toBe("alt-1");
    expect(url.searchParams.get(USE_PLAN_ALTERNATIVE_PARAM)).toBe("1");
    expect(href.startsWith(farmHref("year", undefined, "field-a"))).toBe(true);
    expect(selectedTab(url.pathname, url.searchParams.get("tab") ?? undefined)).toBe("year");
  });
});

describe("usePlanTarget", () => {
  it("opens an alternatives option in alternative mode when the flag is set", () => {
    expect(usePlanTarget("?tab=year&field=f&option=alt-1&alternative=1", replaceReview)).toEqual({ optionId: "alt-1", alternative: true });
  });
  it("opens one of the review's own options as a normal plan", () => {
    expect(usePlanTarget(`?tab=year&option=${ownId}`, replaceReview)).toEqual({ optionId: ownId, alternative: false });
  });
  it("follows the review when the flag disagrees with it, rather than opening nothing", () => {
    expect(usePlanTarget("?option=alt-2", replaceReview)).toEqual({ optionId: "alt-2", alternative: true });
    expect(usePlanTarget(`?option=${ownId}&alternative=1`, replaceReview)).toEqual({ optionId: ownId, alternative: false });
  });
  it("finds nothing for an id the loaded review does not have, no option parameter, no review or alternatives absent", () => {
    expect(usePlanTarget("?option=alt-9&alternative=1", replaceReview)).toBeNull();
    expect(usePlanTarget("?tab=year&alternative=1", replaceReview)).toBeNull();
    expect(usePlanTarget("?option=alt-1", undefined)).toBeNull();
    expect(usePlanTarget("?option=alt-1&alternative=1", { ...replaceReview, alternatives: null })).toBeNull();
    expect(usePlanTarget("?option=alt-1&alternative=1", { options: replaceReview.options })).toBeNull();
  });
});

describe("withoutUsePlanParams", () => {
  it("drops only the two parameters and keeps the rest", () => {
    expect(withoutUsePlanParams("?tab=year&field=f&option=alt-1&alternative=1")).toBe("?tab=year&field=f");
    expect(withoutUsePlanParams("?option=alt-1")).toBe("");
    expect(withoutUsePlanParams("?tab=year")).toBe("?tab=year");
    expect(hasUsePlanParams("?tab=year&option=x")).toBe(true);
    expect(hasUsePlanParams("?tab=year")).toBe(false);
    expect(hasUsePlanParams(withoutUsePlanParams("?tab=year&option=x&alternative=1"))).toBe(false);
  });
});
