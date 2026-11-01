#!/usr/bin/env node

// npm `bin` entry. Calls main() unconditionally, not behind an `import.meta.main` guard:
// a bin must never silently do nothing.
import { main } from "./cli.ts";

await main();
