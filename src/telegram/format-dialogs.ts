import type { DialogSummary } from "./forum-types.js";

/**
 * Renders the inspection output.
 *
 * Only the four safe fields of {@link DialogSummary} reach the terminal —
 * there is nothing else in the shape to print, which is the point: access
 * hashes never travel this far.
 */
export function formatDialogs(dialogs: readonly DialogSummary[]): string[] {
  if (dialogs.length === 0) {
    return ["No groups, supergroups, forums or channels in the chat list."];
  }

  const lines = [`${dialogs.length} group/channel dialog(s):`];
  for (const dialog of dialogs) {
    lines.push("");
    lines.push(`  title:    ${dialog.title}`);
    lines.push(`  id:       ${dialog.id}`);
    lines.push(`  type:     ${dialog.kind}`);
    lines.push(`  username: ${dialog.username ? `@${dialog.username}` : "— (private)"}`);
  }
  return lines;
}
