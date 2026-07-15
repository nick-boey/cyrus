// Ambient augmentation for Bun's `import.meta.main` flag.
//
// The repo has no `bun-types`/`@types/bun` dependency installed, so
// TypeScript's built-in `ImportMeta` interface doesn't know about this
// Bun-specific property. `router-server.ts` uses `import.meta.main` to guard
// its CLI entrypoint block (so importing it under Vitest doesn't also run
// the CLI block) — this declaration merge lets `tsc --noEmit` see the
// property without pulling in the full Bun global type surface.
export {};

declare global {
	interface ImportMeta {
		/** True when this module is the entrypoint Bun was invoked with. */
		readonly main: boolean;
	}
}
