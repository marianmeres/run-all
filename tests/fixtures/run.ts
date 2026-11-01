// Runs runAll() with the children and options given as JSON in argv[2], then reports the
// result on stderr as `RESULT <json>`. JSON has no `undefined`: a `null` env value stands
// for it.

import process from "node:process";
import { type ChildSpec, type RunAllOptions, runAll } from "../../src/run-all.ts";

const { children, options } = JSON.parse(process.argv[2] ?? "{}") as {
	children: ChildSpec[];
	options?: RunAllOptions;
};
for (const { env } of children) {
	for (const key of Object.keys(env ?? {})) {
		if (env && env[key] === null) env[key] = undefined;
	}
}

const result = await runAll(children, options);
process.stderr.write(`RESULT ${JSON.stringify(result)}\n`);
