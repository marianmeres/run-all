/**
 * Runs several processes side by side as one: every line they write is relayed behind the
 * tag of the process that wrote it, and all of them stop as soon as one ends.
 *
 * Each mechanism below exists for a reason that is easy to undo by accident; the reasons
 * are in docs/process-model.md, in the repository. POSIX only: it leans on process groups.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { constants } from "node:os";
import { resolve as resolvePath } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

/** The tag colours, given in this order to the children that do not name one. */
export const COLORS = ["cyan", "magenta", "yellow", "green", "blue", "red"] as const;

/** A tag colour. */
export type Color = (typeof COLORS)[number];

/** The signals run-all reacts to, and forwards. */
export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** One process to run. */
export interface ChildSpec {
	/** The tag in front of every line it writes. Unique, non-empty, no whitespace. */
	name: string;
	/**
	 * An argv array, spawned as it is, or a command line, run by `/bin/sh -c` (so
	 * `cd dir && ...` and `VAR=1 ...` work).
	 */
	cmd: string | readonly string[];
	/** Its working directory, resolved against `RunAllOptions.cwd`. */
	cwd?: string | URL;
	/** Merged over the inherited environment; an `undefined` value removes a variable. */
	env?: Record<string, string | undefined>;
	/** Its tag colour. Default: the next one in `COLORS`, by position. */
	color?: Color;
}

/** How the run behaves as a whole. */
export interface RunAllOptions {
	/** The working directory every child's `cwd` is resolved against. Default: `process.cwd()`. */
	cwd?: string | URL;
	/**
	 * The name of the child whose exit is the result: when it ends, run-all stops the rest
	 * and exits with its code, 0 included. Any other child ending first is a failure.
	 * Without it, every child is expected to run until stopped, so any child ending is a
	 * failure (a 0 is reported as 1).
	 */
	exitWith?: string;
	/**
	 * Milliseconds between the stop signal and `SIGKILL` for whatever still runs.
	 * `Infinity` never escalates. Default: 5000.
	 */
	killTimeout?: number;
	/**
	 * Colour the tags, and set `FORCE_COLOR=1` for the children, whose output is a pipe.
	 * Default: on when `FORCE_COLOR` is set (and not `0` or `false`), off when `NO_COLOR` is,
	 * otherwise on when stdout is a terminal.
	 */
	colors?: boolean;
}

/** How the run ended. `runAll` also sets `process.exitCode` to `code`. */
export interface RunAllResult {
	/** The exit code: see "How it stops" in the README. */
	code: number;
	/** The child that ended first, or `null` when a signal stopped the run. */
	endedFirst: string | null;
	/** The signal that stopped the run, or `null` when a child ended first. */
	signal: StopSignal | null;
}

