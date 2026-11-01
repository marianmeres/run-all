import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";
import { runAll } from "../src/run-all.ts";
import {
	cleanup,
	exitOnUsr2,
	gone,
	HOLD_PIPES,
	IGNORE,
	KEEP,
	node,
	READY,
	REPORT,
	runFixture,
} from "./helpers.ts";

afterEach(cleanup);

const ESC = "\x1b[";

test("rejects invalid input before starting anything", async () => {
	const listeners = process.listenerCount("SIGINT");
	const ok = { name: "a", cmd: "true" };
	const cases: [Parameters<typeof runAll>, RegExp][] = [
		[[[]], /nothing to run/],
		[[[{ name: "", cmd: "true" }]], /invalid name ""/],
		[[[{ name: "a b", cmd: "true" }]], /invalid name "a b"/],
		[[[ok, { name: "a", cmd: "true" }]], /duplicate name "a"/],
		[[[{ name: "a", cmd: "  " }]], /"a" has no command/],
		[[[{ name: "a", cmd: [] }]], /"a" has no command/],
		// @ts-expect-error: not a colour
		[[[{ name: "a", cmd: "true", color: "pink" }]], /unknown color "pink"/],
		[[[ok], { exitWith: "b" }], /exitWith "b" names no child/],
		[[[ok], { killTimeout: -1 }], /killTimeout/],
		[[[ok], { killTimeout: Number.NaN }], /killTimeout/],
		[[[ok], { cwd: new URL("file:///run-all/no/such/dir/") }], /has no directory/],
		[[[{ ...ok, cwd: "no-such-subdir" }]], /"a" has no directory/],
	];
	for (const [args, message] of cases) {
		await assert.rejects(runAll(...args), message);
	}
	assert.equal(process.listenerCount("SIGINT"), listeners);
});

test("relays every line behind an aligned tag, to the stream it was written to", async () => {
	const run = runFixture(
		[
			{
				name: "short",
				cmd: node(
					`process.stdout.write("out line\\n");`,
					`process.stderr.write("err line\\n");`,
					`process.stdout.write("no newline");`,
				),
			},
			{ name: "long-name", cmd: node(KEEP) },
		],
		{ exitWith: "short" },
	);
	const { code, stdout, stderr, result } = await run.done;
	assert.equal(code, 0);
	assert.deepEqual(result, { code: 0, endedFirst: "short", signal: null });
	assert.ok(stdout.includes("[short    ] │ out line"), stdout.join("\n"));
	assert.ok(stdout.includes("[short    ] │ no newline"), stdout.join("\n"));
	const err = stderr.indexOf("[short    ] │ err line");
	const ended = stderr.indexOf("[short    ] │ exited with 0; stopping the rest");
	assert.ok(err >= 0 && ended > err, stderr.join("\n"));
});

test("the line saying a child ended comes after everything written into its pipes", async () => {
	// The child exits at once; its grandchild, same group, writes 200 ms later.
	const child = node(
		`require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => console.error('late'), 200)"], { stdio: "inherit" }).unref();`,
	);
	const run = runFixture(
		[
			{ name: "a", cmd: child },
			{ name: "b", cmd: node(KEEP) },
		],
		{ exitWith: "a" },
	);
	const { stderr } = await run.done;
	const late = stderr.indexOf("[a] │ late");
	const ended = stderr.indexOf("[a] │ exited with 0; stopping the rest");
	assert.ok(late >= 0 && ended > late, stderr.join("\n"));
});

test("a child that ends on its own stops the rest, and its code is the result", async () => {
	const run = runFixture([
		{ name: "a", cmd: node(exitOnUsr2(3), READY, KEEP) },
		{ name: "b", cmd: node(REPORT, READY, KEEP) },
	]);
	const pids = await run.ready("a", "b");
	process.kill(pids.a as number, "SIGUSR2");
	const { code, stdout, stderr, result } = await run.done;
	assert.equal(code, 3);
	assert.deepEqual(result, { code: 3, endedFirst: "a", signal: null });
	assert.ok(
		stderr.includes("[a] │ exited with 3; stopping the rest"),
		stderr.join("\n"),
	);
	assert.ok(stdout.includes("[b] │ got SIGTERM"), stdout.join("\n"));
});

test("without exitWith, a child that exits 0 is a failure", async () => {
	const run = runFixture([
		{ name: "once", cmd: node("setTimeout(() => {}, 50);") },
		{ name: "long", cmd: node(KEEP) },
	]);
	const { code, result } = await run.done;
	assert.equal(code, 1);
	assert.equal(result?.endedFirst, "once");
});

