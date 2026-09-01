/**
 * The two pieces of Dev Containers handling that both sides of the system need:
 * the router, which reads a repository's devcontainer over the GitHub API to
 * decide what to build, and the worker, which reads the SAME file out of the
 * clone it just made to run `postCreateCommand`.
 *
 * Nothing here talks to a network or a registry — it is a path list and a
 * parser, which is exactly the part that must not drift between the two
 * readers. Everything build-related stays in `cyrus-router`.
 */

/**
 * The spec's well-known paths, in the spec's own precedence order.
 *
 * Matches `getDevContainerConfigPathIn` in the reference implementation
 * (`spec-configuration/configurationCommonUtils.ts`), which returns the first
 * of these that is a file. Diverging would build a repository carrying both
 * files from the one its author believed was inactive, differing silently from
 * VS Code, Codespaces and the `devcontainer` CLI.
 *
 * The list has exactly two entries there too. `.devcontainer/<folder>/devcontainer.json`
 * is VS Code's own discovery, not the CLI's, and it exists so a human can
 * choose between configurations — which is why we treat it as unsupported
 * rather than picking one.
 */
export const DEVCONTAINER_PATHS = [
	".devcontainer/devcontainer.json",
	".devcontainer.json",
] as const;

/**
 * `devcontainer.json` is JSON with Comments: `//` and block comments, and
 * trailing commas. `JSON.parse` rejects all three, and every real devcontainer
 * file in the wild uses at least the first.
 *
 * Hand-rolled rather than adding a dependency: the grammar is small, and the
 * only thing that makes it non-trivial is that a `//` inside a string literal
 * is not a comment — which is what the `inString` state below is for.
 */
export function parseJsonc(text: string): unknown {
	let out = "";
	let i = 0;
	let inString = false;
	while (i < text.length) {
		const ch = text[i];
		if (inString) {
			out += ch;
			// A backslash escapes the next character wholesale, including a
			// closing quote — copy both so `"a\"b"` does not end the string early.
			if (ch === "\\" && i + 1 < text.length) {
				out += text[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i += 1;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
				i += 1;
			i += 2;
			continue;
		}
		out += ch;
		i += 1;
	}
	// Trailing commas, once comments are gone and outside string literals. The
	// stripper above already dropped every comment, so a `,` followed only by
	// whitespace and a closer is unambiguous here.
	out = out.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(out);
}
