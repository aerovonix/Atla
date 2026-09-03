import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { PopOutButton } from "./PopOutButton";
import { useBrowserStore } from "../state/browserStore";
import { CloseIcon, ShieldIcon, ArrowLeftIcon, ArrowRightIcon, RegenerateIcon, HomeIcon, SendIcon } from "./icons";

/** Electron's <webview> isn't in React's JSX types. */
interface WebviewElement extends HTMLElement {
  src: string;
  getURL: () => string;
  getTitle: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  loadURL: (url: string) => Promise<void>;
  executeJavaScript: (code: string) => Promise<unknown>;
}

const EXTRACT_TEXT = `(() => {
  const drop = ['script','style','noscript','svg','iframe'];
  const clone = document.body ? document.body.cloneNode(true) : null;
  if (!clone) return { title: document.title, url: location.href, text: '' };
  drop.forEach(tag => clone.querySelectorAll(tag).forEach(n => n.remove()));
  const text = (clone.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title, url: location.href, text };
})()`;

function findLinksScript(query: string) {
  const q = JSON.stringify(query.toLowerCase());
  return `(() => {
    const q = ${q};
    const out = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const t = (a.innerText || a.textContent || '').trim();
      if (!t) return;
      if (!q || t.toLowerCase().includes(q)) out.push({ text: t.slice(0, 120), href: a.href });
    });
    return { links: out.slice(0, 60) };
  })()`;
}

function clickScript(text: string) {
  const t = JSON.stringify(text.toLowerCase());
  return `(() => {
    const want = ${t};
    const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"]'));
    const exact = nodes.find(n => ((n.innerText || n.value || '').trim().toLowerCase()) === want);
    const partial = nodes.find(n => ((n.innerText || n.value || '').trim().toLowerCase()).includes(want));
    const el = exact || partial;
    if (!el) return { ok: false };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true };
  })()`;
}

function normalizeUrl(input: string, searchEngineUrl: string): string {
  const raw = input.trim();
  if (!raw) return "";
  // Any explicit scheme (http, https, file, ftp…) is already a URL.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  if (/^(about|data|blob|mailto):/i.test(raw)) return raw;
  if (raw.includes(" ")) return toSearch(raw, searchEngineUrl);
  // localhost / IPs default to http, bare domains to https.
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(raw)) return `http://${raw}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(raw)) return `http://${raw}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(raw)) return `https://${raw}`;
  return toSearch(raw, searchEngineUrl);
}

function toSearch(query: string, searchEngineUrl: string): string {
  return searchEngineUrl.includes("%s")
    ? searchEngineUrl.replace("%s", encodeURIComponent(query))
    : `${searchEngineUrl}${encodeURIComponent(query)}`;
}

