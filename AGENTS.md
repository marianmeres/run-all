# @marianmeres/run-all — Agent Guide

## Quick Reference

- **What**: runs several processes side by side as one: tagged line output, all stopped
  when one ends, signals to whole process groups. CLI (`run-all name=cmd …`) + library
  (`runAll()`). Zero runtime dependencies; POSIX only (throws on Windows).
- **Stack**: TypeScript (erasable-only), Node LTS (`.node-version`), pnpm, `node:test`, Biome.
- **Install**: `pnpm install` | **Test**: `pnpm test` | **Check all**: `pnpm run ci` |
  **Build**: `pnpm run build`
- **Distribution**: npm only, public (`@marianmeres/run-all`, bin `run-all`). No JSR.

## Project Structure

```
src/run-all.ts         runAll() + types: spawn, relay, stop, exit code (the whole engine)
src/cli.ts             parseCli() (exported for tests) + main(); USAGE text
src/bin.ts             npm `bin` entry; calls main() unconditionally
src/index.ts           package entry; re-exports run-all.ts only (not the CLI)
tests/run-all.test.ts  behaviour, through tests/fixtures/run.ts in a real process
tests/cli.test.ts      parseCli units + the bin end to end
tests/helpers.ts       Session (spawn + line capture + waitFor), node -e snippets, cleanup
docs/process-model.md  invariants, each with its reason and its test (read before touching src/run-all.ts)
API.md                 human API + CLI reference; README.md "How it stops" = the exit-code contract
dist/                  build output; gitignored; the only thing published
```

## Critical Conventions

1. **Runtime policy**: Node at the keyboard and in production, npm as the registry. No
   `Deno.*`, `Bun.*`, `jsr:` or `npm:` specifiers; `node:*` only (no dependencies).
2. **Erasable TypeScript**: no `enum`, `namespace`, constructor parameter properties;
   `import type` for types; explicit `.ts` import extensions. `pnpm run typecheck` is the
   only type gate.
3. **The process model is a contract**: keep every invariant in
   [docs/process-model.md](./docs/process-model.md). In short: children `detached`;
   signals to `-pid`; ended on `close`; drain grace; no `process.exit` except on the second
   signal; validate before any side effect.
4. **Errors**: library errors start with `run-all: ` and are thrown (rejected) before
   anything starts. The CLI prints the message plus `Try 'run-all --help'.` and exits 2.
   Output is the contract: write to `process.stdout`/`stderr` directly (no clog).
5. **Formatting**: tabs, 4 wide, 90 columns (`biome.json`). `pnpm run format` before
   committing; `pnpm run lint` is the read-only check CI runs.
6. **Tests spawn real processes**. Signals and exit codes cannot be tested in-process.
   Child snippets print `READY` _after_ installing their handlers, since a test signals on
   that line. Wait on output (`waitFor`, `ready`), never on fixed sleeps. `afterEach(cleanup)`
   kills announced pids. CI runs on Linux and macOS (pipes and groups behave differently).
7. **Releasing is a human action**: `pnpm run rp` / `rpm` (bump, commit, tag, push via
   `@marianmeres/release`, then `pnpm publish`, whose `prepublishOnly` runs `ci` + `build`).

## Before Making Changes

- [ ] Touching `src/run-all.ts`: read docs/process-model.md first; keep its table in step
- [ ] Behaviour change: update the README "How it stops" table, API.md, and add a test
- [ ] New mechanism: add a test that fails when the mechanism is removed (mutate and run)
- [ ] New CLI flag: `parse()` options, `parseCli()`, `USAGE`, the API.md CLI table
- [ ] `pnpm run ci`; run it a few times when timing-sensitive tests changed

## Documentation Index

- [README.md](./README.md): human docs, the exit-code contract ("How it stops")
- [API.md](./API.md): API + CLI reference
- [docs/process-model.md](./docs/process-model.md): invariants, reasons, tests
