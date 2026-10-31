import { beforeEach, describe, expect, it } from "vitest";
import { clearSessionState } from "../../lib/session";
import { uploadTranscription } from "./speechApi";
import {
  errorMessage,
  formatTimer,
  initialVoiceState,
  languageMismatchWarning,
  pickMimeType,
  voiceReducer,
  type TranscriptResult,
  type VoiceEvent,
  type VoiceState,
} from "./speechMachine";

const run = (start: VoiceState, events: VoiceEvent[]) =>
  events.reduce(voiceReducer, start);
const result: TranscriptResult = {
  transcript: "hello",
  detectedLanguage: "eng",
  languageProbability: 0.9,
  synthetic: false,
  providerName: "meta",
};

describe("voice input state machine", () => {
  it("starts in text-only mode when MediaRecorder is unsupported, and recording can never begin", () => {
    const s = initialVoiceState(false);
    expect(s.kind).toBe("unsupported");
    expect(
      voiceReducer(s, {
        type: "tap_record",
        supported: false,
        disclosureAcknowledged: true,
      }).kind,
    ).toBe("unsupported");
    expect(voiceReducer(s, { type: "permission_granted" }).kind).toBe(
      "unsupported",
    );
    expect(voiceReducer(s, { type: "reset" }).kind).toBe("unsupported");
  });

  it("shows the provider disclosure before the first recording and asks for the mic only after it", () => {
    const first = voiceReducer(
      { kind: "idle" },
      { type: "tap_record", supported: true, disclosureAcknowledged: false },
    );
    expect(first.kind).toBe("disclosure");
    expect(voiceReducer(first, { type: "acknowledge_disclosure" }).kind).toBe(
      "requesting_permission",
    );
    expect(
      voiceReducer(
        { kind: "idle" },
        { type: "tap_record", supported: true, disclosureAcknowledged: true },
      ).kind,
    ).toBe("requesting_permission");
  });

  it("walks the happy path idle to review", () => {
    const s = run({ kind: "idle" }, [
      { type: "tap_record", supported: true, disclosureAcknowledged: true },
      { type: "permission_granted" },
      { type: "tick", elapsed: 12.4, maxSeconds: 60 },
      { type: "recorded" },
      { type: "prepared" },
      { type: "upload_progress", fraction: 0.5 },
      { type: "upload_sent" },
      { type: "result", result },
    ]);
    expect(s).toEqual({ kind: "review", result });
  });

  it("flags the 60 s cap, clamps elapsed time and keeps the flag", () => {
    let s = run({ kind: "recording", elapsed: 0, capReached: false }, [
      { type: "tick", elapsed: 59.9, maxSeconds: 60 },
    ]);
    expect(s).toMatchObject({ capReached: false });
    s = run(s, [
      { type: "tick", elapsed: 60.2, maxSeconds: 60 },
      { type: "tick", elapsed: 75, maxSeconds: 60 },
    ]);
    expect(s).toEqual({ kind: "recording", elapsed: 60, capReached: true });
  });

  it("denied permission and provider failures end in an error that does not touch typed text", () => {
    const denied = run({ kind: "idle" }, [
      { type: "tap_record", supported: true, disclosureAcknowledged: true },
      { type: "permission_denied" },
    ]);
    expect(denied).toMatchObject({ kind: "error", code: "permission_denied" });
    const failed = run({ kind: "processing" }, [
      { type: "fail", code: "provider_unavailable" },
    ]);
    expect(failed).toMatchObject({
      kind: "error",
      message: "Speech unavailable; type instead.",
    });
  });

  it("cancel from any busy state returns to idle; stale events are ignored", () => {
    for (const s of [
      { kind: "requesting_permission" },
      { kind: "recording", elapsed: 3, capReached: false },
      { kind: "preparing" },
      { kind: "uploading", progress: 0.2 },
      { kind: "processing" },
    ] as VoiceState[]) {
      expect(voiceReducer(s, { type: "cancel" }).kind).toBe("idle");
    }
    expect(
      voiceReducer({ kind: "idle" }, { type: "result", result }).kind,
    ).toBe("idle");
    expect(
      voiceReducer({ kind: "idle" }, { type: "fail", code: "x" }).kind,
    ).toBe("idle");
    expect(
      voiceReducer(
        { kind: "recording", elapsed: 1, capReached: false },
        { type: "tap_record", supported: true, disclosureAcknowledged: true },
      ).kind,
    ).toBe("recording");
  });

  it("clamps upload progress", () => {
    expect(
      voiceReducer(
        { kind: "uploading", progress: 0 },
        { type: "upload_progress", fraction: 3 },
      ),
    ).toEqual({ kind: "uploading", progress: 1 });
  });
});

