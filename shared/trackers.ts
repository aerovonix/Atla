/**
 * The tracker blocklist.
 *
 * Curated rather than pulled from EasyList, for two reasons: a filter-list
 * parser is a dependency and a moving target, and a hand-picked list can be
 * held to a rule a generated one can't — **nothing here may break a page.**
 *
 * That rule is why infrastructure is conspicuously absent. `gstatic.com`,
 * `ajax.googleapis.com`, `fonts.googleapis.com` and `cloudfront.net` carry
 * real page content; blocking them to spite Google would leave sites visibly
 * broken, which is the opposite of the point. Analytics and ad-serving hosts
 * are separate from those, and those are what's listed.
 *
 * Matching is by domain suffix, so one entry covers every subdomain:
 * "doubleclick.net" also catches "stats.g.doubleclick.net".
 */

export const TRACKER_DOMAINS: readonly string[] = [
  // ---- Google: ads and measurement ---------------------------------------
  // Deliberately not gstatic/googleapis — those serve fonts, jQuery and
  // images that pages genuinely need.
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "googlesyndication.com",
  "googleadservices.com",
  "doubleclick.net",
  "doubleclickbygoogle.com",
  "2mdn.net",
  "app-measurement.com",
  "adservice.google.com",
  "pagead2.googlesyndication.com",
  "analytics.google.com",
  "googleoptimize.com",
  "google-analytics.l.google.com",
  "ampcid.google.com",
  "crashlytics.com",
  "firebaselogging-pa.googleapis.com",
  "firebase-settings.crashlytics.com",

  // ---- Meta ---------------------------------------------------------------
  "connect.facebook.net",
  "graph.facebook.com",
  "pixel.facebook.com",
  "an.facebook.com",
  "business.facebook.com",
  "atdmt.com",

  // ---- Microsoft / Bing / LinkedIn ---------------------------------------
  "clarity.ms",
  "bat.bing.com",
  "c.bing.com",
  "px.ads.linkedin.com",
  "analytics.pointdrive.linkedin.com",

  // ---- Product analytics and session replay ------------------------------
  // Session replay is the aggressive category: it records what you type and
  // where you move the pointer.
  "hotjar.com",
  "hotjar.io",
  "fullstory.com",
  "logrocket.com",
  "logrocket.io",
  "mouseflow.com",
  "smartlook.com",
  "inspectlet.com",
  "luckyorange.com",
  "luckyorange.net",
  "crazyegg.com",
  "sessioncam.com",
  "quantummetric.com",
  "contentsquare.net",
  "clicktale.net",
  "decibelinsight.net",
  "glassboxdigital.io",

  "mixpanel.com",
  "amplitude.com",
  "segment.com",
  "segment.io",
  "heapanalytics.com",
  "kissmetrics.com",
  "kissmetrics.io",
  "statcounter.com",
  "quantserve.com",
  "quantcount.com",
  "scorecardresearch.com",
  "chartbeat.com",
  "chartbeat.net",
  "parsely.com",
  "parse.ly",
  "newrelic.com",
  "nr-data.net",
  "mparticle.com",
  "branch.io",
  "adjust.com",
  "appsflyer.com",
  "kochava.com",
  "singular.net",
  "tealiumiq.com",
  "krxd.net",
  "demdex.net",
  "omtrdc.net",
  "2o7.net",
  "everesttech.net",
  "adobedtm.com",

  // ---- Ad exchanges and RTB ----------------------------------------------
  "adnxs.com",
  "adsrvr.org",
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "casalemedia.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "taboolasyndication.com",
  "outbrain.com",
  "zemanta.com",
  "sharethrough.com",
  "triplelift.com",
  "smartadserver.com",
  "adform.net",
  "adroll.com",
  "rlcdn.com",
  "bidswitch.net",
  "lijit.com",
  "sovrn.com",
  "indexww.com",
  "33across.com",
  "gumgum.com",
  "media.net",
  "yieldmo.com",
  "districtm.io",
  "improvedigital.com",
  "spotxchange.com",
  "spotx.tv",
  "teads.tv",
  "unrulymedia.com",
  "moatads.com",
  "adsafeprotected.com",
  "doubleverify.com",
  "serving-sys.com",
  "flashtalking.com",
  "mathtag.com",
  "bluekai.com",
  "agkn.com",
  "tapad.com",
  "crwdcntrl.net",
  "exelator.com",
  "eyeota.net",
  "id5-sync.com",
  "pippio.com",
  "liadm.com",
  "onaudience.com",
  "zqtk.net",
  "adotmob.com",
  "themoneytizer.com",
  "revcontent.com",
  "mgid.com",
  "adskeeper.com",
  "propellerads.com",
  "popads.net",
  "poptm.com",
  "adcash.com",
  "exoclick.com",
  "juicyads.com",
  "trafficjunky.net",

  // ---- Consent walls and tag managers ------------------------------------
  // These slow every page down and exist to run the above.
  "onetrust.com",
  "cookielaw.org",
  "cookiebot.com",
  "trustarc.com",
  "quantcast.mgr.consensu.org",
  "usercentrics.eu",
  "privacy-mgmt.com",
  "sourcepoint.mgr.consensu.org",
  "ensighten.com",
  "tiqcdn.com",

  // ---- Error and performance beacons -------------------------------------
  // Useful to site owners, irrelevant to a reader, and chatty.
  "bugsnag.com",
  "rollbar.com",
  "trackjs.com",
  "raygun.io",
  "loggly.com",
  "mixpanel-proxy.com",
  "pendo.io",
  "intercom.io",
  "drift.com",
  "driftt.com",
  "walkme.com",
  "optimizely.com",
  "vwo.com",
  "visualwebsiteoptimizer.com",
  "abtasty.com",
  "dynamicyield.com",
  "monetate.net",

  // ---- Social widgets that phone home ------------------------------------
  "addthis.com",
  "addtoany.com",
  "sharethis.com",
  "disqus.com/embed/comments/count",
  "po.st",

  // ---- Misc high-volume beacons ------------------------------------------
  "cxense.com",
  "permutive.com",
  "onesignal.com",
  "braze.com",
  "iterable.com",
  "customer.io",
  "klaviyo.com",
  "hs-analytics.net",
  "hsforms.net",
  "hubspot.com",
  "marketo.net",
  "mktoresp.com",
  "pardot.com",
  "eloqua.com",
  "yandex.ru/metrika",
  "mc.yandex.ru",
  "top-fwz1.mail.ru",
  "vk.com/rtrg",
  "hm.baidu.com",
  "cnzz.com",
  "umeng.com",
  "talkingdata.com"
];

