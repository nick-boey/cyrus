#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalErrorReporter } from "cyrus-core";
import dotenv from "dotenv";
import { buildProgram } from "./buildProgram.js";
import { createErrorReporter } from "./services/createErrorReporter.js";

// Get the directory of the current module for reading package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json to get the actual version
// When compiled, this is in dist/src/, so we need to go up two levels
const packageJsonPath = resolve(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

// Pre-load env vars from the resolved .env file before initialising Sentry, so
// that CYRUS_SENTRY_DISABLED / CYRUS_SENTRY_DSN take effect on the first run.
// We re-resolve the path inside Application using the same precedence (CLI
// flag wins); this preliminary load only honours CYRUS_HOME and the default.
preloadEnvForBootstrap();

// Initialise the error reporter as early as possible so that exceptions
// thrown by subsequent imports/bootstrap are captured. Install it as the
// process-wide reporter so that every Logger.error(...) call across the
// codebase forwards to Sentry automatically.
const errorReporter = createErrorReporter({ release: packageJson.version });
setGlobalErrorReporter(errorReporter);

// Build the Commander program (see buildProgram.ts for the full command tree)
const program = buildProgram(packageJson, errorReporter);

// Parse and execute
(async () => {
	try {
		await program.parseAsync(process.argv);
	} catch (error) {
		errorReporter.captureException(error, { tags: { phase: "bootstrap" } });
		await errorReporter.flush(2000).catch(() => false);
		console.error("Fatal error:", error);
		process.exit(1);
	}
})();

/**
 * Best-effort env preload so the error reporter can read its config before the
 * full {@link Application} bootstrap. We honour `--env-file` only as a literal
 * argv lookup (Commander hasn't parsed yet) and otherwise fall back to the
 * default `<cyrus-home>/.env` path.
 */
function preloadEnvForBootstrap(): void {
	const argv = process.argv.slice(2);
	const flagIdx = argv.indexOf("--env-file");
	const cyrusHomeIdx = argv.indexOf("--cyrus-home");

	const envFile = flagIdx >= 0 ? argv[flagIdx + 1] : undefined;
	const cyrusHome =
		cyrusHomeIdx >= 0 && argv[cyrusHomeIdx + 1]
			? (argv[cyrusHomeIdx + 1] as string)
			: resolve(homedir(), ".cyrus");

	const path = envFile ?? join(cyrusHome, ".env");
	if (existsSync(path)) {
		dotenv.config({ path, override: false });
	}
}
