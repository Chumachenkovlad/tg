import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileSessionStore } from "../src/telegram/session-store.js";

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("FileSessionStore", () => {
  let root: string;
  let sessionPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tg-session-"));
    sessionPath = join(root, ".telegram", "session");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty string when no session is stored", () => {
    assert.equal(new FileSessionStore(sessionPath).load(), "");
  });

  it("creates the session file with 0600 and the directory with 0700", () => {
    const store = new FileSessionStore(sessionPath);
    store.save("SESSION_VALUE");

    assert.equal(mode(sessionPath), 0o600);
    assert.equal(mode(dirname(sessionPath)), 0o700);
    assert.equal(store.load(), "SESSION_VALUE");
  });

  it("tightens an existing permissive session file and directory on save", () => {
    mkdirSync(dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, "OLD_VALUE\n");
    chmodSync(sessionPath, 0o644);
    chmodSync(dirname(sessionPath), 0o755);

    new FileSessionStore(sessionPath).save("NEW_VALUE");

    assert.equal(mode(sessionPath), 0o600);
    assert.equal(mode(dirname(sessionPath)), 0o700);
  });

  it("tightens an existing permissive session file on load", () => {
    mkdirSync(dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, "STORED_VALUE\n");
    chmodSync(sessionPath, 0o666);
    chmodSync(dirname(sessionPath), 0o777);

    const loaded = new FileSessionStore(sessionPath).load();

    assert.equal(loaded, "STORED_VALUE");
    assert.equal(mode(sessionPath), 0o600);
    assert.equal(mode(dirname(sessionPath)), 0o700);
  });

  it("keeps permissions tight across repeated saves", () => {
    const store = new FileSessionStore(sessionPath);
    store.save("FIRST");
    chmodSync(sessionPath, 0o664);
    store.save("SECOND");

    assert.equal(mode(sessionPath), 0o600);
    assert.equal(store.load(), "SECOND");
  });

  it("describes the location relative to the working directory", () => {
    const store = new FileSessionStore(join(process.cwd(), ".telegram", "session"));
    assert.equal(store.describe(), ".telegram/session");
  });
});