test("exitWith: the child's own code is the result, 0 included", async () => {
	for (const exit of [0, 4]) {
		const run = runFixture(
			[
				{ name: "server", cmd: node(KEEP) },
				{
					name: "test",
					cmd: node(`setTimeout(() => process.exit(${exit}), 50);`),
				},
			],
			{ exitWith: "test" },
		);
		const { code, result } = await run.done;
		assert.equal(code, exit);
		assert.deepEqual(result, { code: exit, endedFirst: "test", signal: null });
	}
});

test("exitWith: another child that ends first is a failure, even with 0", async () => {
	const run = runFixture(
		[
			{ name: "server", cmd: node("setTimeout(() => {}, 50);") },
			{ name: "test", cmd: node(KEEP) },
		],
		{ exitWith: "test" },
	);
	const { code, result } = await run.done;
	assert.equal(code, 1);
	assert.equal(result?.endedFirst, "server");
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	test(`${signal} is forwarded to every child, and the exit code is 128 + n`, async () => {
		const run = runFixture([
			{ name: "a", cmd: node(REPORT, READY, KEEP) },
			{ name: "b", cmd: node(REPORT, READY, KEEP) },
		]);
		await run.ready("a", "b");
		run.kill(signal);
		const { code, stdout, result } = await run.done;
		const expected = 128 + constants.signals[signal];
		assert.equal(code, expected);
		assert.deepEqual(result, { code: expected, endedFirst: null, signal });
		assert.ok(stdout.includes(`[a] │ got ${signal}`), stdout.join("\n"));
		assert.ok(stdout.includes(`[b] │ got ${signal}`), stdout.join("\n"));
	});
}

test("the signal goes to the whole group: a grandchild stops though nobody forwards it", async () => {
	const parent = node(
		`const { spawn } = require("node:child_process");`,
		`spawn(process.execPath, ["-e", "console.log('grandchild ' + process.pid); setInterval(() => {}, 1000)"], { stdio: "inherit" });`,
		// Exits without passing the signal on.
		`process.on("SIGTERM", () => process.exit(0));`,
		KEEP,
	);
	const run = runFixture([
		{ name: "parent", cmd: parent },
		{ name: "trigger", cmd: node(exitOnUsr2(1), READY, KEEP) },
	]);
	const [grandchild] = await run.waitFor(/grandchild (\d+)$/);
	const pids = await run.ready("trigger");
	process.kill(pids.trigger as number, "SIGUSR2");
	await run.done;
	assert.ok(await gone(Number(grandchild?.[1])), "the grandchild survived");
});

test("killTimeout: SIGKILL for a child that ignores the stop signal", async () => {
	const run = runFixture(
		[
			{ name: "stubborn", cmd: node(IGNORE, READY, KEEP) },
			{ name: "trigger", cmd: node(exitOnUsr2(3), READY, KEEP) },
		],
		{ killTimeout: 300 },
	);
	const pids = await run.ready("stubborn", "trigger");
	const t0 = Date.now();
	process.kill(pids.trigger as number, "SIGUSR2");
	const { code, stdout, stderr } = await run.done;
	assert.ok(Date.now() - t0 >= 290, `stopped after ${Date.now() - t0} ms`);
	assert.equal(code, 3);
	assert.ok(stdout.includes("[stubborn] │ ignored SIGTERM"), stdout.join("\n"));
	assert.ok(
		stderr.includes("[stubborn] │ still running after 300 ms; sending SIGKILL"),
		stderr.join("\n"),
	);
	assert.ok(await gone(pids.stubborn as number));
});

test("a second signal kills what still runs and exits at once", async () => {
	// The held pipes would keep a waiting run-all alive for the drain grace (1 s).
	const run = runFixture(
		[{ name: "stubborn", cmd: node(HOLD_PIPES, IGNORE, READY, KEEP) }],
		{
			killTimeout: 60_000,
		},
	);
	const pids = await run.ready("stubborn");
	await run.waitFor(/detached \d+$/);
	run.kill("SIGINT");
	await run.waitFor(/ignored SIGINT$/);
	const t0 = Date.now();
	run.kill("SIGINT");
	const { code } = await run.done;
	assert.ok(Date.now() - t0 < 700, `exited after ${Date.now() - t0} ms`);
	assert.equal(code, 130);
	assert.ok(await gone(pids.stubborn as number));
});

test("a child that cannot start stops the rest", async () => {
	const run = runFixture([
		{ name: "missing", cmd: ["run-all-test-no-such-command"] },
		{ name: "other", cmd: node(KEEP) },
	]);
	const { code, stderr } = await run.done;
	assert.equal(code, 1);
	assert.ok(
		stderr.some((l) =>
			/^\[missing\] │ failed to start: .*ENOENT.*; stopping the rest$/.test(l),
		),
		stderr.join("\n"),
	);
});

test("each child gets its cwd, resolved against options.cwd, and its env", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-all-")));
	mkdirSync(join(dir, "sub"));
	const run = runFixture(
		[
			{
				name: "c",
				cmd: node(
					"console.log(process.cwd());",
					"console.log(process.env.RUN_ALL_SET, typeof process.env.RUN_ALL_UNSET);",
				),
				cwd: "sub",
				// null: the fixture's stand-in for undefined
				env: { RUN_ALL_SET: "yes", RUN_ALL_UNSET: null as unknown as undefined },
			},
		],
		{ cwd: dir, exitWith: "c" },
		{ env: { RUN_ALL_UNSET: "inherited" } },
	);
	const { code, stdout } = await run.done;
	assert.equal(code, 0);
	assert.ok(stdout.includes(`[c] │ ${join(dir, "sub")}`), stdout.join("\n"));
	assert.ok(stdout.includes("[c] │ yes undefined"), stdout.join("\n"));
});