export function BrowserPanel({ onSendPageToChat }: { onSendPageToChat: (info: { url: string; title: string; text: string }) => void }) {
  const settings = useStore((s) => s.settings);
  const {
    open,
    setOpen,
    currentUrl,
    currentTitle,
    loading,
    blocked,
    setPage,
    setLoading,
    setBlocked,
    requestedUrl,
    consumeRequestedUrl
  } = useBrowserStore();

  /**
   * Extra tabs beyond the main one.
   *
   * The model kept losing a page the moment it opened the next, so research
   * meant re-navigating — which is what actually trips rate limits. Extra
   * webviews stay mounted and loaded in the background; only the active one
   * is visible. Tab 0 is the original webview, so the single-tab path is
   * exactly what it always was.
   */
  const [tabIds, setTabIds] = useState<string[]>(["main"]);
  const [activeTab, setActiveTab] = useState("main");
  const extraRefs = useRef<Map<string, WebviewElement>>(new Map());
  const mainRef = useRef<WebviewElement | null>(null);

  /** The webview a command should act on. */
  const webviewRef = useRef<WebviewElement | null>(null);
  useEffect(() => {
    webviewRef.current = activeTab === "main" ? mainRef.current : extraRefs.current.get(activeTab) ?? null;
  }, [activeTab, tabIds]);
  const [partition, setPartition] = useState<string | null>(null);
  /** Host whose page came back empty under lightning, if any. */
  const [blankHost, setBlankHost] = useState<string | null>(null);
  const speed = useStore((st) => st.settings.browserSpeed);
  // Read inside a listener that outlives the render it was created in.
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  /** src for a tab that has been asked for but not yet mounted. */
  const pendingSrc = useRef<Map<string, string>>(new Map());
  const [address, setAddress] = useState("");
  const [ready, setReady] = useState(false);
  // Mirrored into state because calling canGoBack() before dom-ready throws.
  const [nav, setNav] = useState({ back: false, forward: false });

  useEffect(() => {
    void window.atla.browser.partition().then(setPartition);
  }, []);

  // Tells main whether a person can actually see the page. With the panel
  // closed the model is driving and nothing is rendered for anyone, so images,
  // fonts and video are skipped entirely — the single biggest saving there is,
  // and it costs nothing visually because there is no viewer.
  useEffect(() => {
    window.atla.browser.setVisible?.(open);
  }, [open]);

  /** Wait for the current navigation to settle before reading the DOM. */
  const waitForLoad = useCallback((timeoutMs = 30000) => {
    const wv = webviewRef.current;
    if (!wv) return Promise.reject(new Error("Browser panel isn't ready yet."));
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        wv.removeEventListener("did-stop-loading", finish);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      wv.addEventListener("did-stop-loading", finish);
    });
  }, []);

  const readPage = useCallback(async () => {
    const wv = webviewRef.current;
    if (!wv) throw new Error("Browser panel isn't ready yet.");
    const info = (await wv.executeJavaScript(EXTRACT_TEXT)) as { title: string; url: string; text: string };
    return info;
  }, []);

  /**
   * Wait for navigation to finish, then give the page a beat to paint before
   * scraping — client-rendered pages (and restored history entries) are still
   * empty the instant did-stop-loading fires.
   */
  const settleAndRead = useCallback(
    async (timeoutMs = 30000) => {
      await waitForLoad(timeoutMs);
      await new Promise((r) => setTimeout(r, 400));
      return readPage();
    },
    [readPage, waitForLoad]
  );

  const navigate = useCallback(
    async (rawUrl: string) => {
      const wv = webviewRef.current;
      if (!wv) throw new Error("Browser panel isn't ready yet.");
      const url = normalizeUrl(rawUrl, settings.searchEngineUrl);
      if (!url) throw new Error("Empty URL.");
      setOpen(true);
      setLoading(true);
      const settled = settleAndRead();
      await wv.loadURL(url).catch(() => {
        /* navigation errors surface via did-stop-loading + page content */
      });
      return settled;
    },
    [settleAndRead, setLoading, setOpen, settings.searchEngineUrl]
  );

  // Wire the main-process RPC (this is how the AI drives the browser).
  useEffect(() => {
    if (!ready) return;
    const unsub = window.atla.browser.onRpcRequest(async (req) => {
      const respond = (ok: boolean, result?: unknown, error?: string) =>
        window.atla.browser.respond({ id: req.id, ok, result, error });
      try {
        const wv = webviewRef.current;
        if (!wv) throw new Error("Browser panel isn't ready yet.");
        switch (req.method) {
          case "navigate":
            respond(true, await navigate(String(req.params.url ?? "")));
            break;
          case "readPage":
            setOpen(true);
            respond(true, await readPage());
            break;
          case "click": {
            setOpen(true);
            const res = (await wv.executeJavaScript(clickScript(String(req.params.text ?? "")))) as { ok: boolean };
            if (!res.ok) throw new Error(`No link or button matching "${req.params.text}".`);
            setLoading(true);
            respond(true, await settleAndRead(15000));
            break;
          }
          case "findLinks":
            respond(true, await wv.executeJavaScript(findLinksScript(String(req.params.query ?? ""))));
            break;
          case "goBack": {
            setOpen(true);
            if (!wv.canGoBack()) throw new Error("Nothing to go back to.");
            setLoading(true);
            const settled = settleAndRead(15000);
            wv.goBack();
            respond(true, await settled);
            break;
          }
          case "currentUrl":
            respond(true, { url: wv.getURL() });
            break;
          case "openTab": {
            const id = `tab-${Date.now().toString(36)}`;
            setTabIds((t) => [...t, id]);
            setActiveTab(id);
            // The element doesn't exist until React commits, so the src is
            // handed over once it mounts rather than navigated here.
            pendingSrc.current.set(id, String(req.params.url ?? "about:blank"));
            respond(true, { id });
            break;
          }
          case "listTabs": {
            const rows = tabIds.map((id) => {
              const el = id === "main" ? mainRef.current : extraRefs.current.get(id);
              return { id, url: el?.getURL() ?? "", active: id === activeTab };
            });
            respond(true, { tabs: rows });
            break;
          }
          case "switchTab": {
            const id = String(req.params.id ?? "");
            if (!tabIds.includes(id)) throw new Error(`No tab "${id}".`);
            setActiveTab(id);
            setOpen(true);
            const el = id === "main" ? mainRef.current : extraRefs.current.get(id);
            respond(true, { id, url: el?.getURL() ?? "" });
            break;
          }
          case "closeTab": {
            const id = String(req.params.id ?? "");
            // The main tab is the panel itself; closing it would leave the
            // user looking at nothing with no way back.
            if (id === "main") throw new Error("The first tab can't be closed.");
            if (!tabIds.includes(id)) throw new Error(`No tab "${id}".`);
            extraRefs.current.delete(id);
            setTabIds((t) => t.filter((x) => x !== id));
            setActiveTab((a) => (a === id ? "main" : a));
            respond(true, { closed: id });
            break;
          }
          default:
            throw new Error(`Unknown browser command "${req.method}".`);
        }
      } catch (err) {
        respond(false, undefined, err instanceof Error ? err.message : String(err));
      }
    });
    window.atla.browser.signalReady();
    return unsub;
  }, [ready, navigate, readPage, settleAndRead, setLoading, setOpen, tabIds, activeTab]);

  // "Open in browser" from a tool card, once the webview can actually take it.
  useEffect(() => {
    if (!requestedUrl || !ready) return;
    void navigate(requestedUrl);
    consumeRequestedUrl();
  }, [requestedUrl, ready, navigate, consumeRequestedUrl]);

  // Track webview lifecycle + refresh the adblock counter.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !partition) return;

    /**
     * Lightning blocks scripts, which renders some sites completely blank.
     * Rather than let that look like a broken browser, measure what actually
     * came out and offer the page its scripts back.
     *
     * Only the rendered text is measured, because that is the thing the
     * person came for. A page can be visually busy and still have nothing to
     * read, and it is the nothing-to-read case that needs rescuing.
     */
    const checkForBlankPage = async (view: WebviewElement) => {
      if (speedRef.current !== "lightning") return setBlankHost(null);
      try {
        const url = view.getURL();
        if (!/^https?:/.test(url)) return setBlankHost(null);
        const raw = await view.executeJavaScript(
          "(document.body && document.body.innerText || '').trim().length"
        );
        const len = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(len)) return setBlankHost(null);
        // Short enough that there is plainly nothing to read. Cookie notices
        // and "enable JavaScript" messages land well under this.
        setBlankHost(len < 200 ? new URL(url).hostname : null);
      } catch {
        // A page that refuses inspection is not evidence of blankness.
        setBlankHost(null);
      }
    };

    const syncNav = () => {
      try {
        setNav({ back: wv.canGoBack(), forward: wv.canGoForward() });
      } catch {
        /* not attached yet */
      }
    };
    const onDomReady = () => {
      setReady(true);
      syncNav();
    };
    const onStart = () => {
      setLoading(true);
      setBlankHost(null);
    };
    const onStop = () => {
      setLoading(false);
      try {
        setPage(wv.getURL(), wv.getTitle());
        setAddress(wv.getURL());
      } catch {
        /* not attached yet */
      }
      syncNav();
      void window.atla.browser.stats().then((s) => setBlocked(s.blocked));
      void checkForBlankPage(wv);
    };
    wv.addEventListener("dom-ready", onDomReady);
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    return () => {
      wv.removeEventListener("dom-ready", onDomReady);
      wv.removeEventListener("did-start-loading", onStart);
      wv.removeEventListener("did-stop-loading", onStop);
    };
  }, [partition, setBlocked, setLoading, setPage]);

  if (!partition) return null;

  const wv = webviewRef.current;
  const PANEL_WIDTH = 520;

  return (
    // The webview must stay attached to the DOM to work, so when the panel is
    // "closed" we collapse the outer width and clip it rather than unmounting
    // or display:none-ing it — otherwise the model couldn't browse in the
    // background and every command would fail with "not attached".
    <div
      className="h-full flex flex-col border-l border-border bg-bg overflow-hidden shrink-0"
      style={{ width: open ? PANEL_WIDTH : 0, borderLeftWidth: open ? 1 : 0 }}
    >
      <div className="h-[52px] shrink-0 flex items-center gap-1.5 px-2 border-b border-borderLight" style={{ width: PANEL_WIDTH }}>
        <button
          onClick={() => nav.back && wv?.goBack()}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-secondary hover:bg-hover disabled:opacity-30"
          disabled={!nav.back}
          title="Back"
        >
          <ArrowLeftIcon width={15} height={15} />
        </button>
        <button
          onClick={() => nav.forward && wv?.goForward()}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-secondary hover:bg-hover disabled:opacity-30"
          disabled={!nav.forward}
          title="Forward"
        >
          <ArrowRightIcon width={15} height={15} />
        </button>
        <button
          onClick={() => (loading ? wv?.stop() : wv?.reload())}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-secondary hover:bg-hover"
          title={loading ? "Stop" : "Reload"}
        >
          {loading ? <CloseIcon width={14} height={14} /> : <RegenerateIcon width={14} height={14} />}
        </button>
        <button
          onClick={() => void navigate(settings.browserHomepage)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-secondary hover:bg-hover"
          title="Home"
        >
          <HomeIcon width={15} height={15} />
        </button>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void navigate(address);
          }}
          placeholder="Search or enter address"
          className="flex-1 min-w-0 px-3 py-1.5 rounded-full text-xs border border-border bg-input outline-none"
        />
        <PopOutButton pane="browser" />
        <button
          onClick={() => setOpen(false)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-secondary hover:bg-hover"
          title="Close browser"
        >
          <CloseIcon width={15} height={15} />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative bg-white" style={{ width: PANEL_WIDTH }}>
        {blankHost && (
          <div
            className="absolute inset-x-0 top-0 z-20 px-3 py-2 flex items-center gap-3 secret-reveal"
            style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
          >
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium">This page needs scripts to show anything</div>
              <div className="text-[11px] text-secondary truncate">
                Lightning blocked them. {blankHost} will stay light otherwise.
              </div>
            </div>
            <button
              onClick={async () => {
                await window.atla.browser.allowScripts(blankHost);
                setBlankHost(null);
                webviewRef.current?.reload();
              }}
              className="shrink-0 text-[12px] px-3 py-1.5 rounded-full border border-border hover:bg-hover transition-colors"
            >
              Load scripts
            </button>
          </div>
        )}
        {/* <webview> is an Electron built-in; typed in global.d.ts */}
        {tabIds.map((id) => (
          <webview
            key={id}
            ref={((el: WebviewElement | null) => {
              if (id === "main") mainRef.current = el;
              else if (el) extraRefs.current.set(id, el);
              if (id === activeTab) webviewRef.current = el;
            }) as never}
            partition={partition}
            src={id === "main" ? settings.browserHomepage : pendingSrc.current.get(id) ?? "about:blank"}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              // Kept mounted rather than unmounted so a background tab stays
              // loaded; display:none would stop it rendering entirely.
              display: "inline-flex",
              visibility: id === activeTab ? "visible" : "hidden",
              zIndex: id === activeTab ? 1 : 0
            }}
            // Sandboxed: the page cannot reach Node or this app's preload.
            webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no"
          />
        ))}
      </div>

      <div
        className="h-9 shrink-0 flex items-center justify-between px-3 border-t border-borderLight text-[11px] text-secondary"
        style={{ width: PANEL_WIDTH }}
      >
        <span className="flex items-center gap-1.5" style={{ color: settings.adblockEnabled ? "var(--accent)" : undefined }}>
          <ShieldIcon width={12} height={12} />
          {settings.adblockEnabled ? `${blocked} blocked` : "Adblock off"}
        </span>
        <button
          onClick={async () => {
            try {
              const info = await readPage();
              onSendPageToChat(info);
            } catch {
              /* nothing loaded yet */
            }
          }}
          className="flex items-center gap-1.5 px-2 py-1 rounded-full border border-border hover:bg-hover transition-colors"
          title="Attach this page's text to the chat"
        >
          <SendIcon width={11} height={11} /> Send page to chat
        </button>
      </div>
    </div>
  );
}
