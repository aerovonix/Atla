/**
 * A small unified diff, used to show the user what a write actually changes
 * before they approve it. Pure and string-in/string-out so the self-test can
 * cover it without touching disk.
 */

const CONTEXT = 3;

/** Classic LCS table. Files here are hand-sized, so O(n*m) is fine. */
function lcs(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

type Op = { kind: " " | "-" | "+"; line: string };

function opsFor(a: string[], b: string[]): Op[] {
  const table = lcs(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "-", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j] });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: "-", line: a[i++] });
  while (j < b.length) ops.push({ kind: "+", line: b[j++] });
  return ops;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  // A trailing newline is a terminator, not an empty last line.
  return text.replace(/\n$/, "").split("\n");
}

/**
 * Unified diff with `CONTEXT` lines of context. Returns "" when the two sides
 * are identical, which callers use to skip a no-op write entirely.
 */
export function unifiedDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = opsFor(a, b);

  // Mark every line within CONTEXT of a change, then emit the marked runs.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.kind === " ") return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) keep[k] = true;
  });

  const out: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx].kind !== "+") oldLine++;
      if (ops[idx].kind !== "-") newLine++;
      idx++;
      continue;
    }
    const startOld = oldLine;
    const startNew = newLine;
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (idx < ops.length && keep[idx]) {
      const op = ops[idx];
      body.push(`${op.kind}${op.line}`);
      if (op.kind !== "+") {
        oldLine++;
        oldCount++;
      }
      if (op.kind !== "-") {
        newLine++;
        newCount++;
      }
      idx++;
    }
    out.push(`@@ -${startOld},${oldCount} +${startNew},${newCount} @@`);
    out.push(...body);
  }
  return out.join("\n");
}

/** "+3 −1", for the one-line summary on a tool card. */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
