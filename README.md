# @marianmeres/run-all

[![NPM](https://img.shields.io/npm/v/@marianmeres/run-all)](https://www.npmjs.com/package/@marianmeres/run-all)
[![License](https://img.shields.io/npm/l/@marianmeres/run-all)](LICENSE)

Run several processes side by side as one. Every line of output appears behind the name of
the process that wrote it, and all of them stop as soon as one ends. Use it for a dev setup
(watchers plus a backend), for a server with a test run against it, or for a local stack.
It is a CLI and a library, with no runtime dependencies.

Runs on macOS and Linux only, because it relies on POSIX process groups. Needs Node 24.12
or later.

## Installation

```sh
pnpm add -D @marianmeres/run-all
```

## Usage

### CLI

```json
{
	"scripts": {
		"dev:all": "run-all 'web=pnpm run dev' 'api=cd server && node --watch main.ts'"
	}
}
```

```
[web] │ VITE ready in 312 ms
[api] │ listening on http://localhost:8788
```

Each argument is `name=command`. The name tags the output, and the command runs through
`/bin/sh -c`, so `cd dir && …` and `VAR=1 …` work.

When one command decides the result, for example a server with a test run against it:

```sh
run-all --exit-with test 'server=node server.ts' 'test=node --test'
```

You can run it without adding a dependency, for example from a Deno task, with
`npx --yes @marianmeres/run-all …`. Pin a version range in scripts, because a bare `npx` can
reuse whatever version is already in its cache.

### Library

Use the library when the list needs code: per-child `cwd` or `env`, argv arrays (no shell),
or a comment explaining why each child is there.

```ts
// scripts/dev-all.ts, run with `node scripts/dev-all.ts`
import { runAll } from "@marianmeres/run-all";

await runAll(
	[
		{ name: "web", cmd: ["pnpm", "run", "dev"] },
		{
			name: "api",
			cmd: ["node", "--watch", "main.ts"],
			cwd: "server",
			env: { PORT: "8788" },
		},
	],
	{ cwd: new URL("../", import.meta.url) },
);
```

`runAll` resolves once everything has stopped and all output is written. It also sets
`process.exitCode`, so the process exits by itself with the right code.

## How it stops

| What happens                                                  | Then                                             | Exit code                    |
| ------------------------------------------------------------- | ------------------------------------------------ | ---------------------------- |
| A child ends on its own                                       | the rest get `SIGTERM`                           | its code (`1` if it was 0)   |
| The `--exit-with` child ends                                  | the rest get `SIGTERM`                           | its code, `0` included       |
| Another child ends before the `--exit-with` child             | the rest get `SIGTERM`                           | its code (`1` if it was 0)   |
| run-all gets `SIGINT` (Ctrl-C), `SIGTERM`, `SIGHUP`           | the same signal goes to every child              | `128 + n` (`130` for Ctrl-C) |
| Something still runs `--kill-timeout` ms later (default 5000) | it gets `SIGKILL`                                | unchanged                    |
| A second signal                                               | everything gets `SIGKILL`, run-all exits at once | unchanged                    |
| A usage error (CLI)                                           | nothing starts                                   | `2`                          |

Each signal goes to the child's whole process group. So in a chain like
`pnpm` → `vite` → `esbuild`, everything stops even when nobody in the chain passes the
signal on.

Children get no stdin. Each one runs in a session of its own with no terminal, so
interactive prompts (and vite's keyboard shortcuts) are not available. Tags are coloured
when stdout is a terminal. `FORCE_COLOR` and [`NO_COLOR`](https://no-color.org) override
that. When tags are coloured, children get `FORCE_COLOR=1`, because their own output is a
pipe and would otherwise lose its colours.

## API

See [API.md](API.md) for the full API and the CLI reference.

## Development

Node LTS (`.node-version`), pnpm, Biome, `node:test`. The source is erasable-only
TypeScript that Node runs directly; `dist/` is built only for publishing.

| Command                             | Does                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `pnpm install`                      | installs the dev tooling                                               |
| `pnpm test` / `pnpm run test:watch` | `node --test` over `tests/**/*.test.ts`                                |
| `pnpm run typecheck`                | `tsc --noEmit` over `src` and `tests`                                  |
| `pnpm run lint`                     | `biome check .`: format, lint and import order, read-only              |
| `pnpm run format`                   | `biome check --write .`: fixes all of the above                        |
| `pnpm run ci`                       | typecheck + lint + test, what CI runs                                  |
| `pnpm run build`                    | `tsc -p tsconfig.build.json` → `dist/`                                 |
| `pnpm run release`                  | bump, commit, tag, push (`@marianmeres/release` via npx)               |
| `pnpm run rp` / `pnpm run rpm`      | patch / minor release, then `pnpm publish` (which runs `ci` + `build`) |

## License

[MIT](LICENSE)
