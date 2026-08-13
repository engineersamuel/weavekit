/**
 * Pure parsing of harness terminal screens.
 *
 * Kept free of I/O so the classification rules — the most failure-prone part of driving a foreign
 * TUI — can be unit tested against recorded screens instead of a live agent.
 */

export const TrellageScreenKind = {
  Menu: "menu",
  Prose: "prose",
} as const;
export type TrellageScreenKind = (typeof TrellageScreenKind)[keyof typeof TrellageScreenKind];

export type TrellageMenuOption = {
  /** 1-based number as rendered by the harness. */
  number: number;
  label: string;
  selected: boolean;
};

export type TrellageScreen =
  | { kind: typeof TrellageScreenKind.Menu; options: TrellageMenuOption[] }
  | { kind: typeof TrellageScreenKind.Prose };

const MENU_LINE = /^\s*([❯›▸>*]?)\s*(\d+)\s*[.)]\s+(\S.*?)\s*$/u;
const AFFIRMATIVE = /^(yes|y\b|allow|approve|accept|proceed|continue|confirm|ok\b)/iu;
const NEGATIVE = /^(no\b|no,|cancel|reject|exit|quit|deny|abort|don'?t)/iu;

/**
 * Classifies a screen captured while the harness was blocked.
 *
 * Only a numbered option list is treated as a menu; anything else is prose, which must be answered
 * with text rather than keystrokes.
 */
export function classifyScreen(text: string): TrellageScreen {
  const options = parseMenuOptions(text);
  return options.length >= 2
    ? { kind: TrellageScreenKind.Menu, options }
    : { kind: TrellageScreenKind.Prose };
}

export function parseMenuOptions(text: string): TrellageMenuOption[] {
  const options: TrellageMenuOption[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const match = MENU_LINE.exec(stripBorders(raw));
    if (!match) continue;
    const number = Number.parseInt(match[2]!, 10);
    // Harnesses render options as a contiguous 1..n run. Restarting the scan on a fresh `1`
    // discards earlier transcript text that happens to look like a list.
    if (number === 1) options.length = 0;
    else if (number !== options.length + 1) continue;
    options.push({ number, label: match[3]!, selected: match[1] !== "" });
  }
  return options;
}

/** Removes the box-drawing frame TUIs wrap dialogs in, which would otherwise defeat line matching. */
function stripBorders(line: string): string {
  return line
    .replace(/^\s*[│┃|]\s?/u, "")
    .replace(/[│┃|]\s*$/u, "")
    .trimEnd();
}

/**
 * Picks the option that approves the request, or `undefined` when no option is unambiguously
 * affirmative.
 *
 * Delegated harnesses run unattended, so approval is the default — but only when the intent is
 * clear. Returning `undefined` escalates the decision to the Submind rather than guessing, which
 * matters because several harnesses render "No, exit" as the pre-selected first option.
 */
export function findApprovalOption(
  options: readonly TrellageMenuOption[],
): TrellageMenuOption | undefined {
  return options.find((option) => AFFIRMATIVE.test(option.label) && !NEGATIVE.test(option.label));
}

export function findOptionByNumber(
  options: readonly TrellageMenuOption[],
  number: number,
): TrellageMenuOption | undefined {
  return options.find((option) => option.number === number);
}

/**
 * Builds the keystrokes that move the harness's selection onto `target` and submit it.
 *
 * When nothing is marked as selected the caller cannot know where the cursor sits, so navigation
 * is anchored by pressing `up` past the top of the list first.
 */
export function keysToChoose(
  options: readonly TrellageMenuOption[],
  target: TrellageMenuOption,
): string[] {
  const selectedIndex = options.findIndex((option) => option.selected);
  const targetIndex = options.findIndex((option) => option.number === target.number);
  if (targetIndex < 0) throw new Error(`Option ${target.number} is not on the screen.`);
  if (selectedIndex < 0) {
    return [...Array.from({ length: options.length }, () => "up"), ...downs(targetIndex), "enter"];
  }
  const delta = targetIndex - selectedIndex;
  const moves =
    delta >= 0 ? downs(delta) : Array.from({ length: Math.abs(delta) }, () => "up" as const);
  return [...moves, "enter"];
}

function downs(count: number): string[] {
  return Array.from({ length: count }, () => "down");
}

/**
 * Extracts the question a harness is asking, for handoff to the Submind answerer.
 *
 * Screens are dominated by box drawing, spinners, and hint footers, so only the trailing
 * substantive lines are kept — the question is always the most recent output.
 */
export function extractQuestion(text: string, maxLines = 40): string {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => stripBorders(line))
    .filter((line) => line.trim().length > 0 && !/^[\s─━═╭╮╰╯┌┐└┘█▀▄•·.]+$/u.test(line));
  return lines.slice(-maxLines).join("\n").trim();
}

/**
 * Returns true only when settled prose contains an actual request for input.
 *
 * Lifecycle-idle TUIs often leave their submitted prompt and static footer on screen before the
 * agent begins working. Treating every such screen as a question feeds banner text back into the
 * harness. A question mark or a narrow input-request imperative is required before the drive loop
 * consults its Submind answerer.
 */
export function isLikelyQuestion(text: string): boolean {
  return text
    .split(/\r?\n/u)
    .map((line) =>
      stripBorders(line)
        .trim()
        .replace(/^●\s*/u, ""),
    )
    .some(
      (line) =>
        line.includes("?") ||
        /^(?:please\s+(?:choose|confirm|enter|provide|select|tell)|choose|confirm|select)\b/iu.test(
          line,
        ),
    );
}
