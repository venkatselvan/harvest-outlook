import { ACTIONS, COMPONENTS, type ParamDecl } from "./library";

/**
 * Generates the Evara Lang section of the synthesis instructions from the library declarations (as OpenUI's
 * generateSystemPrompt does for its library). The example programs are fixed strings in code; a test parses and resolves
 * each one (apps/api/test/evara-ui.test.ts). prompts.ts appends the section and PROMPT_HASH covers it.
 */

export interface ExampleProgram {
  family: "crop_choice" | "plan" | "journey" | "care";
  title: string;
  program: string;
}

export const EXAMPLE_PROGRAMS: readonly ExampleProgram[] = [
  {
    family: "crop_choice",
    title: "Crop choice (which crop should I grow next?)",
    program: [
      "root = Stack([lead, table, pick, caveat])",
      "lead = Text(\"b1\")",
      "table = CropCompare([\"green-gram\", \"black-gram\", \"maize\"])",
      "pick = Choice(\"b2\", [@PickCrop(\"green-gram\"), @PickCrop(\"black-gram\"), @ShowJourney(\"green-gram\"), @Open(\"fit\")])",
      "caveat = Text(\"b3\")",
    ].join("\n"),
  },
  {
    family: "plan",
    title: "Plan (the year is full; what can I do instead?)",
    program: ["root = Stack([lead, instead, saved, next])", "lead = Text(\"b1\")", "instead = PlanOptions(\"alternatives\")", "saved = PlanOptions(\"saved\")", "next = Actions([@Open(\"plan\"), @Ask(\"what_could_have_been\")])"].join("\n"),
  },
  {
    family: "journey",
    title: "Journey (show me how ginger would grow here)",
    program: ["root = Stack([lead, journey, next])", "lead = Text(\"b1\")", "journey = GrowthJourney(\"ginger\", null)", "next = Actions([@PickCrop(\"ginger\"), @Compare([\"ginger\", \"turmeric\"])])"].join("\n"),
  },
  {
    family: "care",
    title: "Care (how do I look after my crop in the next 15 days?)",
    program: ["root = Stack([farm, steps, watch, next])", "farm = FarmSnapshot()", "steps = Text(\"b1\")", "watch = Callout(\"warning\", \"b2\")", "next = Actions([@Ask(\"weather_market\"), @Open(\"today\")])"].join("\n"),
  },
];

const sig = (name: string, params: readonly ParamDecl[]) => `${name}(${params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ")})`;

export function evaraLibraryPrompt(): string {
  const lines: string[] = [];
  lines.push("Evara Lang (the `ui` field): a program that arranges your answer blocks and the application's data components on screen.");
  lines.push("- The ui value is one string with one statement per line (lines separated by newlines): name = Expression. The entry statement is named root. A name may be used before the line that defines it; if a name is defined twice the later line wins.");
  lines.push("- Arguments are positional, in the order listed below; write null to skip an optional argument (marked ?). Lists are [a, b].");
  lines.push("- A string is an id, a date (YYYY-MM-DD) or one of the listed enum words, in double quotes, with no spaces. Never put a sentence or a number into the program: every sentence is one of your answerBlocks (shown with Text, Callout or Choice by its id), and code fills every table cell, date, amount and button label.");
  lines.push("- Crop ids are the catalogue crop ids of the stored tool results (farm briefing cycle and crop-fit picks, screen_crops, resolve_crop_identity). PlanOptions and CropCompare already carry their own use, replace and pick buttons; use @UsePlan or @ReplaceSeason only with an option or saved-season id you can see in a stored tool result. The year-plan option ids and saved-season ids are in the farm briefing: `plans.option.optionId`, `plans.alternatives.options[].optionId` and `plans.savedSeasons[].id`, so @UsePlan and @ReplaceSeason can name them. An id that does not exist in this run's data, or a line that breaks a rule, is dropped; the rest still shows.");
  lines.push("Components:");
  for (const c of COMPONENTS) lines.push(`- ${sig(c.name, c.params)}: ${c.summary}.`);
  lines.push("Actions (only inside Choice or Actions lists; the farmer confirms every change in the app, nothing is saved by the action itself):");
  for (const a of ACTIONS) lines.push(`- @${sig(a.name, a.params)}: ${a.summary}.`);
  lines.push("Examples (block ids b1, b2, b3 stand for your own answerBlocks ids):");
  for (const e of EXAMPLE_PROGRAMS) lines.push(`${e.title}:\n${e.program}`);
  return lines.join("\n");
}

export const EVARA_LIBRARY_PROMPT = evaraLibraryPrompt();
