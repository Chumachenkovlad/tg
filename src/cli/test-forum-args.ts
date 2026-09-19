import { CliUsageError, parseBooleanFlags } from "./flags.js";

/** The flags `telegram:create-test-forum` accepts. Nothing else is tolerated. */
export const TEST_FORUM_FLAGS = ["dry-run", "apply", "yes", "help"] as const;

export interface TestForumArgs {
  /** Dry run unless `--apply` was given: the default never mutates. */
  apply: boolean;
  /** `--yes` skips the interactive confirmation, and only that. */
  assumeYes: boolean;
  help: boolean;
}

export function parseTestForumArgs(argv: readonly string[]): TestForumArgs {
  const flags = parseBooleanFlags(argv, TEST_FORUM_FLAGS);

  if (flags.has("dry-run") && flags.has("apply")) {
    throw new CliUsageError("--dry-run and --apply contradict each other; pass only one.");
  }
  if (flags.has("yes") && !flags.has("apply")) {
    throw new CliUsageError("--yes only makes sense together with --apply.");
  }

  return {
    // The default is the safe one: without --apply this is a dry run.
    apply: flags.has("apply"),
    assumeYes: flags.has("yes"),
    help: flags.has("help"),
  };
}
