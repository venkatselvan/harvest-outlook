import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { renderToString } from "solid-js/web";

/*
 * The inline microphone driven through its real controller and components. There is no DOM in this suite (node + Solid SSR
 * transform), so the browser surfaces are fakes: getUserMedia, MediaRecorder, AudioContext, localStorage. The upload and WAV
 * conversion are stubbed with synthetic values; nothing here is a live Meta response.
 */

const api = vi.hoisted(() => ({
  status: { available: true, provider: "meta", maxSeconds: 60 } as {
    available: boolean;
    provider: string | null;
    maxSeconds?: number;
  },
  uploads: [] as { language: string; farmId?: string }[],
  transcript: "Water the north strip tomorrow",
  detected: "en" as string | null,
}));
vi.mock("./speechApi", () => ({
  fetchSpeechStatus: async () => api.status,
  uploadTranscription: (
    _blob: Blob,
    language: string,
    options: { farmId?: string; onSent?: () => void },
  ) => {
    api.uploads.push({ language, ...(options.farmId ? { farmId: options.farmId } : {}) });
    options.onSent?.();
    return {
      promise: Promise.resolve({
        transcript: api.transcript,
        detectedLanguage: api.detected,
        languageProbability: 0.9,
        synthetic: false,
        providerName: "meta",
      }),
      abort: () => undefined,
    };
  },
}));
vi.mock("./wav", () => ({
  prepareTranscriptionWav: async () => new Blob(["wav"], { type: "audio/wav" }),
}));

import {
  InlineMicControl,
  InlineMicMessages,
  InlineMicNotice,
  barLevels,
  clock,
  createInlineMic,
  insertTranscript,
  type InlineMic,
} from "./InlineMic";
import { UNAVAILABLE_MESSAGE } from "./speechMachine";

const probe = {
  requests: 0,
  trackStops: 0,
  recorders: [] as FakeRecorder[],
  contextsClosed: 0,
  frames: [] as ((time: number) => void)[],
  frequency: 0,
};
class FakeRecorder {
  static isTypeSupported = () => true;
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    probe.recorders.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
      this.onstop?.();
    });
  }
}
class FakeAudioContext {
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 128,
      getByteFrequencyData: (data: Uint8Array) => data.fill(probe.frequency),
    };
  }
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
  resume = async () => undefined;
  close = async () => {
    probe.contextsClosed++;
  };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

let acknowledged = false;
const received: string[] = [];
function setup(options: { maxSeconds?: number } = {}) {
  let mic!: InlineMic;
  const dispose = createRoot((dispose) => {
    mic = createInlineMic({
      language: () => "en",
      farmId: () => "farm-1",
      ...(options.maxSeconds ? { maxSeconds: () => options.maxSeconds } : {}),
      onTranscript: (text) => {
        received.push(text);
      },
    });
    return dispose;
  });
  return { mic, dispose };
}

