# API

```ts
import { COLORS, runAll } from "@marianmeres/run-all";
import type {
	ChildSpec,
	Color,
	RunAllOptions,
	RunAllResult,
	StopSignal,
} from "@marianmeres/run-all";
```

## Functions

### `runAll(children, options?)`

Runs `children` side by side until the first one ends, then stops the rest. What stops
them, in what order, and with which exit code is in the README, under
[How it stops](README.md#how-it-stops).

Every line a child writes goes to the matching stream of this process (stdout or stderr)
behind the child's tag, padded so all tags have the same width: `[api] │ listening`. A
final line without a newline is still relayed. When a child ends, one more line is
printed on stderr after its last output, saying why:
`[api] │ exited with 1; stopping the rest`.

While it runs, `runAll` owns the process's `SIGINT`, `SIGTERM` and `SIGHUP` handlers, and
removes them when it is done.

**Parameters:**

- `children` (`ChildSpec[]`): what to run, at least one.
- `options` (`RunAllOptions`, optional): see below.

**Returns:** `Promise<RunAllResult>`. It resolves once every child has ended and its output
is relayed. Before resolving it sets `process.exitCode` to `result.code`, so a script that
just awaits it exits with the right code. On that path it never calls `process.exit`,
because that would drop output still queued for a pipe. The one exception is a second stop
signal: it kills everything and exits at once.

**Throws** (rejects before starting anything): nothing to run; a name that is empty,
contains whitespace or repeats; an empty command; an unknown colour; an `exitWith` that
names no child; a `killTimeout` that is not a number `>= 0`; a `cwd` that is not a
directory; Windows.

**Example:**

```ts
const result = await runAll(
	[
		{ name: "server", cmd: ["node", "server.ts"], env: { PORT: "8080" } },
		{ name: "test", cmd: "node --test tests/e2e" },
	],
	{ exitWith: "test", killTimeout: 2000 },
);
// result: { code: 0, endedFirst: "test", signal: null }
```

---

## Types

### `ChildSpec`

```ts
interface ChildSpec {
	name: string;
	cmd: string | readonly string[];
	cwd?: string | URL;
	env?: Record<string, string | undefined>;
	color?: Color;
}
```

- `name`: the tag in front of every line. Unique, non-empty, no whitespace.
- `cmd`: either an argv array, spawned as it is (no shell), or a command line run by
  `/bin/sh -c`.
- `cwd`: the working directory, resolved against `RunAllOptions.cwd`. Default:
  `RunAllOptions.cwd`.
- `env`: merged over the inherited environment. An `undefined` value removes a variable.
- `color`: the tag colour. Default: the next one in `COLORS`, by the child's position.

### `RunAllOptions`

```ts
interface RunAllOptions {
	cwd?: string | URL;
	exitWith?: string;
	killTimeout?: number;
	colors?: boolean;
}
```

- `cwd`: what every child's `cwd` is resolved against. Default: `process.cwd()`.
  `new URL("../", import.meta.url)` works.
- `exitWith`: the name of the child whose exit is the result. When it ends, the rest are
  stopped and its code is the result, `0` included. Any other child ending first is a
  failure. Without `exitWith`, every child is expected to run until stopped, so any child
  that ends is a failure, and a `0` is reported as `1`.
- `killTimeout`: milliseconds between the stop signal and `SIGKILL` for whatever still runs.
  `Infinity` never escalates. Default: `5000`.
- `colors`: colour the tags, and set `FORCE_COLOR=1` for the children. Default: on when
  `FORCE_COLOR` is set (and is not `0` or `false`), off when `NO_COLOR` is set, otherwise on
  when stdout is a terminal.

### `RunAllResult`

```ts
interface RunAllResult {
	code: number;
	endedFirst: string | null;
	signal: StopSignal | null;
}
```

- `code`: the exit code, also set as `process.exitCode`.
- `endedFirst`: the child that ended first, or `null` when a signal stopped the run.
- `signal`: the signal that stopped the run, or `null` when a child ended first.

### `Color`

`"cyan" | "magenta" | "yellow" | "green" | "blue" | "red"`

### `StopSignal`

`"SIGINT" | "SIGTERM" | "SIGHUP"`: the signals run-all handles and forwards.

---

## Constants

### `COLORS`

`["cyan", "magenta", "yellow", "green", "blue", "red"]`: the tag colours, given out in this
order, wrapping around after the sixth child.

---

## CLI

```
run-all [options] <name=command>...
```

Each argument is `name=command`, split at the first `=`, so
`'api=PORT=1 node main.ts'` is the name `api` with the command `PORT=1 node main.ts`. Every
argument must carry a name. A bare `'PORT=1 node main.ts'` would parse as the name `PORT`.
Commands run through `/bin/sh -c`.

| Option                | Does                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `--exit-with <name>`  | the result is this command's exit code, 0 included; any other command ending first is a failure     |
| `--kill-timeout <ms>` | `SIGKILL` whatever still runs this long after the stop signal (default 5000; `Infinity` never does) |
| `-h`, `--help`        | prints usage                                                                                        |
| `-v`, `--version`     | prints the version                                                                                  |

Exit codes are the same as the library's (see [How it stops](README.md#how-it-stops)),
plus `2` for a usage error. A usage error prints `run-all: <reason>` and
`Try 'run-all --help'.` on stderr.
