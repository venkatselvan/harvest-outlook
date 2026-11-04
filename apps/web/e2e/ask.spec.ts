import { expect, test, type Page } from "@playwright/test";

// Every service request and microphone input is a fixture. No provider or real microphone is used.
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const env = (data: unknown) => ({
  requestId: "voice-ui",
  mode: "live",
  asOf: "2026-10-31T00:00:00Z",
  data,
  warnings: [],
  error: null,
});
async function fixture(page: Page, available = true) {
  const turns: any[] = [],
    recordings: Buffer[] = [],
    speechRequests: string[] = [];
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("/speech/")) speechRequests.push(path);
    let data: unknown = {};
    if (path === "/api/v1/assistant/turns") {
      turns.push(route.request().postDataJSON());
      data = {
        status: "approved",
        provenance: "meta_live",
        traceId: "voice-test",
        intent: "plan_question",
        language: "ta",
        gateStatus: "approved",
        answerBlocks: [
          {
            id: "answer",
            kind: "text",
            text: "உங்கள் குறிப்பைச் சரிபார்க்கலாம்.",
            numericRefIds: [],
            claimIds: [],
          },
        ],
        numericRefs: [],
        claimEvidenceRefs: [],
        clarifications: [],
        approvedText: "உங்கள் குறிப்பைச் சரிபார்க்கலாம்.",
        approvedTextHash: "a".repeat(64),
        limitations: [],
        incomplete: null,
        costEstimate: {
          estimatedUsd: 0,
          settledUsd: 0,
          providerCalls: 0,
          billable: false,
          basis: "estimated_not_billed",
        },
      };
    } else if (path === "/api/v1/speech/status")
      data = {
        available,
        provider: "meta",
        qualified: false,
        model: "muse-voice-transcribe-1.0",
      };
    else if (path === "/api/v1/speech/transcriptions") {
      recordings.push(route.request().postDataBuffer()!);
      data = {
        transcript: "நாளை நீர் பாய்ச்ச வேண்டும்",
        detectedLanguage: null,
        languageProbability: null,
        synthetic: false,
        provider: { name: "meta", model: "muse-voice-transcribe-1.0" },
      };
    } else if (path === "/api/v1/session")
      data = { authenticated: true, csrfToken: "test" };
    else if (path === "/api/v1/farms")
      data = {
        farms: [A, B].map((id, i) => ({
          id,
          name: `Voice farm ${i + 1}`,
          location: {
            stateCode: "IN-KA",
            districtId: "IN-KA-hassan",
            districtName: "Hassan",
            precision: "district",
          },
          facts: {},
          areaHectares: 1,
        })),
      };
    else if (path.endsWith("/workspace"))
      data = {
        farmId: path.includes(A) ? A : B,
        version: 1,
        updatedAt: null,
        boundary: null,
        previousHarvest: { status: "none" },
        cycles: [],
        rotationPlans: [],
      };
    else if (path === "/api/v1/crops") data = { crops: [] };
    else if (path === "/api/v1/ai/activity") data = { invocations: [] };
    await route.fulfill({ json: env(data) });
  });
  return { turns, recordings, speechRequests };
}
function stereoFixture() {
  const frames = 8000,
    buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(48000, 24);
  buffer.writeUInt32LE(192000, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    buffer.writeInt16LE(Math.round(Math.sin(i * 0.05) * 5000), 44 + i * 4);
    buffer.writeInt16LE(Math.round(Math.sin(i * 0.05) * 3000), 46 + i * 4);
  }
  return buffer.toString("base64");
}
async function microphone(
  page: Page,
  options: {
    holdConversion?: boolean;
    failConstruction?: boolean;
    holdPermission?: boolean;
  } = {},
) {
  await page.addInitScript(
    ({ base64, options }) => {
      const probe = {
        requests: 0,
        stopped: 0,
        rendered: false,
        release: undefined as undefined | (() => void),
        releasePermission: undefined as undefined | (() => void),
      };
      (window as any).__mic = probe;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            probe.requests++;
            const stream = {
              getTracks: () => [
                {
                  stop: () => {
                    probe.stopped++;
                  },
                },
              ],
            };
            if (options.holdPermission)
              return new Promise((resolve) => {
                probe.releasePermission = () => resolve(stream);
              });
            return stream;
          },
        },
      });
      class Recorder {
        static isTypeSupported() {
          return true;
        }
        state = "inactive";
        ondataavailable: any;
        onstop: any;
        onerror: any;
        constructor() {
          if (options.failConstruction) throw new Error("Recorder failed");
        }
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          queueMicrotask(() => {
            this.ondataavailable?.({
              data: new Blob(
                [Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))],
                { type: "audio/webm" },
              ),
            });
            this.onstop?.();
          });
        }
      }
      (window as any).MediaRecorder = Recorder;
      if (options.holdConversion) {
        const Native = window.OfflineAudioContext;
        (window as any).OfflineAudioContext = function (
          ...args: ConstructorParameters<typeof OfflineAudioContext>
        ) {
          const context = new Native(...args);
          const render = context.startRendering.bind(context);
          context.startRendering = () =>
            new Promise((resolve) => {
              probe.release = () => {
                void render().then((result) => {
                  probe.rendered = true;
                  resolve(result);
                });
              };
            });
          return context;
        };
      }
      localStorage.setItem("ho.speechDisclosureAck", "1"); // Old-provider consent cannot bypass the Meta notice.
    },
    { base64: stereoFixture(), options },
  );
}
async function openVoice(page: Page) {
  await page.goto("/farm");
  await page
    .getByRole("button", { name: "Open Evara", exact: true })
    .first()
    .click();
  await page.getByLabel("Assistant language").selectOption("ta");
  await page
    .getByRole("button", { name: "Record a voice message", exact: true })
    .click();
}

