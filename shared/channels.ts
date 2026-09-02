/**
 * Which releases a given channel accepts.
 *
 * The version number is the whole mechanism. `0.7.0-beta.2` is a beta by
 * virtue of its name — nothing else marks it — so the ordering below is what
 * decides who receives what.
 *
 * ## Why this filter exists at all
 *
 * electron-builder's channel cascade (a stable build also writing `alpha.yml`
 * and `beta.yml`) is explicitly disabled for the GitHub provider: a stable
 * release publishes `latest.yml` and nothing else. Meanwhile electron-updater
 * picks the channel file from *the tag it found*, falling back to
 * `autoUpdater.channel` for a stable tag.
 *
 * So pinning `autoUpdater.channel = "beta"` would make a beta user ask a
 * stable release for a `beta.yml` that was never generated — a 404 the updater
 * retries forever while reporting nothing. That is precisely the failure that
 * stranded 0.6.1 at 0%, so it is worth not rebuilding on purpose.
 *
 * Instead the provider is left to resolve each tag's own channel file, and
 * tier is enforced here, through `isUpdateSupported`.
 */

export type UpdateChannel = "stable" | "beta" | "alpha";

/** The prerelease identifier in a version, or null when it is a final release. */
export function prereleaseId(version: string): string | null {
  const at = version.indexOf("-");
  if (at === -1) return null;
  const id = version.slice(at + 1).split(".")[0].toLowerCase();
  return id || null;
}

/**
 * Maturity, ascending. An `rc` sits above `beta` because it is closer to
 * shipping, so someone on the beta channel should receive it; someone on
 * alpha receives everything.
 */
const RANK: Readonly<Record<string, number>> = { alpha: 0, beta: 1, rc: 2 };

/** The lowest maturity each channel will accept. */
const FLOOR: Readonly<Record<UpdateChannel, number>> = {
  alpha: RANK.alpha,
  beta: RANK.beta,
  stable: Number.POSITIVE_INFINITY
};

/**
 * True when `version` should be offered to someone on `channel`.
 *
 * A final release is offered to everyone, including alpha users: the newest
 * thing available is the newest thing available, and stranding someone on a
 * prerelease because they opted into early builds would be the opposite of
 * what they asked for.
 *
 * An unrecognised identifier — `0.7.0-experiment.1` — is treated as the least
 * mature thing there is, so only the alpha channel takes it. Guessing
 * generously about a label nobody defined is how people end up on builds they
 * did not agree to.
 */
export function acceptsVersion(channel: UpdateChannel, version: string): boolean {
  const id = prereleaseId(version);
  if (id === null) return true;
  // An unknown label ranks *as* alpha rather than below it. Ranking it lower
  // would leave it below every floor including alpha's, so the release would
  // reach nobody at all -- a build that silently goes nowhere, which is the
  // failure this whole module exists to avoid.
  const rank = id in RANK ? RANK[id] : RANK.alpha;
  return rank >= FLOOR[channel];
}

/** Human-readable tier for a version, for logs and the settings screen. */
export function describeVersion(version: string): string {
  const id = prereleaseId(version);
  if (id === null) return "stable";
  return id in RANK ? id : "prerelease";
}
