// Spawns run-all (the library through a fixture, or the bin) as a real process: signals,
// process groups and exit codes cannot be tested in the test runner's own process.

import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ChildSpec, RunAllOptions, RunAllResult } from "../src/run-all.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/run.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

/** A child that runs `code` with `node -e`. */
export function node(...code: string[]): string[] {
	return [process.execPath, "-e", code.join("\n")];
}

// Snippets for `node()`. Output followed by an exit goes through a write callback: a pipe
// is asynchronous on macOS, and the exit would drop it.
/** Goes after the handlers: a test signals the child as soon as it reads this line. */
export const READY = `console.log("ready " + process.pid);`;
export const KEEP = "setInterval(() => {}, 1000);";
export const REPORT = `for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => process.stdout.write("got " + s + "\\n", () => process.exit(0)));`;
export const IGNORE = `for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => console.log("ignored " + s));`;
/** Leaves a process outside the child's group holding its pipes, for 10 s. */
export const HOLD_PIPES = `require("node:child_process").spawn(process.execPath, ["-e", "console.log('detached ' + process.pid); setTimeout(() => {}, 10000)"], { detached: true, stdio: "inherit" }).unref();`;
export const exitOnUsr2 = (code: number): string =>
	`process.on("SIGUSR2", () => process.exit(${code}));`;

/** Every pid a `ready <pid>` or `detached <pid>` line announced; `cleanup()` kills them. */
const announced = new Set<number>();

/** SIGKILLs the group of every announced child still around (for `afterEach`). */
export function cleanup(): void {
	for (const pid of announced) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// gone
		}
	}
	announced.clear();
}

export interface SessionOptions {
	env?: Record<string, string | undefined>;
}

export interface Done {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string[];
	stderr: string[];
	/** What the fixture reported; only for `runFixture`. */
	result?: RunAllResult;
}

/** A running run-all process. */
export class Session {
	readonly proc: ChildProcess;
	readonly stdout: string[] = [];
	readonly stderr: string[] = [];
	readonly done: Promise<Done>;
	#waiters = new Set<() => boolean>();
	#closed = false;

	constructor(args: string[], { env = {} }: SessionOptions = {}) {
		this.proc = spawn(process.execPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			// Colour detection must see a clean slate unless a test sets it up.
			env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined, ...env },
		});
		this.#collect("stdout", this.stdout);
		this.#collect("stderr", this.stderr);
		this.done = new Promise((resolve) => {
			this.proc.on("close", (code, signal) => {
				this.#closed = true;
				for (const waiter of this.#waiters) waiter();
				const line = this.stderr.find((l) => l.startsWith("RESULT "));
				const result = line ? JSON.parse(line.slice(7)) : undefined;
				resolve({
					code,
					signal,
					stdout: this.stdout,
					stderr: this.stderr,
					result,
				});
			});
		});
	}

	#collect(name: "stdout" | "stderr", into: string[]): void {
		let buffer = "";
		this.proc[name]?.setEncoding("utf8").on("data", (chunk: string) => {
			const parts = (buffer + chunk).split("\n");
			buffer = parts.pop() ?? "";
			into.push(...parts);
			for (const line of parts) {
				const pid = line.match(/\b(?:ready|detached) (\d+)$/)?.[1];
				if (pid) announced.add(Number(pid));
			}
			for (const waiter of this.#waiters) waiter();
		});
	}

	/** Resolves with the matches once `count` stdout lines match; rejects if it closes first. */
	waitFor(pattern: RegExp, count = 1): Promise<RegExpMatchArray[]> {
		return new Promise((resolve, reject) => {
			const check = (): boolean => {
				const found = this.stdout
					.map((line) => line.match(pattern))
					.filter((m): m is RegExpMatchArray => m !== null);
				if (found.length >= count) {
					resolve(found.slice(0, count));
				} else if (this.#closed) {
					const output = [...this.stdout, ...this.stderr].join("\n");
					reject(new Error(`closed before ${count}x ${pattern}:\n${output}`));
				} else {
					return false;
				}
				this.#waiters.delete(check);
				return true;
			};
			if (!check()) this.#waiters.add(check);
		});
	}

	/** Pids from `ready <pid>` lines, by child name, once all of `names` are ready. */
	async ready(...names: string[]): Promise<Record<string, number>> {
		const matches = await this.waitFor(/^\[(\S+)\s*\] │ ready (\d+)$/, names.length);
		return Object.fromEntries(matches.map((m) => [m[1], Number(m[2])]));
	}

	kill(signal: NodeJS.Signals): void {
		this.proc.kill(signal);
	}
}

/** Runs `runAll(children, options)` in a fresh process. */
export function runFixture(
	children: ChildSpec[],
	options?: RunAllOptions,
	session?: SessionOptions,
): Session {
	return new Session([FIXTURE, JSON.stringify({ children, options })], session);
}

/** Runs the `run-all` bin from source. */
export function runBin(args: string[], session?: SessionOptions): Session {
	return new Session([BIN, ...args], session);
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** True once `pid` is gone, false if it still runs after `ms`. */
export async function gone(pid: number, ms = 2000): Promise<boolean> {
	const until = Date.now() + ms;
	while (isAlive(pid)) {
		if (Date.now() > until) return false;
		await sleep(20);
	}
	return true;
}
