import { session, type Session } from "electron";

/**
 * A compact, self-contained blocklist. This is deliberately domain-oriented
 * rather than a full EasyList parser: it covers the large majority of ad and
 * tracker traffic with no network fetch and no multi-megabyte rule file.
 * Users can extend it via Settings → Browser → custom blocklist.
 */
const BLOCKED_DOMAINS = [
  // Google ads / analytics
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "googletagservices.com",
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "adservice.google.com",
  "pagead2.googlesyndication.com",
  "partner.googleadservices.com",
  // Meta
  "connect.facebook.net",
  "facebook.com/tr",
  "pixel.facebook.com",
  // Amazon ads
  "amazon-adsystem.com",
  "assoc-amazon.com",
  // Major ad exchanges / SSPs
  "adnxs.com",
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "criteo.com",
  "criteo.net",
  "casalemedia.com",
  "smartadserver.com",
  "adform.net",
  "taboola.com",
  "outbrain.com",
  "sharethrough.com",
  "indexww.com",
  "33across.com",
  "bidswitch.net",
  "sonobi.com",
  "gumgum.com",
  "media.net",
  "yieldmo.com",
  "triplelift.com",
  "spotxchange.com",
  "teads.tv",
  "adroll.com",
  "revcontent.com",
  "zergnet.com",
  "mgid.com",
  "propellerads.com",
  "popads.net",
  "adcolony.com",
  "applovin.com",
  "unityads.unity3d.com",
  "inmobi.com",
  "smaato.net",
  "mopub.com",
  // Analytics / tracking / session replay
  "scorecardresearch.com",
  "quantserve.com",
  "quantcast.com",
  "hotjar.com",
  "hotjar.io",
  "mouseflow.com",
  "fullstory.com",
  "luckyorange.com",
  "crazyegg.com",
  "inspectlet.com",
  "mixpanel.com",
  "segment.com",
  "segment.io",
  "amplitude.com",
  "heap.io",
  "heapanalytics.com",
  "kissmetrics.com",
  "chartbeat.com",
  "chartbeat.net",
  "parsely.com",
  "newrelic.com",
  "nr-data.net",
  "branch.io",
  "appsflyer.com",
  "adjust.com",
  "kochava.com",
  "bugsnag.com",
  "sentry-cdn.com",
  "matomo.cloud",
  "statcounter.com",
  "clarity.ms",
  "yandex.ru/metrika",
  "mc.yandex.ru",
  "hs-analytics.net",
  "hubspot.com/__ptq.gif",
  "marketo.net",
  "pardot.com",
  "bizible.com",
  "demdex.net",
  "omtrdc.net",
  "everesttech.net",
  "adobedtm.com",
  "krxd.net",
  "bluekai.com",
  "exelator.com",
  "rlcdn.com",
  "crwdcntrl.net",
  "agkn.com",
  "tapad.com",
  "liadm.com",
  "id5-sync.com",
  "pippio.com",
  "addthis.com",
  "sharethis.com",
  "onesignal.com",
  "pushcrew.com",
  "moatads.com",
  "adsafeprotected.com",
  "serving-sys.com",
  "flashtalking.com",
  "turn.com",
  "mathtag.com",
  "simpli.fi",
  "zemanta.com",
  "servedbyadbutler.com",
  "ad-delivery.net",
  "adsrvr.org",
  "contextweb.com",
  "lijit.com",
  "districtm.io",
  "yieldlab.net",
  "improvedigital.com",
  "adkernel.com",
  "247realmedia.com",
  "advertising.com",
  "adtechus.com",
  "adtech.de",
  "atdmt.com",
  "bing.com/bat.js",
  "ads.linkedin.com",
  "px.ads.linkedin.com",
  "analytics.twitter.com",
  "ads-twitter.com",
  "static.ads-twitter.com",
  "ads.pinterest.com",
  "ct.pinterest.com",
  "ads.tiktok.com",
  "analytics.tiktok.com",
  "snap.licdn.com",
  "sc-static.net/scevent"
];

/** Path/URL substrings that indicate ad or tracking requests on any host. */
const BLOCKED_PATTERNS = [
  "/adserver/",
  "/ad-server/",
  "/advertisement/",
  "/advertising/",
  "/adframe",
  "/banner-ads/",
  "/pagead/",
  "/adsense/",
  "/prebid",
  "/analytics.js",
  "/gtm.js",
  "/gtag/js",
  "/fbevents.js",
  "/beacon.js",
  "/tracking-pixel",
  "/track/pixel",
  "/pixel.gif",
  "/collect?v=",
  "/telemetry",
  "/openrtb2/"
];

export interface AdblockRule {
  domains: string[];
  patterns: string[];
}

function parseCustomRules(raw: string): AdblockRule {
  const domains: string[] = [];
  const patterns: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    // Support a useful subset of Adblock Plus syntax: ||domain^ and plain text.
    const abp = /^\|\|([^\^/*]+)\^?$/.exec(line);
    if (abp) {
      domains.push(abp[1].toLowerCase());
      continue;
    }
    if (line.includes("/") || line.includes("*")) {
      patterns.push(line.replace(/\*/g, "").toLowerCase());
    } else {
      domains.push(line.toLowerCase());
    }
  }
  return { domains, patterns };
}

function hostMatches(host: string, blocked: string): boolean {
  // A bare domain blocks the domain and all its subdomains.
  if (blocked.includes("/")) return false;
  return host === blocked || host.endsWith(`.${blocked}`);
}

export class Adblocker {
  private enabled = true;
  private customDomains: string[] = [];
  private customPatterns: string[] = [];
  private blockedCount = 0;
  private attached = false;

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  setCustomRules(raw: string) {
    const { domains, patterns } = parseCustomRules(raw ?? "");
    this.customDomains = domains;
    this.customPatterns = patterns;
  }

  get stats() {
    return { blocked: this.blockedCount };
  }

  resetStats() {
    this.blockedCount = 0;
  }

  shouldBlock(rawUrl: string): boolean {
    if (!this.enabled) return false;
    let host: string;
    let lower: string;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      host = parsed.hostname.toLowerCase();
      lower = rawUrl.toLowerCase();
    } catch {
      return false;
    }

    for (const d of this.customDomains) if (hostMatches(host, d)) return true;
    for (const p of this.customPatterns) if (lower.includes(p)) return true;

    for (const d of BLOCKED_DOMAINS) {
      if (d.includes("/")) {
        if (lower.includes(d)) return true;
      } else if (hostMatches(host, d)) {
        return true;
      }
    }
    for (const p of BLOCKED_PATTERNS) if (lower.includes(p)) return true;
    return false;
  }

  /** Attach the request filter to the browser panel's isolated session. */
  attach(partition: string): Session {
    const sess = session.fromPartition(partition);
    if (this.attached) return sess;
    this.attached = true;

    sess.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      // Never block the top-level page the user asked for — only subresources.
      if (details.resourceType === "mainFrame") {
        callback({ cancel: false });
        return;
      }
      if (this.shouldBlock(details.url)) {
        this.blockedCount++;
        callback({ cancel: true });
        return;
      }
      callback({ cancel: false });
    });

    return sess;
  }
}

export const adblocker = new Adblocker();
