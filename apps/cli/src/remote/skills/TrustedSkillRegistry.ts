import type { OperatorSkillCompatibilityV1 } from "cyrus-operator-protocol";
import { UsageError } from "../errors.js";

export const TRUSTED_SKILL_NAME = "cyrus-fleet-operator";
export const TRUSTED_RELEASE_ORIGIN = "https://github.com";
const RELEASE_REPOSITORY = "cyrusagents/cyrus";

export interface TrustedSkillRelease {
	name: typeof TRUSTED_SKILL_NAME;
	version: string;
	archiveUrl: string;
	checksumUrl: string;
	expectedChecksum: string;
}

export class TrustedSkillRegistry {
	constructor(private readonly cliVersion: string) {}

	resolve(advertised: OperatorSkillCompatibilityV1): TrustedSkillRelease {
		if (advertised.name !== TRUSTED_SKILL_NAME) {
			throw new UsageError(
				`Skill "${advertised.name}" is not in the trusted Cyrus registry.`,
			);
		}
		assertExactVersion(advertised.version, "skill");
		assertExactVersion(this.cliVersion, "CLI");
		if (advertised.minCliVersion) {
			assertExactVersion(advertised.minCliVersion, "minimum CLI");
			if (compareVersions(this.cliVersion, advertised.minCliVersion) < 0) {
				throw new UsageError(
					`Skill ${advertised.version} requires Cyrus CLI ${advertised.minCliVersion} or newer; this CLI is ${this.cliVersion}.`,
				);
			}
		}
		// Skills ship in lockstep with the CLI. This deliberately refuses a router
		// advertising older or newer instructions even if its releaseUrl looks safe.
		if (advertised.version !== this.cliVersion) {
			throw new UsageError(
				`Router advertises ${TRUSTED_SKILL_NAME} ${advertised.version}, but this CLI trusts release ${this.cliVersion}. Upgrade the router and CLI together.`,
			);
		}
		if (!/^sha256:[0-9a-f]{64}$/.test(advertised.checksum)) {
			throw new UsageError("Router advertised an invalid skill checksum.");
		}
		const filename = `${TRUSTED_SKILL_NAME}-${advertised.version}.tar.gz`;
		const base = `${TRUSTED_RELEASE_ORIGIN}/${RELEASE_REPOSITORY}/releases/download/v${advertised.version}/${filename}`;
		return {
			name: TRUSTED_SKILL_NAME,
			version: advertised.version,
			archiveUrl: base,
			checksumUrl: `${base}.sha256`,
			expectedChecksum: advertised.checksum,
		};
	}
}

function assertExactVersion(value: string, label: string): void {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
		throw new UsageError(
			`The ${label} version "${value}" is not an exact semantic version.`,
		);
	}
}

function compareVersions(left: string, right: string): number {
	const numeric = (value: string) =>
		value.split("-", 1)[0]!.split(".").map(Number);
	const a = numeric(left);
	const b = numeric(right);
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
	}
	return 0;
}