const DEFAULT_KILL_TIMEOUT = 5000;
/** setTimeout fires at once for anything longer; such a timeout means never. */
const MAX_TIMEOUT = 2 ** 31 - 1;
/** How long a child's pipes may stay open after it exited before they are closed for it. */
const DRAIN_GRACE = 1000;
const SIGNALS: readonly StopSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const ANSI: Record<Color, string> = {
	cyan: "\x1b[36m",
	magenta: "\x1b[35m",
	yellow: "\x1b[33m",
	green: "\x1b[32m",
	blue: "\x1b[34m",
	red: "\x1b[31m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/**
 * Runs `children` side by side until the first one ends, then stops the rest.
 *
 * Every line a child writes goes to the same stream of this process (stdout or stderr)
 * behind the child's tag. Each child leads a process group of its own, and every signal
 * goes to the whole group, so grandchildren stop with it. `SIGINT`, `SIGTERM` and `SIGHUP`
 * received by this process are forwarded to every group; a second one kills what still
 * runs and exits at once.
 *
 * Resolves when every child has ended and its output is relayed, after setting
 * `process.exitCode`. It never calls `process.exit` on that path, so the process exits
 * by itself with all output written. Rejects, before starting anything, on invalid input
 * or on Windows.
 *
 * @example
 * ```ts
 * await runAll([
 * 	{ name: "web", cmd: ["pnpm", "run", "dev"] },
 * 	{ name: "api", cmd: "cd server && node --watch main.ts" },
 * ]);
 * ```
 */
export async function runAll(
	children: readonly ChildSpec[],
	options: RunAllOptions = {},
): Promise<RunAllResult> {
	if (process.platform === "win32") {
		throw new Error("run-all: needs POSIX process groups; Windows is not supported");
	}
	const base = toPath(options.cwd ?? process.cwd());
	const cwds = validate(children, options, base);
	const killTimeout = options.killTimeout ?? DEFAULT_KILL_TIMEOUT;
	const colors = options.colors ?? autoColors();
	const width = Math.max(...children.map((child) => child.name.length));
	const out = writer(process.stdout);
	const err = writer(process.stderr);

	return new Promise((resolve) => {
		const groups: { pid: number | undefined; closed: boolean; tag: string }[] = [];
		let result: RunAllResult = { code: 0, endedFirst: null, signal: null };
		let stopping = false;
		let open = children.length;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const stop = (signal: NodeJS.Signals): void => {
			stopping = true;
			for (const group of groups) kill(group.pid, signal);
			if (killTimeout > MAX_TIMEOUT) return;
			killTimer = setTimeout(() => {
				for (const group of groups) {
					if (group.closed) continue;
					process.stderr.write(
						`${group.tag}still running after ${killTimeout} ms; sending SIGKILL\n`,
					);
					kill(group.pid, "SIGKILL");
				}
			}, killTimeout);
		};

		const onSignal = (signal: StopSignal): void => {
			if (!stopping) {
				result = {
					code: 128 + constants.signals[signal],
					endedFirst: null,
					signal,
				};
				stop(signal);
				return;
			}
			// The second one: the user will not wait for the rest to drain.
			for (const group of groups) kill(group.pid, "SIGKILL");
			process.exit(result.code);
		};
		const listeners = SIGNALS.map(
			(signal) => [signal, () => onSignal(signal)] as const,
		);

		// An exit nobody planned (a throw in the caller) still takes the children down.
		const onExit = (): void => {
			for (const group of groups) if (!group.closed) kill(group.pid, "SIGTERM");
		};

		const finish = (): void => {
			clearTimeout(killTimer);
			for (const [signal, listener] of listeners) process.off(signal, listener);
			process.off("exit", onExit);
			process.exitCode = result.code;
			resolve(result);
		};

		for (const [signal, listener] of listeners) process.on(signal, listener);
		process.on("exit", onExit);

		children.forEach((child, i) => {
			const name = child.name.padEnd(width);
			const color = ANSI[child.color ?? COLORS[i % COLORS.length] ?? "cyan"];
			const tag = colors
				? `${color}[${name}]${RESET} ${DIM}│${RESET} `
				: `[${name}] │ `;
			const spawnOptions = {
				cwd: cwds[i],
				env: {
					...(colors && { FORCE_COLOR: "1" }),
					...process.env,
					...child.env,
				},
				stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
				detached: true,
			};
			const proc =
				typeof child.cmd === "string"
					? spawn(child.cmd, { ...spawnOptions, shell: true })
					: spawn(child.cmd[0] ?? "", child.cmd.slice(1), spawnOptions);
			const group = { pid: proc.pid, closed: false, tag };
			groups.push(group);
			relay(proc.stdout, out, tag);
			relay(proc.stderr, err, tag);

			const end = (reason: string, code: number): void => {
				if (group.closed) return;
				group.closed = true;
				open--;
				if (!stopping) {
					const rest = open > 0 ? "; stopping the rest" : "";
					process.stderr.write(`${tag}${reason}${rest}\n`);
					const decides = child.name === options.exitWith;
					result = {
						code: decides ? code : code || 1,
						endedFirst: child.name,
						signal: null,
					};
					stop("SIGTERM");
				}
				if (open === 0) finish();
			};
			proc.on("error", (error) => end(`failed to start: ${error.message}`, 1));
			// A grandchild that left the group can hold the pipes open past the child's
			// exit, and `close` would never come.
			proc.on("exit", () => {
				setTimeout(() => {
					proc.stdout.destroy();
					proc.stderr.destroy();
				}, DRAIN_GRACE).unref();
			});
			// `close`, not `exit`: it waits for the pipes, so the child's last lines come
			// before the line saying it ended.
			proc.on("close", (code, signal) => {
				const signo = signal ? constants.signals[signal] : 0;
				end(`exited with ${code ?? signal}`, code ?? 128 + signo);
			});
		});
	});
}

/** Rejects what cannot run; returns each child's resolved working directory. */
function validate(
	children: readonly ChildSpec[],
	options: RunAllOptions,
	base: string,
): string[] {
	if (!Array.isArray(children) || children.length === 0) {
		throw new Error("run-all: nothing to run");
	}
	const names = new Set<string>();
	const cwds = children.map((child) => {
		const { name, cmd, color } = child;
		if (typeof name !== "string" || !/^\S+$/.test(name)) {
			throw new Error(
				`run-all: invalid name ${JSON.stringify(name)}: non-empty, no whitespace`,
			);
		}
		if (names.has(name)) throw new Error(`run-all: duplicate name "${name}"`);
		names.add(name);
		const valid =
			typeof cmd === "string"
				? cmd.trim() !== ""
				: Array.isArray(cmd) &&
					!!cmd[0] &&
					cmd.every((arg) => typeof arg === "string");
		if (!valid) throw new Error(`run-all: "${name}" has no command`);
		if (color !== undefined && !COLORS.includes(color)) {
			throw new Error(`run-all: "${name}" has an unknown color "${color}"`);
		}
		const cwd = child.cwd === undefined ? base : resolvePath(base, toPath(child.cwd));
		// spawn reports a missing cwd as the command not found, which misleads.
		if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
			throw new Error(`run-all: "${name}" has no directory ${cwd}`);
		}
		return cwd;
	});
	if (options.exitWith !== undefined && !names.has(options.exitWith)) {
		throw new Error(`run-all: exitWith "${options.exitWith}" names no child`);
	}
	const { killTimeout } = options;
	if (
		killTimeout !== undefined &&
		!(typeof killTimeout === "number" && killTimeout >= 0)
	) {
		throw new Error(
			"run-all: killTimeout must be a number of milliseconds >= 0, or Infinity",
		);
	}
	return cwds;
}

