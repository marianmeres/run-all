# Process model

How `runAll` (`src/run-all.ts`) starts, watches and stops processes, and why. Each
invariant is easy to undo by accident, and each one has a test that fails without it. The
behaviour users see (events and exit codes) is in the README under "How it stops". Do not
restate it here.

## Lifecycle

```
validate ──► install SIGINT/SIGTERM/SIGHUP + exit listeners ──► spawn each child (detached)
                                                                  │
   first `close` of a child  ──or──  first stop signal ◄──────────┘
            │                              │
            ▼                              ▼
   result = its code               result = 128 + n
   SIGTERM → every group           same signal → every group
            └──────────────┬───────────────┘
                           ▼
          killTimeout later: SIGKILL → groups not yet closed
          second signal: SIGKILL → every group, process.exit(result.code)
                           │
          all children closed ──► remove listeners ──► process.exitCode = code ──► resolve
```

## Invariants

| #   | Rule                                                                                                                 | Why                                                                                                                                                                                  | Test                                              |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| 1   | Spawn every child `detached` (a new session and process group)                                                       | The terminal's Ctrl-C reaches only run-all, and run-all signals each group once. Children in the foreground group would get the signal directly and again from whatever forwards it. | all signal tests                                  |
| 2   | Signal the group: `process.kill(-pid, signal)`, never `proc.kill()`                                                  | `pnpm` and `node --watch` often do not pass a signal on. Signalling only the direct child leaves the grandchild (vite, the server) running, holding its port.                        | "the signal goes to the whole group"              |
| 3   | A child counts as ended on `close`, not `exit`                                                                       | `close` waits for the pipes, so its last lines (including a grandchild's late ones) come before the "exited with" line.                                                              | "comes after everything written into its pipes"   |
| 4   | Destroy a child's pipes `DRAIN_GRACE` (1 s) after its `exit` (an unref'd timer)                                      | A process that left the group (it called `setsid` or ran detached) can hold the pipes open forever, and `close` would never come.                                                    | "pipes held open … do not hang the run"           |
| 5   | The normal path never calls `process.exit`. Set `process.exitCode` and resolve                                       | On macOS, writes to a pipe are asynchronous, and `process.exit` drops what is still queued (measured: 13k of 50k lines arrived). Callers can also code after `await runAll()`.       | every test that asserts `result`                  |
| 6   | Only a second signal exits hard: `SIGKILL` to every group, then `process.exit(result.code)`                          | The user has said they will not wait. Waiting could still take the drain grace or longer.                                                                                            | "a second signal kills … exits at once"           |
| 7   | `killTimeout` escalates to `SIGKILL` for groups not yet closed; a value over 2³¹−1 (or `Infinity`) means never       | Some processes swallow `SIGTERM`. `setTimeout` fires at once for anything longer than 2³¹−1.                                                                                         | "killTimeout: SIGKILL …"                          |
| 8   | Validate everything before the first side effect                                                                     | A rejection must leave no listeners installed and no child running.                                                                                                                  | "rejects invalid input …" (checks listener count) |
| 9   | Check that each `cwd` exists up front                                                                                | `spawn` reports a missing cwd as `ENOENT` for the command, which points at the wrong thing.                                                                                          | "rejects invalid input …"                         |
| 10  | Pause a source while its destination's buffer is full (`writer()`), with one shared `drain` listener per destination | Prevents unbounded memory growth when a child outruns a slow terminal or pipe. A listener per source would trip `MaxListenersExceededWarning` above 10 streams.                      | none (no observable output)                       |
| 11  | Shell command lines go through `spawn(cmd, { shell: true })` with no args array                                      | Passing args together with `shell: true` is deprecated (DEP0190).                                                                                                                    | "a command line runs through the shell"           |

## Known limits

- POSIX only. On Windows, `detached` and negative pids mean something else, so `runAll` throws.
- Children get no stdin and no controlling terminal (invariant 1), so a child that opens
  `/dev/tty` gets `SIGTTIN`/`ENXIO`.
- Lines are relayed whole. A prompt without a trailing newline shows only when the line
  ends or the stream closes. `\r` progress updates turn into separate lines.
- A partial last line is lost if invariant 4 destroys the pipe before it ends (readline
  flushes on `end`, not on `destroy`).
- Pid reuse: a group id is signalled at most `killTimeout` after its leader closed. That
  window is too short to matter in practice.