test("multilingual typed Evara answers remain complete with no speech requests or playback controls", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/farm");
  await page
    .getByRole("button", { name: "Open Evara", exact: true })
    .first()
    .click();
  await page.getByLabel("Assistant language").selectOption("ta");
  await page.getByLabel("Message Evara").fill("எப்போது விதைக்கலாம்?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("உங்கள் குறிப்பைச் சரிபார்க்கலாம்.", { exact: true }),
  ).toBeVisible();
  expect(api.turns[0]).toMatchObject({
    text: "எப்போது விதைக்கலாம்?",
    language: "ta",
    farmId: A,
  });
  expect(api.speechRequests).toEqual([]);
  await expect(
    page.getByRole("button", { name: /Listen|Play audio|Stop audio/ }),
  ).toHaveCount(0);
  await expect(page.locator("audio")).toHaveCount(0);
});

test("Meta consent precedes capture; local WAV conversion, and the transcript lands in the composer without being sent", async ({
  page,
}) => {
  const api = await fixture(page);
  await microphone(page);
  await openVoice(page);
  const notice = page.getByRole("group", { name: "Voice privacy notice" });
  await expect(notice).toContainText("sent to Meta");
  expect(await page.evaluate(() => (window as any).__mic.requests)).toBe(0);
  await notice.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Listening…")).toBeVisible();
  await page
    .getByRole("button", { name: "Stop and add to message" })
    .click();
  const transcript = page.getByLabel("Message Evara");
  await expect(transcript).toHaveValue("நாளை நீர் பாய்ச்ச வேண்டும்");
  await expect(transcript).toBeFocused();
  expect(api.recordings).toHaveLength(1);
  expect(api.turns).toHaveLength(0);
  const body = api.recordings[0]!,
    start = body.indexOf("RIFF");
  expect(start).toBeGreaterThan(0);
  expect(body.readUInt16LE(start + 20)).toBe(1);
  expect(body.readUInt16LE(start + 22)).toBe(1);
  expect(body.readUInt32LE(start + 24)).toBe(16000);
  expect(body.readUInt16LE(start + 34)).toBe(16);
  expect(body.toString("utf8", 0, start)).toContain(
    'filename="voice-note.wav"',
  );
  expect(await page.evaluate(() => (window as any).__mic.stopped)).toBe(1);
  await transcript.fill("சரிபார்த்த குறிப்பு");
  await expect(page.getByLabel("Message Evara")).toHaveValue(
    "சரிபார்த்த குறிப்பு",
  );
  expect(api.turns).toHaveLength(0);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => api.turns.length).toBe(1);
  expect(api.turns[0]).toMatchObject({
    text: "சரிபார்த்த குறிப்பு",
    language: "ta",
    farmId: A,
  });
  expect(api.speechRequests.some((path) => path.endsWith("/synthesis"))).toBe(
    false,
  );
});

for (const action of ["cancel", "switch farm"] as const)
  test(`${action} during WAV preparation prevents late upload`, async ({
    page,
  }) => {
    const api = await fixture(page);
    await microphone(page, { holdConversion: true });
    await openVoice(page);
    await page.getByRole("button", { name: "Continue" }).click();
    await page
      .getByRole("button", { name: "Stop and add to message" })
      .click();
    await expect(
      page.getByText("Transcribing…", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => !!(window as any).__mic.release))
      .toBe(true);
    if (action === "cancel")
      await page
        .getByRole("button", { name: "Cancel transcription", exact: true })
        .click();
    else await page.getByLabel("Selected farm").selectOption(B);
    await page.evaluate(() => (window as any).__mic.release());
    await expect
      .poll(() => page.evaluate(() => (window as any).__mic.rendered))
      .toBe(true);
    expect(api.recordings).toHaveLength(0);
    expect(await page.evaluate(() => (window as any).__mic.stopped)).toBe(1);
  });

test("unavailable Meta voice never requests the microphone and typed text remains usable", async ({
  page,
}) => {
  const api = await fixture(page, false);
  await microphone(page);
  await openVoice(page);
  await expect(page.getByText("Speech unavailable; type instead.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record a voice message", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__mic.requests)).toBe(0);
  await page.getByLabel("Message Evara").fill("Typed fallback");
  await expect(page.getByLabel("Message Evara")).toHaveValue("Typed fallback");
  expect(api.recordings).toHaveLength(0);
});

test("recorder construction failure releases microphone tracks", async ({
  page,
}) => {
  const api = await fixture(page);
  await microphone(page, { failConstruction: true });
  await openVoice(page);
  await page.getByRole("button", { name: "Continue" }).click();
  // Scoped to the speech error: the Today hero also renders a role="alert" message when its route is stubbed.
  await expect(page.locator(".mic-error")).toContainText(
    "microphone has been released",
  );
  expect(await page.evaluate(() => (window as any).__mic.stopped)).toBe(1);
  expect(api.recordings).toHaveLength(0);
});

test("cancelling a pending microphone prompt stops tracks when permission resolves late", async ({
  page,
}) => {
  const api = await fixture(page);
  await microphone(page, { holdPermission: true });
  await openVoice(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByText("Waiting for microphone…", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).__mic.releasePermission))
    .toBe(true);
  await page
    .getByRole("button", { name: "Cancel recording", exact: true })
    .click();
  await page.evaluate(() => (window as any).__mic.releasePermission());
  await expect
    .poll(() => page.evaluate(() => (window as any).__mic.stopped))
    .toBe(1);
  await expect(
    page.getByRole("button", { name: "Stop and add to message" }),
  ).toHaveCount(0);
  expect(api.recordings).toHaveLength(0);
});