beforeEach(() => {
  probe.requests = 0;
  probe.trackStops = 0;
  probe.recorders = [];
  probe.contextsClosed = 0;
  probe.frames = [];
  probe.frequency = 0;
  received.length = 0;
  api.uploads = [];
  api.status = { available: true, provider: "meta", maxSeconds: 60 };
  api.transcript = "Water the north strip tomorrow";
  api.detected = "en";
  acknowledged = true;
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("localStorage", {
    getItem: () => (acknowledged ? "1" : null),
    setItem: () => {
      acknowledged = true;
    },
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        probe.requests++;
        return {
          getTracks: () => [{ stop: () => probe.trackStops++ }],
        };
      },
    },
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("OfflineAudioContext", function OfflineAudioContext() {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    probe.frames.push(callback);
    return probe.frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("insertTranscript", () => {
  it("fills an empty composer and ignores an empty transcript", () => {
    expect(insertTranscript("", "  hello  ", 0, 0)).toEqual({ value: "hello", caret: 5, truncated: false });
    expect(insertTranscript("keep", "   ", 4, 4).value).toBe("keep");
  });
  it("appends with one space when text exists, and never doubles whitespace", () => {
    expect(insertTranscript("Water the field", "tomorrow", 15, 15).value).toBe("Water the field tomorrow");
    expect(insertTranscript("Water the field ", "tomorrow", 16, 16).value).toBe("Water the field tomorrow");
  });
  it("inserts at the caret, separating both sides, and puts the caret after the insertion", () => {
    const result = insertTranscript("Water tomorrow", "the north strip", 6, 6);
    expect(result.value).toBe("Water the north strip tomorrow");
    expect(result.caret).toBe("Water the north strip".length);
  });
  it("replaces a selection", () => {
    expect(insertTranscript("Water the XXX now", "north strip", 10, 13).value).toBe("Water the north strip now");
  });
  it("shortens the transcript to the 800 character limit instead of overflowing, and says so", () => {
    const current = "a".repeat(790);
    const result = insertTranscript(current, "b".repeat(40), 790, 790);
    expect(result.value).toHaveLength(800);
    expect(result.truncated).toBe(true);
    const full = insertTranscript("a".repeat(800), "more", 800, 800);
    expect(full.value).toBe("a".repeat(800));
    expect(full.truncated).toBe(true);
  });
});

describe("meter helpers", () => {
  it("keeps every bar within bounds, flat for silence and higher for louder input", () => {
    const silent = barLevels(new Uint8Array(128));
    const loud = barLevels(new Uint8Array(128).fill(200));
    expect(silent).toHaveLength(6);
    expect(silent.every((v) => v > 0 && v < 0.2)).toBe(true);
    expect(loud.every((v, i) => v > silent[i]! && v <= 1)).toBe(true);
    expect(barLevels(new Uint8Array(128).fill(255)).every((v) => v <= 1)).toBe(true);
  });
  it("formats the pill clock with two-digit minutes", () => {
    expect(clock(2.9)).toBe("00:02");
    expect(clock(60)).toBe("01:00");
  });
});

describe("inline microphone controller", () => {
  it("records, shows live levels, transcribes after stop and hands the transcript over without sending anything", async () => {
    const { mic, dispose } = setup();
    await mic.tap();
    expect(mic.state().kind).toBe("recording");
    expect(probe.requests).toBe(1);
    expect(mic.announcement()).toBe("Listening");

    probe.frequency = 180;
    probe.frames.at(-1)!(1000);
    expect(Math.max(...mic.levels())).toBeGreaterThan(0.5);
    expect(renderToString(() => <InlineMicControl mic={mic} />)).toContain("Listening…");

    await mic.tap(); // the same control stops
    await flush();
    expect(received).toEqual(["Water the north strip tomorrow"]);
    expect(mic.state().kind).toBe("review");
    expect(mic.announcement()).toBe("Added to message");
    expect(api.uploads).toEqual([{ language: "en", farmId: "farm-1" }]);
    expect(probe.trackStops).toBe(1);
    expect(probe.contextsClosed).toBe(1);
    expect(mic.levels().every((v) => v < 0.2)).toBe(true);
    dispose();
  });

  it("shows the one-time disclosure before any microphone request, and Not now leaves nothing recording", async () => {
    acknowledged = false;
    const { mic, dispose } = setup();
    await mic.tap();
    expect(mic.state().kind).toBe("disclosure");
    expect(probe.requests).toBe(0);
    const notice = renderToString(() => <InlineMicNotice mic={mic} />);
    expect(notice).toContain("sent to Meta");
    expect(notice).toContain("Continue");
    expect(notice).toContain("Not now");
    mic.declineDisclosure();
    expect(mic.state().kind).toBe("idle");
    expect(probe.requests).toBe(0);
    expect(acknowledged).toBe(false);

    await mic.tap();
    mic.acknowledge();
    await flush();
    expect(acknowledged).toBe(true);
    expect(mic.state().kind).toBe("recording");
    expect(probe.requests).toBe(1);
    dispose();
  });

  it("disables the button with the unavailable message when Meta speech is off, and never asks for the microphone", async () => {
    api.status = { available: false, provider: null };
    const { mic, dispose } = setup();
    await mic.tap();
    expect(mic.disabled()).toBe(true);
    expect(mic.errorText()).toBe(UNAVAILABLE_MESSAGE);
    expect(probe.requests).toBe(0);
    const html = renderToString(() => (
      <>
        <InlineMicControl mic={mic} />
        <InlineMicMessages mic={mic} />
      </>
    ));
    expect(html).toContain("disabled");
    expect(html).toContain(UNAVAILABLE_MESSAGE);
    dispose();
  });

  it("is disabled without recorder support", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const { mic, dispose } = setup();
    expect(mic.disabled()).toBe(true);
    dispose();
  });

  it("cancel discards the recording: tracks released, nothing uploaded, nothing inserted", async () => {
    const { mic, dispose } = setup();
    await mic.tap();
    mic.cancel();
    await flush();
    expect(mic.state().kind).toBe("idle");
    expect(probe.trackStops).toBe(1);
    expect(probe.contextsClosed).toBe(1);
    expect(api.uploads).toEqual([]);
    expect(received).toEqual([]);
    dispose();
  });

  it("stops by itself at the server maximum", async () => {
    vi.useFakeTimers();
    api.status = { available: true, provider: "meta", maxSeconds: 2 };
    const { mic, dispose } = setup();
    await mic.tap();
    expect(mic.max()).toBe(2);
    await vi.advanceTimersByTimeAsync(2300);
    expect(probe.recorders[0]!.state).toBe("inactive");
    vi.useRealTimers();
    await flush();
    expect(mic.state().kind).not.toBe("recording");
    dispose();
  });

  it("an empty transcript is an error, not an inserted blank", async () => {
    api.transcript = "   ";
    const { mic, dispose } = setup();
    await mic.tap();
    await mic.tap();
    await flush();
    expect(received).toEqual([]);
    expect(mic.state().kind).toBe("error");
    expect(mic.errorText()).toContain("too short");
    dispose();
  });

  it("warns when the detected language differs from the composer language", async () => {
    api.detected = "ta";
    const { mic, dispose } = setup();
    await mic.tap();
    await mic.tap();
    await flush();
    expect(mic.warnings().join(" ")).toContain("sounded like Tamil");
    dispose();
  });

  it("a denied microphone returns to a readable error", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => Promise.reject(new Error("denied")) },
    });
    const { mic, dispose } = setup();
    await mic.tap();
    expect(mic.state().kind).toBe("error");
    expect(mic.errorText()).toContain("Microphone access was blocked");
    dispose();
  });
});
