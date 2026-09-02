// Run with: npx electron scripts/test-adblock.mjs
// Verifies the blocklist matcher against representative URLs.
import { app } from "electron";
import { adblocker } from "../dist-electron/electron/adblock.js";

const SHOULD_BLOCK = [
  "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
  "https://www.google-analytics.com/collect?v=1",
  "https://connect.facebook.net/en_US/fbevents.js",
  "https://static.doubleclick.net/instream/ad_status.js",
  "https://cdn.taboola.com/libtrc/loader.js",
  "https://sub.domain.adnxs.com/tracker.gif",
  "https://example.com/adserver/banner.png",
  "https://analytics.tiktok.com/i18n/pixel/events.js",
  "https://c.amazon-adsystem.com/aax2/apstag.js"
];

const SHOULD_ALLOW = [
  "https://en.wikipedia.org/wiki/Main_Page",
  "https://github.com/anthropics/claude-code",
  "https://news.ycombinator.com/",
  "https://duckduckgo.com/?q=test",
  "https://cdn.jsdelivr.net/npm/react/umd/react.production.min.js",
  "https://fonts.googleapis.com/css2?family=Inter",
  // Nearby-but-legitimate hosts must not be caught by the domain matcher.
  "https://notdoubleclick.net/page",
  "https://myadnxs.com.example.org/safe"
];

app.whenReady().then(() => {
  let failures = 0;

  adblocker.setEnabled(true);
  adblocker.setCustomRules("||custom-tracker.test^\n/my-ad-path/");

  for (const url of SHOULD_BLOCK) {
    if (!adblocker.shouldBlock(url)) {
      console.error(`FAIL (should block): ${url}`);
      failures++;
    }
  }
  for (const url of SHOULD_ALLOW) {
    if (adblocker.shouldBlock(url)) {
      console.error(`FAIL (should allow): ${url}`);
      failures++;
    }
  }

  // Custom rules
  if (!adblocker.shouldBlock("https://custom-tracker.test/x.js")) {
    console.error("FAIL: custom ||domain^ rule not applied");
    failures++;
  }
  if (!adblocker.shouldBlock("https://example.org/my-ad-path/x.png")) {
    console.error("FAIL: custom path rule not applied");
    failures++;
  }

  // Disabling must allow everything through.
  adblocker.setEnabled(false);
  if (adblocker.shouldBlock(SHOULD_BLOCK[0])) {
    console.error("FAIL: blocking still active when disabled");
    failures++;
  }

  console.log(
    failures === 0
      ? `PASS: ${SHOULD_BLOCK.length} blocked, ${SHOULD_ALLOW.length} allowed, custom rules + toggle OK`
      : `${failures} failure(s)`
  );
  app.exit(failures === 0 ? 0 : 1);
});
