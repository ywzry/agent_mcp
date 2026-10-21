export interface FileChange {
  path: string;
  before: string | null;
  after: string;
}

const MAX_DIFF_LINES = 5000;

/**
 * One-hunk unified diff. Not the smallest possible patch, but stable and
 * reviewable without pulling a diff dependency into the plugin.
 */
export function unifiedDiff(change: FileChange): string {
  const before = change.before ?? '';
  if (change.before === change.after) return '';
  if (isBinary(before) || isBinary(change.after)) {
    return `diff --git a/${change.path} b/${change.path}\nBinary files differ (${change.before === null ? 'created' : 'modified'}).\n`;
  }
  const oldLines = before.split('\n');
  const newLines = change.after.split('\n');
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES)
    return `diff --git a/${change.path} b/${change.path}\nFile exceeds ${MAX_DIFF_LINES} lines; see the run artifacts for full contents.\n`;
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;
  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = oldLines.length - suffix + 3;
  const newEnd = newLines.length - suffix + 3;
  const removed = oldLines.slice(contextStart, oldEnd);
  const added = newLines.slice(contextStart, newEnd);
  const oldCount = oldEnd - contextStart;
  const newCount = newEnd - contextStart;
  const header = [
    `diff --git a/${change.path} b/${change.path}`,
    change.before === null ? 'new file mode 100644' : `--- a/${change.path}`,
    `+++ b/${change.path}`,
    `@@ -${contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@`,
  ];
  const body: string[] = [];
  for (let i = 0; i < Math.max(removed.length, added.length); i++) {
    const oldLine = removed[i];
    const newLine = added[i];
    if (oldLine === newLine && oldLine !== undefined) body.push(` ${oldLine}`);
    else {
      if (oldLine !== undefined) body.push(`-${oldLine}`);
      if (newLine !== undefined) body.push(`+${newLine}`);
    }
  }
  return `${header.join('\n')}\n${body.join('\n')}\n`;
}

function isBinary(value: string): boolean {
  return value.includes('\u0000');
}