describe("language mismatch and messages", () => {
  it("warns when detected differs from selected, normalising ISO-639-3", () => {
    expect(languageMismatchWarning("tam", "en")).toContain("Tamil");
    expect(languageMismatchWarning("tam", "en")).toContain("English");
    expect(languageMismatchWarning("eng", "en")).toBeNull();
    expect(languageMismatchWarning("hi", "hi")).toBeNull();
    expect(languageMismatchWarning(null, "ta")).toBeNull();
    expect(languageMismatchWarning("fra", "en")).toContain("fra");
  });
  it("formats timer and maps unavailable errors to the fallback wording", () => {
    expect(formatTimer(12.9)).toBe("0:12");
    expect(formatTimer(60)).toBe("1:00");
    for (const c of [
      "provider_unavailable",
      "provider_error",
      "provider_rate_limited",
    ])
      expect(errorMessage(c)).toBe("Speech unavailable; type instead.");
  });
});

describe("mime negotiation", () => {
  it("prefers webm/opus, then mp4, else null (text only)", () => {
    expect(pickMimeType((t) => true)).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBeNull();
    expect(pickMimeType(undefined)).toBeNull();
    expect(
      pickMimeType(() => {
        throw new Error("x");
      }),
    ).toBeNull();
  });
});

describe("speech API client", () => {
  beforeEach(() => clearSessionState());

  const sessionFetch = (
    extra?: (url: string, init?: RequestInit) => Response | undefined,
  ): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const custom = extra?.(u, init);
      if (custom) return custom;
      return new Response(
        JSON.stringify({ data: { authenticated: true, csrfToken: "csrf-1" } }),
        { status: 200 },
      );
    }) as typeof fetch;

  class FakeXhr {
    headers: Record<string, string> = {};
    upload: {
      onprogress:
        | ((e: {
            lengthComputable: boolean;
            loaded: number;
            total: number;
          }) => void)
        | null;
      onload: (() => void) | null;
    } = { onprogress: null, onload: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    withCredentials = false;
    status = 200;
    responseText = "";
    sent: FormData | null = null;
    opened: [string, string] | null = null;
    constructor(private readonly respond: (x: FakeXhr) => void) {}
    open(m: string, u: string) {
      this.opened = [m, u];
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    send(b: FormData) {
      this.sent = b;
      queueMicrotask(() => this.respond(this));
    }
    abort() {
      this.onabort?.();
    }
  }
  const env = (data: unknown, error: unknown = null) =>
    JSON.stringify({
      requestId: "r",
      mode: "live",
      asOf: "x",
      data,
      warnings: [],
      error,
    });

  it("uploads multipart with CSRF, reports progress and parses the transcript", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = sessionFetch();
    try {
      const progress: number[] = [];
      const x = new FakeXhr((self) => {
        self.upload.onprogress?.({
          lengthComputable: true,
          loaded: 50,
          total: 100,
        });
        self.upload.onload?.();
        self.responseText = env({
          transcript: "two acres",
          detectedLanguage: "en",
          languageProbability: 0.9,
          synthetic: false,
          provider: { name: "meta" },
        });
        self.onload?.();
      });
      const h = uploadTranscription(
        new Blob(["abc"], { type: "audio/wav" }),
        "en",
        { farmId: "f1", onProgress: (f) => progress.push(f) },
        { createXhr: () => x as never },
      );
      const r = await h.promise;
      expect(r).toMatchObject({
        transcript: "two acres",
        detectedLanguage: "en",
        providerName: "meta",
      });
      expect(progress).toEqual([0.5]);
      expect(x.opened).toEqual(["POST", "/api/v1/speech/transcriptions"]);
      expect(x.headers["x-csrf-token"]).toBe("csrf-1");
      expect(x.sent?.get("language")).toBe("en");
      expect(x.sent?.get("farmId")).toBe("f1");
      expect((x.sent?.get("audio") as File).size).toBe(3);
      expect((x.sent?.get("audio") as File).name).toBe("voice-note.wav");
      expect((x.sent?.get("audio") as File).type).toBe("audio/wav");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("surfaces API error codes, network errors and cancellation distinctly", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = sessionFetch();
    try {
      const failing = new FakeXhr((s) => {
        s.status = 424;
        s.responseText = env(null, {
          code: "provider_unavailable",
          message: "Speech unavailable",
        });
        s.onload?.();
      });
      await expect(
        uploadTranscription(
          new Blob(["a"]),
          "ta",
          {},
          { createXhr: () => failing as never },
        ).promise,
      ).rejects.toMatchObject({ code: "provider_unavailable", status: 424 });
      const net = new FakeXhr((s) => s.onerror?.());
      await expect(
        uploadTranscription(
          new Blob(["a"]),
          "ta",
          {},
          { createXhr: () => net as never },
        ).promise,
      ).rejects.toMatchObject({ code: "network_error" });
      const hang = new FakeXhr(() => undefined);
      const h = uploadTranscription(
        new Blob(["a"]),
        "ta",
        {},
        { createXhr: () => hang as never },
      );
      await new Promise((r) => setTimeout(r, 0));
      h.abort();
      await expect(h.promise).rejects.toMatchObject({
        code: "client_cancelled",
      });
    } finally {
      globalThis.fetch = orig;
    }
  });
});
