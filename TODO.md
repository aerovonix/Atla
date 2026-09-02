# TODO

Known work, roughly in the order it's worth doing. Items marked **unverified** are written and building but have never actually been run — they're not known-broken, they're unknown.

## Before the next release

- [ ] **Publish with `npm run release`, not `gh release create`.** electron-builder uploads the installer, the update feed *and* the `.blockmap` together. Uploading by hand missed the blockmap on v0.6.1, and electron-updater sat at 0% forever waiting for a file that 404'd — a differential download it could not plan and would not abandon. Without the blockmap every update is a full download of the whole installer.

- [ ] **Cut v0.6.0 with `npm run release`, not `gh release create`.** The updater reads a `latest.yml` next to the installer; `gh` uploads only the `.exe`. Until one release exists with that file, auto-update finds nothing and silently reports "up to date". This first one becomes the baseline — anyone on v0.5.2 updates by hand once.
- [ ] Build and attach the macOS DMG to the same release (`npm run release:mac` on the Mac).

## macOS — unverified paths

Everything here is written and runs on Windows, but has never executed on macOS.

- [ ] **Process-group kill.** `sleep 60 | cat`, then Stop. Both processes should die. This was rewritten specifically for POSIX and never run — if only the shell dies and `cat` survives, that's the bug, and it silently orphans processes.
- [ ] **Desktop clicks and typing.** Needs Accessibility granted. Check a click lands where the screenshot said it would, and that the SendKeys-equivalent escaping doesn't mangle `+ ^ % ~ ( ) { } [ ]`.
- [ ] **The browser panel.** The `<webview>` is the heaviest platform-specific surface in the app.
- [ ] **`titleBarStyle` is unset**, so macOS draws its stock grey bar above Atla's own header. Fix is `titleBarStyle: "hiddenInset"` plus left padding so the traffic lights don't overlap the model picker.

## Desktop control — never actuated anywhere

- [ ] Run the click and type paths in a **VM**, not on a working machine. The policy layer has 30+ checks and the observation half works, but actuation has never fired on any platform. Worth exercising: coordinates landing correctly, the allowlist blocking a non-listed window, an irreversible label raising a confirmation, and the kill switch stopping a sequence mid-run.

## Signing

- [ ] **Windows:** unsigned, so SmartScreen shows "unknown publisher" and hides Run behind *More info*. The most common reason a download gets abandoned. Needs a paid certificate.
- [ ] **macOS:** unsigned means Gatekeeper reports downloads as "damaged", *and* auto-update can't work at all — Squirrel rejects an unsigned build before downloading. Needs the $99/yr Apple Developer account. This is the strongest argument for buying one.

## Linux

- [ ] **Never built or run.** Config exists (AppImage + deb). Likely first stumbles: `<webview>` under Wayland, and the AppImage sandbox needing `chrome-sandbox` SUID on some distros.

## Security posture

- [ ] **The web dash is unencrypted HTTP on the LAN.** Anything on that network can read the traffic. Stated in the UI rather than hidden, and the transport sits behind its own seam so a TLS tunnel can replace it — but it's still the weakest thing in the app.
- [ ] Consider whether "Allow commands this session" should expire on a timer rather than lasting until restart.

## Smaller things

- [ ] Startup check that names any missing macOS permission in one place, rather than each surfacing as a different confusing error later.
- [ ] No syntax highlighting in code blocks.
- [ ] No token or cost counters — relevant now that the review pass can double the calls per message.
- [ ] Adblock list is a compact built-in set (~150 patterns), not full EasyList.
- [ ] The message queue lives in memory; quitting mid-queue loses anything waiting.

## Deliberately not doing

- **CC BY-NC-SA for code.** Creative Commons recommends against it for software — no patent grant, and "NonCommercial" is ambiguous in practice. PolyForm Noncommercial is the code-native equivalent if that ambiguity ever becomes a real problem rather than a theoretical one.
- **A native automation module** for desktop control. Per-platform rebuilds pinned to each Electron version aren't worth it; the platform's own scripting works.
