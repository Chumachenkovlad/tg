import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CliUsageError, parseBooleanFlags } from "../src/cli/flags.js";
import { parseTestForumArgs } from "../src/cli/test-forum-args.js";

describe("parseBooleanFlags", () => {
  it("accepts the known flags", () => {
    const flags = parseBooleanFlags(["--apply", "--yes"], ["dry-run", "apply", "yes"]);

    assert.deepEqual([...flags].sort(), ["apply", "yes"]);
  });

  it("accepts no arguments at all", () => {
    assert.equal(parseBooleanFlags([], ["apply"]).size, 0);
  });

  it("rejects an unknown flag", () => {
    assert.throws(
      () => parseBooleanFlags(["--wipe-everything"], ["apply"]),
      (error: unknown) => {
        assert.ok(error instanceof CliUsageError);
        assert.match(error.message, /Unknown flag: --wipe-everything/);
        return true;
      },
    );
  });

  it("rejects a typo that would otherwise fall through to the default", () => {
    // `--aply` must not be read as "no --apply, so dry run": it is a mistake,
    // and a mistake on this command deserves an error, not a guess.
    assert.throws(() => parseTestForumArgs(["--aply"]), CliUsageError);
  });

  it("rejects a positional argument", () => {
    assert.throws(() => parseBooleanFlags(["apply"], ["apply"]), /Unexpected argument: apply/);
  });

  it("rejects a value attached to a flag", () => {
    assert.throws(() => parseBooleanFlags(["--apply=true"], ["apply"]), /takes no value/);
  });

  it("rejects a repeated flag", () => {
    assert.throws(() => parseBooleanFlags(["--apply", "--apply"], ["apply"]), /Repeated flag/);
  });

  it("rejects a -- separator", () => {
    assert.throws(() => parseBooleanFlags(["--"], ["apply"]), /no positional arguments/);
  });

  it("rejects a short flag", () => {
    assert.throws(() => parseBooleanFlags(["-y"], ["yes"]), /Unexpected argument: -y/);
  });
});

describe("parseTestForumArgs", () => {
  it("defaults to a dry run when nothing is passed", () => {
    const args = parseTestForumArgs([]);

    assert.equal(args.apply, false, "the default must never mutate");
    assert.equal(args.assumeYes, false);
  });

  it("treats an explicit --dry-run the same as the default", () => {
    assert.deepEqual(parseTestForumArgs(["--dry-run"]), parseTestForumArgs([]));
  });

  it("enables mutation only for --apply", () => {
    assert.equal(parseTestForumArgs(["--apply"]).apply, true);
  });

  it("accepts --yes alongside --apply", () => {
    const args = parseTestForumArgs(["--apply", "--yes"]);

    assert.equal(args.apply, true);
    assert.equal(args.assumeYes, true);
  });

  it("rejects --yes on its own, so it can never imply --apply", () => {
    assert.throws(() => parseTestForumArgs(["--yes"]), /only makes sense together with --apply/);
  });

  it("rejects --dry-run and --apply together instead of picking one", () => {
    assert.throws(() => parseTestForumArgs(["--dry-run", "--apply"]), /contradict/);
  });
});
