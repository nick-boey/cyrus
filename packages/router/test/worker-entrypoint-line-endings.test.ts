import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the 2026-07-27 ACA outage.
 *
 * `docker/worker/entrypoint.sh` is COPYed into the worker image and declared as
 * its `ENTRYPOINT`. If the file carries CRLF line endings, the kernel reads the
 * shebang interpreter as `/bin/sh\r`, which does not exist — so the exec fails
 * with a bare "No such file or directory", the worker process never starts, and
 * the sandbox sits idle under ACA's `tini -- sleep infinity` keep-alive while
 * reporting `Running`. The delegation then hangs forever with no error anywhere.
 *
 * The committed blob is LF, but `core.autocrlf=true` (the Windows default)
 * rewrites it to CRLF on checkout, so an image built from a Windows working
 * tree ships a broken entrypoint. `.gitattributes` pins these paths to LF; this
 * test fails loudly if that protection is ever removed or a new CRLF file
 * slips in.
 */
const SHELL_ASSETS = [
	"../../../docker/worker/entrypoint.sh",
	"../../../docker/router/entrypoint.mjs",
];

describe("container entrypoint assets", () => {
	for (const relative of SHELL_ASSETS) {
		it(`${relative.split("/").slice(-2).join("/")} has no CRLF line endings`, () => {
			const path = fileURLToPath(new URL(relative, import.meta.url));
			const contents = readFileSync(path, "utf8");
			expect(contents).not.toContain("\r");
		});
	}

	it("worker entrypoint starts with a clean POSIX shebang", () => {
		const path = fileURLToPath(
			new URL("../../../docker/worker/entrypoint.sh", import.meta.url),
		);
		const firstLine = readFileSync(path, "utf8").split("\n")[0];
		expect(firstLine).toBe("#!/bin/sh");
	});
});