test("a command line runs through the shell", async () => {
	const run = runFixture(
		[
			{
				name: "sh",
				cmd: `echo "$RUN_ALL_X" && exit 4`,
				env: { RUN_ALL_X: "from env" },
			},
		],
		{ exitWith: "sh" },
	);
	const { code, stdout, stderr } = await run.done;
	assert.equal(code, 4);
	assert.ok(stdout.includes("[sh] │ from env"), stdout.join("\n"));
	// The only child: nothing else to stop.
	assert.ok(stderr.includes("[sh] │ exited with 4"), stderr.join("\n"));
});

test("colours: FORCE_COLOR, NO_COLOR and the option", async () => {
	const children = [
		{ name: "a", cmd: node("console.log(String(process.env.FORCE_COLOR));") },
		{ name: "b", cmd: node(KEEP) },
	];
	const cases = [
		{ env: {}, options: {}, colored: false },
		{ env: { FORCE_COLOR: "1" }, options: {}, colored: true },
		{ env: { FORCE_COLOR: "0" }, options: {}, colored: false },
		{ env: { NO_COLOR: "1" }, options: {}, colored: false },
		{ env: { NO_COLOR: "1" }, options: { colors: true }, colored: true },
	];
	for (const { env, options, colored } of cases) {
		const label = JSON.stringify({ env, options });
		const run = runFixture(children, { ...options, exitWith: "a" }, { env });
		const { stdout } = await run.done;
		const line = stdout.find((l) => l.includes("[a]")) ?? "";
		assert.equal(
			line.startsWith(`${ESC}36m[a]${ESC}0m`),
			colored,
			`${label}: ${line}`,
		);
		if (!colored) assert.ok(!line.includes(ESC), `${label}: ${line}`);
		// The children see FORCE_COLOR=1 only when the tags are coloured, unless it was set.
		const seen = "FORCE_COLOR" in env ? env.FORCE_COLOR : colored ? "1" : "undefined";
		assert.ok(line.endsWith(` ${seen}`), `${label}: ${line}`);
	}
});

test("the palette goes by position and a child may name its colour", async () => {
	const run = runFixture(
		[
			{ name: "a", cmd: node(READY, KEEP) },
			{ name: "b", cmd: node(READY, KEEP) },
			{ name: "c", cmd: node(READY, KEEP), color: "red" },
		],
		{ colors: true },
	);
	await run.waitFor(/ ready \d+$/, 3);
	run.kill("SIGTERM");
	const { stdout } = await run.done;
	const all = stdout.join("\n");
	assert.ok(all.includes(`${ESC}36m[a]${ESC}0m`), all);
	assert.ok(all.includes(`${ESC}35m[b]${ESC}0m`), all);
	assert.ok(all.includes(`${ESC}31m[c]${ESC}0m`), all);
});

test("runAll returns, and the process exits by itself with all output written", async () => {
	// process.exit() would drop whatever is still queued for a pipe.
	const lines = 20_000;
	const run = runFixture(
		[
			{
				name: "big",
				cmd: node(`for (let i = 0; i < ${lines}; i++) console.log("line " + i);`),
			},
			{ name: "idle", cmd: node(KEEP) },
		],
		{ exitWith: "big" },
	);
	const { code, stdout, result } = await run.done;
	assert.equal(code, 0);
	assert.deepEqual(result, { code: 0, endedFirst: "big", signal: null });
	const relayed = stdout.filter((l) => l.startsWith("[big ] │ line "));
	assert.equal(relayed.length, lines);
	assert.equal(relayed.at(-1), `[big ] │ line ${lines - 1}`);
});

test("pipes held open by a process outside the group do not hang the run", async () => {
	const child = node(HOLD_PIPES, "setTimeout(() => process.exit(0), 300);");
	const run = runFixture([{ name: "c", cmd: child }], { exitWith: "c" });
	const t0 = Date.now();
	const { code } = await run.done;
	assert.equal(code, 0);
	assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});
