# Releasing

Atla follows [semantic versioning](https://semver.org). Every release is
`MAJOR.MINOR.PATCH`, optionally followed by a prerelease tag.

While the major version is `0`, the minor number carries breaking changes —
that is what `0.x` means, and it is why 0.6.0 could change things 0.5.2 could
not.

## Branches

Each branch has one job, and work moves in one direction only.

| Branch    | Holds                      | Versions cut here | Published as |
| --------- | -------------------------- | ----------------- | ------------ |
| `testing` | Everything lands here first | `0.7.0-alpha.N`   | Prerelease   |
| `beta`    | Merged from `testing`      | `0.7.0-beta.N`, `0.7.0-rc.N` | Prerelease |
| `main`    | Merged from `beta`         | `0.7.0`           | Latest       |

**Land work on `testing`.** Not on `main`, and not on `beta` — a change that
appears on `main` without passing through the other two has never been run by
anyone but its author.

Promote by merging forward: `testing` → `beta` → `main`. Nothing is ever
written directly to `beta` or `main`, so the three branches stay ancestors of
each other and a version number always means the same commit everywhere.

## Which tag to use

- **`alpha`** — may be broken. Cut freely from `testing`.
- **`beta`** — feature-complete for that version, still finding bugs.
- **`rc`** — believed shippable. A release candidate should differ from the
  final release by nothing at all; if it needs a fix, cut another `rc`.
- *(no tag)* — the finished release.

Ordering is `alpha < beta < rc < final`, and it is enforced in code, not by
convention: see `acceptsVersion` in [shared/channels.ts](shared/channels.ts).

## Cutting a release

Start a new version's prerelease series first, then step along it. These are
two different npm operations and mixing them up is easy: `prerelease` bumps
the *patch* of a finished release, so running it on 0.6.1 gives you
`0.6.2-alpha.0`, not the new minor you probably meant.

```bash
npm run version:next-minor   # 0.6.1        -> 0.7.0-alpha.0
npm run version:next-patch   # 0.6.1        -> 0.6.2-alpha.0
```

Then step along the series, and promote it by changing the identifier:

```bash
npm run version:alpha    # 0.7.0-alpha.0 -> 0.7.0-alpha.1
npm run version:beta     # 0.7.0-alpha.3 -> 0.7.0-beta.0
npm run version:rc       # 0.7.0-beta.2  -> 0.7.0-rc.0
npm run version:patch    # 0.7.0-rc.2    -> 0.7.0   (drops the tag)
```

`version:patch` on a prerelease finishes it rather than incrementing, which is
what makes the last line the release step and not a mistake.

Each writes `package.json`, commits, and tags. Push the branch **and** the tag:

```bash
git push origin testing --follow-tags
```

Then build and publish. Prereleases must be flagged as such on GitHub:

```bash
npm run release -- --prerelease
```

Omit the flag for a final release, so it becomes "Latest".

## How a user's channel is honoured

Settings offers Stable, Beta and Alpha. Each tier receives everything at its
maturity level and above, so an alpha user still gets the final release when
that is the newest thing available.

Two mechanics make this work, and they are easy to get subtly wrong:

1. **electron-builder derives the channel file from the version string.**
   `0.7.0-beta.1` publishes `beta.yml`; `0.7.0` publishes `latest.yml`. For the
   GitHub provider it publishes *only* that one file — the cascade that would
   also write `alpha.yml` and `beta.yml` alongside a stable release is
   deliberately disabled for GitHub.

2. **electron-updater picks the channel file from whichever tag it found**, not
   from a channel you pin. So `autoUpdater.channel` is left unset on purpose.
   Pinning it to `"beta"` makes a beta user request `beta.yml` from a stable
   release, which does not exist, and the updater retries that 404 silently
   forever.

That second failure is not hypothetical — it is what stranded the 0.6.0 → 0.6.1
update at 0%, from a filename mismatch rather than a channel, and it took three
attempts to find because a missing update file reports nothing at all. Tier is
therefore enforced through `isUpdateSupported` instead, and a stalled download
now names itself after 90 seconds.

## Filenames

Artifact names must not contain spaces. GitHub rewrites spaces in uploaded
asset names to dots, while the update feed refers to them with hyphens, and the
two stop matching. `nsis.artifactName` in `package.json` pins this; do not
loosen it.

After publishing, confirm the feed and the assets agree:

```bash
gh release view v0.7.0 --json assets --jq '.assets[].name'
curl -sI https://github.com/<owner>/Atla/releases/download/v0.7.0/Atla-Setup-0.7.0.exe | head -1
```

A `200` on that second command is the check that actually matters. Assume
nothing about it — that assumption is what cost three rounds on 0.6.1.

## Past releases

`v0.5.2`, `v0.6.0` and `v0.6.1` predate this document. They are already valid
semver and are left as they are; 0.6.1 remains "Latest". The scheme above
applies from 0.7.0 onward.
