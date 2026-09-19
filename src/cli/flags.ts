/**
 * A deliberately small, strict flag parser.
 *
 * Node's `parseArgs` tolerates a lot; here anything unrecognised is an error.
 * For a command that can create things on a real account, a typo such as
 * `--aply` must not silently fall through to the default behaviour.
 */

/** Raised for anything the command does not understand. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/**
 * Parses boolean flags.
 *
 * Accepts only the exact long forms listed in `allowed`. Rejects unknown
 * flags, repeated flags, `--flag=value`, short flags and bare positional
 * arguments. Everything after a `--` separator is rejected too: these
 * commands take no operands, so anything there is a mistake.
 */
export function parseBooleanFlags(argv: readonly string[], allowed: readonly string[]): Set<string> {
  const known = new Set(allowed);
  const seen = new Set<string>();

  for (const arg of argv) {
    if (arg === "--") {
      throw new CliUsageError("This command takes no positional arguments.");
    }
    if (!arg.startsWith("--")) {
      throw new CliUsageError(
        `Unexpected argument: ${arg}. Known flags: ${allowed.join(", ")}.`,
      );
    }

    const name = arg.slice(2);
    if (name.includes("=")) {
      throw new CliUsageError(`${arg} takes no value. Known flags: ${allowed.join(", ")}.`);
    }
    if (!known.has(name)) {
      throw new CliUsageError(`Unknown flag: ${arg}. Known flags: ${allowed.join(", ")}.`);
    }
    if (seen.has(name)) {
      throw new CliUsageError(`Repeated flag: ${arg}.`);
    }
    seen.add(name);
  }

  return seen;
}