function toPath(path: string | URL): string {
	return path instanceof URL ? fileURLToPath(path) : path;
}

/** The colour default: `FORCE_COLOR`, then `NO_COLOR` (https://no-color.org), then a TTY. */
function autoColors(): boolean {
	const force = process.env.FORCE_COLOR;
	if (force !== undefined) return force !== "0" && force !== "false";
	if (process.env.NO_COLOR) return false;
	return process.stdout.isTTY === true;
}

/** Signals a child's whole process group; one already gone is not an error. */
function kill(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		// already gone
	}
}

type Write = (from: Readable, text: string) => void;

/**
 * Writes into one destination for every stream relayed into it, pausing a source while
 * the destination's buffer is full, so a fast child cannot grow it without bound.
 */
function writer(to: Writable): Write {
	const paused = new Set<Readable>();
	return (from, text) => {
		if (to.write(text) || paused.has(from)) return;
		if (paused.size === 0) {
			to.once("drain", () => {
				for (const stream of paused) stream.resume();
				paused.clear();
			});
		}
		paused.add(from);
		from.pause();
	};
}

/** Copies a stream line by line, each line behind the tag. */
function relay(from: Readable, write: Write, tag: string): void {
	createInterface({ input: from, crlfDelay: Infinity }).on("line", (line) => {
		write(from, `${tag}${line}\n`);
	});
}
