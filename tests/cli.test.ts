import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { parseCli } from "../src/cli.ts";
import { cleanup, runBin } from "./helpers.ts";

afterEach(cleanup);

test("parseCli: name=command pairs, split at the first =", () => {
	assert.deepEqual(parseCli(["web=pnpm run dev", "api=PORT=1 node main.ts"]), {
		kind: "run",
		children: [
			{ name: "web", cmd: "pnpm run dev" },
			{ name: "api", cmd: "PORT=1 node main.ts" },
		],
		options: {},
	});
});

test("parseCli: options", () => {
	const parsed = parseCli(["--exit-with", "t", "--kill-timeout=250", "s=x", "t=y"]);
	assert.equal(parsed.kind, "run");
	assert.deepEqual(parsed.kind === "run" && parsed.options, {
		exitWith: "t",
		killTimeout: 250,
	});
	const never = parseCli(["--kill-timeout", "Infinity", "a=b"]);
	assert.equal(never.kind === "run" && never.options.killTimeout, Infinity);
});

test("parseCli: --help and --version win over everything else", () => {
	assert.deepEqual(parseCli(["--help", "a=b"]), { kind: "help" });
	assert.deepEqual(parseCli(["-h"]), { kind: "help" });
	assert.deepEqual(parseCli(["--version"]), { kind: "version" });
	assert.deepEqual(parseCli(["-v", "a=b"]), { kind: "version" });
});

test("parseCli: usage errors", () => {
	const cases: [string[], RegExp][] = [
		[[], /^run-all: nothing to run$/],
		[["pnpm run dev"], /expected name=command, got "pnpm run dev"/],
		[["=pnpm run dev"], /expected name=command/],
		[["--nope", "a=b"], /^run-all: Unknown option '--nope'/],
		[["--exit-with"], /^run-all: Option '--exit-with <value>' argument missing/],
		[["--exit-with", "c", "a=b"], /--exit-with "c" names no command/],
		[["--kill-timeout", "soon", "a=b"], /--kill-timeout must be a number/],
		[["--kill-timeout", "", "a=b"], /--kill-timeout must be a number/],
		[["--kill-timeout=-5", "a=b"], /--kill-timeout must be a number/],
	];
	for (const [argv, message] of cases) {
		assert.throws(() => parseCli(argv), { message }, JSON.stringify(argv));
	}
});

test("bin: runs the commands, and the first to end decides", async () => {
	const t0 = Date.now();
	const { code, stdout, stderr } = await runBin(["a=echo hi && exit 3", "b=sleep 5"])
		.done;
	assert.equal(code, 3);
	assert.ok(Date.now() - t0 < 3000, "b was not stopped");
	assert.ok(stdout.includes("[a] │ hi"), stdout.join("\n"));
	assert.ok(
		stderr.includes("[a] │ exited with 3; stopping the rest"),
		stderr.join("\n"),
	);
});

test("bin: --exit-with", async () => {
	const run = runBin(["--exit-with", "test", "server=sleep 5", "test=echo ok"]);
	const { code, stdout } = await run.done;
	assert.equal(code, 0);
	assert.ok(stdout.includes("[test  ] │ ok"), stdout.join("\n"));
});

test("bin: --help, --version", async () => {
	const help = await runBin(["--help"]).done;
	assert.equal(help.code, 0);
	assert.match(help.stdout[0] ?? "", /^Usage: run-all /);
	const version = await runBin(["--version"]).done;
	const manifest = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.equal(version.code, 0);
	assert.deepEqual(version.stdout, [manifest.version]);
});

test("bin: a usage error exits 2 and points at --help", async () => {
	for (const args of [[], ["no-equals-sign"], ["a=true", "a=true"]]) {
		const { code, stdout, stderr } = await runBin(args).done;
		assert.equal(code, 2, JSON.stringify(args));
		assert.deepEqual(stdout, []);
		assert.match(stderr[0] ?? "", /^run-all: /);
		assert.equal(stderr[1], "Try 'run-all --help'.");
	}
});
