/**
 * Branch bookkeeping.
 *
 * A branch is a copy of a conversation up to a chosen message, not a pointer
 * into it — editing or deleting a message in one side must never reach into
 * the other. The only link kept is `branchedFrom` on the child, so the tree is
 * derived rather than stored, and deleting a parent leaves working orphans
 * instead of dangling references.
 *
 * Pure so the self-test can cover the tree shape without a store.
 */

import type { Conversation } from "./types.js";

export interface BranchNode {
  id: string;
  title: string;
  /** Distance from the root, used only for indentation. */
  depth: number;
  /** The message this one was split at, when it isn't the root. */
  atMessageId?: string;
  messageCount: number;
  updatedAt: number;
}

/** Walks up to the furthest ancestor still present. An orphan is its own root. */
export function rootOf(conversations: Conversation[], id: string): string {
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    // A cycle can't happen through the UI, but a hand-edited store file could
    // produce one, and hanging the app is a worse failure than ignoring it.
    if (seen.has(current)) return current;
    seen.add(current);
    const parent = byId.get(current)?.branchedFrom?.conversationId;
    if (!parent || !byId.has(parent)) return current;
    current = parent;
  }
}

/** Direct children of a conversation, oldest split first. */
export function childrenOf(conversations: Conversation[], id: string): Conversation[] {
  return conversations
    .filter((c) => c.branchedFrom?.conversationId === id)
    .sort((a, b) => (a.branchedFrom?.at ?? 0) - (b.branchedFrom?.at ?? 0));
}

/**
 * The whole tree the given chat belongs to, flattened depth-first for display.
 * Returns [] when the chat has no relatives at all, which is how the UI knows
 * to hide the branch control rather than show a list of one.
 */
export function branchTree(conversations: Conversation[], id: string): BranchNode[] {
  const root = rootOf(conversations, id);
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const out: BranchNode[] = [];

  const walk = (nodeId: string, depth: number) => {
    const conv = byId.get(nodeId);
    if (!conv) return;
    out.push({
      id: conv.id,
      title: conv.title,
      depth,
      atMessageId: conv.branchedFrom?.messageId,
      messageCount: conv.messages.length,
      updatedAt: conv.updatedAt
    });
    for (const child of childrenOf(conversations, nodeId)) walk(child.id, depth + 1);
  };
  walk(root, 0);

  return out.length > 1 ? out : [];
}

/** True when this chat is part of a tree — i.e. worth showing the control for. */
export function hasBranches(conversations: Conversation[], id: string): boolean {
  return branchTree(conversations, id).length > 0;
}

/**
 * How many messages of `conv` came from the branch point, so the UI can mark
 * where shared history ends and this branch's own history begins.
 */
export function sharedPrefixLength(conversations: Conversation[], conv: Conversation): number {
  const origin = conv.branchedFrom;
  if (!origin) return 0;
  const parent = conversations.find((c) => c.id === origin.conversationId);
  if (!parent) return 0;
  const idx = parent.messages.findIndex((m) => m.id === origin.messageId);
  return idx === -1 ? 0 : idx + 1;
}
