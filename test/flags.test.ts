import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CliUsageError, parseBooleanFlags } from "../src/cli/flags.js";

describe("parseBooleanFlags", () => {
  it("accepts the known flags", () => {
    const flags = parseBooleanFlags(["--yes", "--help"], ["yes", "help"]);

    assert.deepEqual([...flags].sort(), ["help", "yes"]);
  });

  it("accepts no arguments at all", () => {
    assert.equal(parseBooleanFlags([], ["yes"]).size, 0);
  });

  it("rejects an unknown flag", () => {
    assert.throws(
      () => parseBooleanFlags(["--wipe-everything"], ["yes"]),
      (error: unknown) => {
        assert.ok(error instanceof CliUsageError);
        assert.match(error.message, /Unknown flag: --wipe-everything/);
        return true;
      },
    );
  });

  it("rejects a typo that would otherwise fall through to the default", () => {
    // `--yse` must not be read as "no --yes, so prompt": on a command that
    // can create things, a typo deserves an error, not a guess.
    assert.throws(() => parseBooleanFlags(["--yse"], ["yes", "help"]), CliUsageError);
  });

  it("rejects a flag the other command accepts", () => {
    // telegram:plan takes no --yes: there is nothing for it to confirm.
    assert.throws(() => parseBooleanFlags(["--yes"], ["help"]), /Unknown flag: --yes/);
  });

  it("rejects a positional argument", () => {
    assert.throws(() => parseBooleanFlags(["yes"], ["yes"]), /Unexpected argument: yes/);
  });

  it("rejects a value attached to a flag", () => {
    assert.throws(() => parseBooleanFlags(["--yes=true"], ["yes"]), /takes no value/);
  });

  it("rejects a repeated flag", () => {
    assert.throws(() => parseBooleanFlags(["--yes", "--yes"], ["yes"]), /Repeated flag/);
  });

  it("rejects a -- separator", () => {
    assert.throws(() => parseBooleanFlags(["--"], ["yes"]), /no positional arguments/);
  });

  it("rejects a short flag", () => {
    assert.throws(() => parseBooleanFlags(["-y"], ["yes"]), /Unexpected argument: -y/);
  });
});
