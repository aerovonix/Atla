import { useStore } from "./store";
import type { DashConversation, DashMessage, DashRequest } from "../../shared/dashProtocol";

/**
 * Answers the web dash from the renderer, because the store lives here.
 *
 * Everything the dash can reach goes through this one function, which is the
 * point: the surface a remote device has is exactly what's listed below, not
 * "whatever the store exposes". Adding a capability here is a deliberate act.
 */

function handle(request: DashRequest): unknown {
  const state = useStore.getState();

  switch (request.type) {
    case "list": {
      const rows: DashConversation[] = state.conversations
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50)
        .map((c) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          messageCount: c.messages.length
        }));
      return rows;
    }

    case "open": {
      const conv = state.conversations.find((c) => c.id === request.conversationId);
      if (!conv) return [];
      const streamingIds = new Set(Object.values(state.streaming).map((s) => s.assistantMessageId));
      // Only the tail: a long chat over a phone connection is a lot of text
      // for a screen that shows the last few turns anyway.
      const rows: DashMessage[] = conv.messages.slice(-40).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        streaming: streamingIds.has(m.id)
      }));
      return rows;
    }

    case "send": {
      const text = request.text.trim();
      if (!text) return { ok: false };
      const conv = state.conversations.find((c) => c.id === request.conversationId);
      if (!conv) return { ok: false };
      state.sendMessage(conv.id, text, []);
      return { ok: true };
    }

    case "stop": {
      state.stopStreaming(request.conversationId);
      return { ok: true };
    }

    default:
      return null;
  }
}

/** Wires the bridge up once, at app start. Returns an unsubscribe. */
export function attachDashBridge(): () => void {
  const off = window.atla?.dash?.onRequest(({ id, request }) => {
    let payload: unknown = null;
    try {
      payload = handle(request);
    } catch {
      // A thrown handler would leave main waiting out its whole timeout, so
      // failures answer with null rather than silence.
      payload = null;
    }
    window.atla?.dash?.reply(id, payload);
  });
  return off ?? (() => undefined);
}