/**
 * Path fragments that identify tracking regardless of host — first-party
 * analytics endpoints proxied through the site's own domain, which a domain
 * list can never catch.
 */
export const TRACKER_PATTERNS: readonly string[] = [
  "/pagead/",
  "/googleads",
  "/gtm.js",
  "/gtag/js",
  "/analytics.js",
  "/ga.js",
  "/fbevents.js",
  "/fbq.js",
  "/collect?v=",
  "/g/collect",
  "/j/collect",
  "/pixel.gif",
  "/track.gif",
  "/beacon.gif",
  "/__utm.gif",
  "/piwik.php",
  "/matomo.php",
  "/hotjar-",
  "/prebid",
  "/adsbygoogle",
  "/doubleclick",
  "/ad-choices",
  "/openrtb2/"
];

/**
 * Hosts rescued from the rules above.
 *
 * Some of these sit on a blocked domain but serve content a page actually
 * needs. Without them, blocking the parent would visibly break sites — which
 * is the one thing this list is not allowed to do.
 */
export const TRACKER_ALLOW: readonly string[] = [
  // Serves the video player and thumbnails, not tracking.
  "www.googletagmanager.com/gtag/destination",
  // Facebook's CDN for actual images.
  "scontent.xx.fbcdn.net",
  // Disqus proper still works; only the count beacon is blocked above.
  "disqus.com",
  "c.disquscdn.com"
];
