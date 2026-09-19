/**
 * What the test-forum command intends to do.
 *
 * Kept as data, separate from both the CLI and the Telegram layer, so the
 * dry-run text and the applied run are provably describing the same three
 * steps: `describePlan()` and `createTestForum()` read this one object.
 */
export interface TestForumPlan {
  forumTitle: string;
  topicTitle: string;
  message: string;
}

export const TEST_FORUM_PLAN: TestForumPlan = {
  forumTitle: "TSC 8042 Test",
  topicTitle: "🧪 Тест",
  message: "Тест автоматизації Telegram API",
};

/**
 * The intended actions, in order, as lines for the terminal.
 *
 * Printed by the dry run and — as a preview — by the confirmation prompt
 * before `--apply`, so what is confirmed is exactly what was described.
 */
export function describePlan(plan: TestForumPlan = TEST_FORUM_PLAN): string[] {
  return [
    `1. Create a private supergroup configured as a forum, titled "${plan.forumTitle}".`,
    `2. Create one forum topic titled "${plan.topicTitle}".`,
    `3. Send one message into that topic: "${plan.message}".`,
  ];
}
