// One-off generator for the committed *.txt fixtures (SYNTHETIC). Run: pnpm --filter @harvest/api exec tsx test/fixtures/sam/generate.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { frame, rectBits, record } from "./build";

const dir = dirname(fileURLToPath(import.meta.url));
const W = 40;
const H = 30;
const w = 160;
const h = 120;
const a = { id: 1, box: { x1: 40, y1: 20, x2: 119, y2: 99, c: 0.93 }, mask: { bits: rectBits(W, H, 10, 5, 30, 25), W, H, c: 0.9, variant: "rfc1924" as const } };
const b = { id: 2, box: { x1: 0, y1: 0, x2: 31, y2: 23, c: 0.41 }, mask: { bits: rectBits(W, H, 0, 0, 8, 6), W, H, c: 0.35, variant: "rfc1924" as const } };
writeFileSync(join(dir, "two-objects-rfc1924.txt"), frame(0, [record(a, w, h), record(b, w, h)]) + "\n");
const noC = (o: typeof a) => ({ ...o, box: { x1: o.box.x1, y1: o.box.y1, x2: o.box.x2, y2: o.box.y2 }, mask: { bits: o.mask.bits, W, H, variant: "ascii85" as const } });
writeFileSync(join(dir, "one-object-no-confidence-ascii85.txt"), frame(0, [record(noC(a), w, h)]) + "\n");
writeFileSync(join(dir, "skipped-frames.txt"), "<0f>\n\n<3f>\n" + record(noC(b), w, h) + "\n<5f>\n");
writeFileSync(join(dir, "empty.txt"), "");
