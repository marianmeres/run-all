/**
 * The `run-all` command: `run-all [options] name=command...`, each command run by
 * `/bin/sh -c`. The parsing is exported for the tests; `main` is what `bin.ts` runs.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { type ChildSpec, type RunAllOptions, runAll } from "./run-all.ts";

export const USAGE = `Usage: run-all [options] <name=command>...

Runs the commands side by side, every output line behind the name of the command that
wrote it, and stops all of them as soon as one ends.

Each argument is name=command. The name tags the output; the command runs through
/bin/sh -c, so 'api=cd server && node main.ts' and 'web=PORT=3000 pnpm dev' work.

Options:
  --exit-with <name>    the result is this command's exit code, 0 included; any other
                        command ending first is a failure
  --kill-timeout <ms>   SIGKILL whatever still runs this long after the stop signal
                        (default 5000; Infinity never does)
  -h, --help            show this help
  -v, --version         show the version

Ctrl-C stops everything; a second Ctrl-C kills what is still running.

Exit code: the --exit-with command's code; else the code of the command that ended
first (1 if it was 0); 128 + n when stopped by signal n; 2 on a usage error.

Example:
  run-all 'web=pnpm run dev' 'api=cd server && node --watch main.ts'
`;

/** What the arguments ask for. */
export type Command =
	| { kind: "run"; children: ChildSpec[]; options: RunAllOptions }
	| { kind: "help" }
	| { kind: "version" };

/** Parses the arguments (without the node and script paths); throws on a usage error. */
export function parseCli(argv: readonly string[]): Command {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		throw new Error(`run-all: ${(error as Error).message}`);
	}
	const { values, positionals } = parsed;
	if (values.help) return { kind: "help" };
	if (values.version) return { kind: "version" };
	if (positionals.length === 0) throw new Error("run-all: nothing to run");

	const children = positionals.map((arg) => {
		const at = arg.indexOf("=");
		if (at < 1) {
			throw new Error(`run-all: expected name=command, got ${JSON.stringify(arg)}`);
		}
		return { name: arg.slice(0, at), cmd: arg.slice(at + 1) };
	});
	const options: RunAllOptions = {};
	const exitWith = values["exit-with"];
	if (exitWith !== undefined) {
		if (!children.some((child) => child.name === exitWith)) {
			throw new Error(`run-all: --exit-with "${exitWith}" names no command`);
		}
		options.exitWith = exitWith;
	}
	if (values["kill-timeout"] !== undefined) {
		const ms = Number(values["kill-timeout"]);
		if (values["kill-timeout"].trim() === "" || !(ms >= 0)) {
			throw new Error(
				"run-all: --kill-timeout must be a number of milliseconds >= 0, or Infinity",
			);
		}
		options.killTimeout = ms;
	}
	return { kind: "run", children, options };
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			"exit-with": { type: "string" },
			"kill-timeout": { type: "string" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
}

/** Runs the command line. Sets `process.exitCode`; never calls `process.exit` itself. */
export async function main(
	argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
	try {
		const command = parseCli(argv);
		if (command.kind === "help") {
			process.stdout.write(USAGE);
		} else if (command.kind === "version") {
			process.stdout.write(`${version()}\n`);
		} else {
			await runAll(command.children, command.options);
		}
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\nTry 'run-all --help'.\n`);
		process.exitCode = 2;
	}
}

/** Read at run time: `../package.json` is the manifest from `src/` and from `dist/`. */
function version(): string {
	const url = new URL("../package.json", import.meta.url);
	return JSON.parse(readFileSync(url, "utf8")).version;
}
