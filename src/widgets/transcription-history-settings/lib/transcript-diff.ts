const MAX_LCS_WORDS = 700;
const MAX_LCS_CELLS = 160_000;

export interface TranscriptDiffHunk {
  after: string;
  before: string;
  kind: "change" | "equal";
}

export interface TranscriptDiffChange {
  after: string;
  before: string;
  kind: "delete" | "insert" | "replace";
}

export interface TranscriptDiffResult {
  changes: TranscriptDiffChange[];
  coarse: boolean;
  hunks: TranscriptDiffHunk[];
}

type DiffOp =
  | { kind: "delete"; word: string }
  | { kind: "equal"; word: string }
  | { kind: "insert"; word: string };

function dpValue(dp: Uint16Array, index: number): number {
  return dp[index] ?? 0;
}

function tokenizeWords(text: string): string[] {
  return text.match(/\S+/g) ?? [];
}

function collapseWords(words: readonly string[]): string {
  return words.join(" ");
}

function normalizedWords(text: string): string {
  return collapseWords(tokenizeWords(text));
}

function changeKind(
  before: string,
  after: string,
): TranscriptDiffChange["kind"] {
  if (!before) {
    return "insert";
  }
  if (!after) {
    return "delete";
  }
  return "replace";
}

function finalizeHunks(
  hunks: TranscriptDiffHunk[],
  coarse: boolean,
): TranscriptDiffResult | null {
  const changes = hunks
    .filter((hunk) => hunk.kind === "change")
    .map((hunk) => ({
      after: hunk.after,
      before: hunk.before,
      kind: changeKind(hunk.before, hunk.after),
    }));

  if (changes.length === 0) {
    return null;
  }
  return { changes, coarse, hunks };
}

function buildCoarseDiff(
  beforeWords: readonly string[],
  afterWords: readonly string[],
): TranscriptDiffResult | null {
  let prefix = 0;
  while (
    prefix < beforeWords.length &&
    prefix < afterWords.length &&
    beforeWords[prefix] === afterWords[prefix]
  ) {
    prefix += 1;
  }

  let beforeEnd = beforeWords.length - 1;
  let afterEnd = afterWords.length - 1;
  while (
    beforeEnd >= prefix &&
    afterEnd >= prefix &&
    beforeWords[beforeEnd] === afterWords[afterEnd]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const hunks: TranscriptDiffHunk[] = [];
  if (prefix > 0) {
    const text = collapseWords(beforeWords.slice(0, prefix));
    hunks.push({ after: text, before: text, kind: "equal" });
  }

  const before = collapseWords(beforeWords.slice(prefix, beforeEnd + 1));
  const after = collapseWords(afterWords.slice(prefix, afterEnd + 1));
  if (before || after) {
    hunks.push({ after, before, kind: "change" });
  }

  const suffixBefore = beforeWords.slice(beforeEnd + 1);
  if (suffixBefore.length > 0) {
    const text = collapseWords(suffixBefore);
    hunks.push({ after: text, before: text, kind: "equal" });
  }

  return finalizeHunks(hunks, true);
}

function buildLcsOps(
  beforeWords: readonly string[],
  afterWords: readonly string[],
): DiffOp[] {
  const width = afterWords.length + 1;
  const dp = new Uint16Array((beforeWords.length + 1) * width);

  for (let i = beforeWords.length - 1; i >= 0; i -= 1) {
    for (let j = afterWords.length - 1; j >= 0; j -= 1) {
      const index = i * width + j;
      const beforeWord = beforeWords[i];
      const afterWord = afterWords[j];
      if (beforeWord === undefined || afterWord === undefined) {
        continue;
      }
      if (beforeWord === afterWord) {
        dp[index] = dpValue(dp, (i + 1) * width + j + 1) + 1;
      } else {
        dp[index] = Math.max(
          dpValue(dp, (i + 1) * width + j),
          dpValue(dp, i * width + j + 1),
        );
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeWords.length && j < afterWords.length) {
    const beforeWord = beforeWords[i];
    const afterWord = afterWords[j];
    if (beforeWord === undefined || afterWord === undefined) {
      break;
    }
    if (beforeWord === afterWord) {
      ops.push({ kind: "equal", word: beforeWord });
      i += 1;
      j += 1;
    } else if (
      dpValue(dp, (i + 1) * width + j) >= dpValue(dp, i * width + j + 1)
    ) {
      ops.push({ kind: "delete", word: beforeWord });
      i += 1;
    } else {
      ops.push({ kind: "insert", word: afterWord });
      j += 1;
    }
  }
  while (i < beforeWords.length) {
    const word = beforeWords[i];
    if (word === undefined) {
      break;
    }
    ops.push({ kind: "delete", word });
    i += 1;
  }
  while (j < afterWords.length) {
    const word = afterWords[j];
    if (word === undefined) {
      break;
    }
    ops.push({ kind: "insert", word });
    j += 1;
  }
  return ops;
}

function buildHunksFromOps(ops: readonly DiffOp[]): TranscriptDiffHunk[] {
  const hunks: TranscriptDiffHunk[] = [];
  let equalWords: string[] = [];
  let beforeWords: string[] = [];
  let afterWords: string[] = [];

  const flushEqual = () => {
    if (equalWords.length === 0) {
      return;
    }
    const text = collapseWords(equalWords);
    hunks.push({ after: text, before: text, kind: "equal" });
    equalWords = [];
  };

  const flushChange = () => {
    if (beforeWords.length === 0 && afterWords.length === 0) {
      return;
    }
    hunks.push({
      after: collapseWords(afterWords),
      before: collapseWords(beforeWords),
      kind: "change",
    });
    beforeWords = [];
    afterWords = [];
  };

  for (const op of ops) {
    if (op.kind === "equal") {
      flushChange();
      equalWords.push(op.word);
      continue;
    }
    flushEqual();
    if (op.kind === "delete") {
      beforeWords.push(op.word);
    } else {
      afterWords.push(op.word);
    }
  }
  flushChange();
  flushEqual();

  return hunks;
}

export function buildTranscriptDiff(
  beforeText: string,
  afterText: string,
): TranscriptDiffResult | null {
  if (normalizedWords(beforeText) === normalizedWords(afterText)) {
    return null;
  }

  const beforeWords = tokenizeWords(beforeText);
  const afterWords = tokenizeWords(afterText);
  const lcsCells = (beforeWords.length + 1) * (afterWords.length + 1);
  if (
    beforeWords.length > MAX_LCS_WORDS ||
    afterWords.length > MAX_LCS_WORDS ||
    lcsCells > MAX_LCS_CELLS
  ) {
    return buildCoarseDiff(beforeWords, afterWords);
  }

  return finalizeHunks(
    buildHunksFromOps(buildLcsOps(beforeWords, afterWords)),
    false,
  );
}
