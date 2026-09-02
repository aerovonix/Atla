# Contributing to Atla

Thanks for looking. Atla is a solo project, so the process here is light — but a few things are worth knowing before you spend time on a change.

## Before you start on something large

Open an issue first. Atla has opinions about how it works, particularly around the approval gates and what the model is allowed to do without asking, and a change that cuts against those is likely to be declined however good the code is. A short issue saves you writing it.

Small fixes — a bug, a typo, a platform quirk — just send them.

## Licensing

Atla is **CC BY-NC-SA 4.0**. By contributing you agree your contribution is licensed the same way, which in practice means it can't be sold and derivatives stay under the same terms. If that doesn't work for you, don't contribute — better to know now than after the work.

The fonts in `src/assets/fonts/` are under the SIL Open Font License and are not covered by the project's licence. Don't relicense them.

## Branches

```
testing  →  beta  →  main
```

- **`testing`** is the workbench. Base your work here. History is not protected; it can be rewritten.
- **`beta`** is what's believed to work but hasn't been released.
- **`main`** is what people download. It accepts pull requests only, and every release is tagged from it.

Open pull requests against `testing` unless you're fixing something already released.

## Running it

```bash
npm ci
npm run dev
```

Needs Node 20 or newer. On macOS you'll also want Xcode command line tools for packaging.

## Tests

```bash
npm test
```

That runs the typecheck, the adblock suite, and the self-test — 400-odd checks under a real Electron process, including live HTTP servers standing in for model providers.

**A change to logic should come with a check.** The self-test lives in `electron/selftest.ts`, and most of what it covers is deliberately pure and sitting in `shared/` for that reason: branch trees, review verdicts, the desktop allowlist, dash pairing, diffing, markdown stripping. If your change touches something that fails quietly when it fails — permissions, gating, parsing, anything security-adjacent — that's exactly the kind of thing a check needs to hold down.

Pull requests are expected to leave the suite passing.

## Things worth knowing about the codebase

**Failures must name themselves.** Several bugs in this project's history were hard to find only because the error said nothing useful — a `fetch failed` that hid a DNS error in `.cause`, a macOS permission that surfaced as a routing failure. If you write an error path, make it say what went wrong and what to do.

**Gates fail closed.** A missing approval handler counts as a refusal, never as permission. If you touch `approvals.ts`, `desktopPolicy.ts`, or anything that decides whether the model may act, keep that direction and add a check proving it.

**Comments explain why, not what.** The code says what it does. Comments in this project exist to record the reasoning that isn't visible — a constraint, a trade-off, a bug that a naive version would reintroduce.

## Platform notes

Windows is the primary development platform. macOS builds and runs but parts of it are still unverified — see `TODO.md`. Linux has build configuration but has never been run.

If you're testing on a platform that isn't yours, say so in the pull request. "Builds on Linux" and "works on Linux" are different claims and both are useful, but they shouldn't be confused.
