import type { ForumApi } from "./forum-types.js";
import { TEST_FORUM_PLAN, type TestForumPlan } from "./test-forum-plan.js";

/**
 * Creating the test forum: three calls, in order, once each.
 *
 * Deliberately linear and retry-free. Every step depends on the previous one,
 * so a failure simply propagates and the steps after it never run — there is
 * no catch that could carry on and leave a half-built group behind, and no
 * loop that could create a second group or a second topic.
 *
 * It takes a {@link ForumApi} rather than a client, so the tests drive it with
 * a recording fake and never open a connection.
 */

/** Identifiers of what was created. All of it is safe to print. */
export interface TestForumResult {
  forumId: string;
  forumTitle: string;
  topicId: number;
  topicTitle: string;
  messageId: number;
}

export interface CreateTestForumOptions {
  plan?: TestForumPlan;
  /** Progress reporting; defaults to silence. */
  onStep?: (message: string) => void;
}

export async function createTestForum(
  api: ForumApi,
  options: CreateTestForumOptions = {},
): Promise<TestForumResult> {
  const plan = options.plan ?? TEST_FORUM_PLAN;
  const step = options.onStep ?? (() => {});

  step(`Creating forum supergroup "${plan.forumTitle}"...`);
  const forum = await api.createForumSupergroup(plan.forumTitle);

  step(`Creating topic "${plan.topicTitle}"...`);
  const topic = await api.createForumTopic(forum.ref, plan.topicTitle);

  step("Sending the test message into the topic...");
  const message = await api.sendMessageToTopic(forum.ref, topic.id, plan.message);

  return {
    forumId: forum.id,
    forumTitle: forum.title,
    topicId: topic.id,
    topicTitle: topic.title,
    messageId: message.id,
  };
}
