import type { SamPrompt } from "./options";

export interface SamSize {
  width: number;
  height: number;
}

const clampPx = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v)));

/**
 * Builds the SAM input_text. Concept prompts are a short noun phrase. Token prompts follow the documented
 * grammar `<0f>id<|box;x1=;y1=;x2=;y2=;w=;h=|>` / `id<|point;x=;y=;w=;h=|>` in sent-image pixels (x2/y2
 * inclusive; w/h are the sent image's pixel dimensions). The encoding of several points for one object and the
 * `-` prefix for negative points follow the notes' wording and are UNVERIFIED against a live call.
 */
export function buildPromptText(prompt: SamPrompt, sent: SamSize): string {
  const { width: w, height: h } = sent;
  switch (prompt.kind) {
    case "concept": {
      const t = prompt.text.trim().replace(/[<>|;=\n\r]/g, " ").replace(/\s+/g, " ").trim();
      if (!t || t.length > 40) throw new Error("concept prompt must be a short noun phrase");
      return t;
    }
    case "box": {
      const x1 = clampPx(Math.min(prompt.x0, prompt.x1) * w, w - 1);
      const y1 = clampPx(Math.min(prompt.y0, prompt.y1) * h, h - 1);
      const x2 = clampPx(Math.max(prompt.x0, prompt.x1) * w - 1, w - 1);
      const y2 = clampPx(Math.max(prompt.y0, prompt.y1) * h - 1, h - 1);
      return `<0f>1<|box;x1=${x1};y1=${y1};x2=${Math.max(x1, x2)};y2=${Math.max(y1, y2)};w=${w};h=${h}|>`;
    }
    case "points": {
      if (prompt.points.length < 1 || prompt.points.length > 16) throw new Error("1 to 16 points");
      const recs = prompt.points.map((p) => `${p.positive === false ? "-" : ""}1<|point;x=${clampPx(p.x * w, w - 1)};y=${clampPx(p.y * h, h - 1)};w=${w};h=${h}|>`);
      return `<0f>${recs.join(",")}`;
    }
  }
}
