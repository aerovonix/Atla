## What this changes

<!-- What it does, and why. If it fixes an issue, link it. -->

## How you know it works

<!-- What you actually ran or looked at. "Typechecks" isn't verification.
     If you couldn't test something — a platform you don't have, a path that
     needs real credentials — say so plainly. An honest gap is far more
     useful than an implied claim. -->

- [ ] `npm test` passes (typecheck, adblock, self-test)
- [ ] Added or updated checks in `electron/selftest.ts` for the logic this touches
- [ ] Tried it in the running app, not only in tests

## Platforms

<!-- Tick what you actually ran it on. Leave the rest — someone else can cover
     them. "Builds" and "works" are different claims; say which you mean. -->

- [ ] Windows
- [ ] macOS
- [ ] Linux

## If this touches gating

<!-- approvals.ts, desktopPolicy.ts, the tool layer, or anything deciding
     whether the model may act. Delete this section if it doesn't. -->

- [ ] Failure still resolves to *denied* — a missing handler never reads as permission
- [ ] There's a check proving that direction

## Anything you're unsure about

<!-- Genuinely useful. A named doubt gets looked at; an unnamed one ships. -->
