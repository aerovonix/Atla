import { useState } from "react";
import { useStore } from "../state/store";
import { MoreIcon, PlusIcon, SearchIcon, SettingsIcon, ChevronDownIcon } from "./icons";
import { AtlaMark } from "./AtlaMark";

/** A collapsible sidebar section header. */
function SectionHeader({
  label,
  count,
  open,
  onToggle,
  action
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 pr-1">
      <button
        onClick={onToggle}
        className="flex-1 flex items-center gap-1.5 px-2 py-2 rounded-lg text-left hover:bg-hover transition-colors"
      >
        <ChevronDownIcon open={open} width={11} height={11} className="text-secondary shrink-0" />
        <span className="text-xs font-semibold tracking-wide uppercase text-secondary">{label}</span>
        <span className="text-[11px] px-1.5 rounded-full bg-input text-secondary">{count}</span>
      </button>
      {action}
    </div>
  );
}

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const conversations = useStore((s) => s.conversations);
  const projects = useStore((s) => s.projects);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const settings = useStore((s) => s.settings);
  const newConversation = useStore((s) => s.newConversation);
  const selectConversation = useStore((s) => s.selectConversation);
  const deleteConversation = useStore((s) => s.deleteConversation);
  const renameConversation = useStore((s) => s.renameConversation);
  const moveToProject = useStore((s) => s.moveToProject);
  const createProject = useStore((s) => s.createProject);

  const [search, setSearch] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showProjects, setShowProjects] = useState(true);
  const [showChats, setShowChats] = useState(true);

  const filtered = conversations.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q));
  });
  const ungrouped = filtered.filter((c) => !c.projectId);

  const newProject = () => {
    const name = window.prompt("Project name:");
    if (name && name.trim()) createProject(name.trim());
  };

  return (
    <div className="w-[280px] shrink-0 h-full flex flex-col bg-sidebar border-r border-border">
      <div className="p-3 pb-2">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary">
            <SearchIcon width={15} height={15} />
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="w-full pl-9 pr-3 py-2.5 rounded-full text-sm outline-none border border-border bg-input text-text"
          />
        </div>
      </div>

      <div className="px-3 pb-3">
        <button onClick={() => newConversation()} className="bevel w-full py-2.5 rounded-full font-medium text-sm">
          <PlusIcon width={15} height={15} /> New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-4">
        <div>
          <SectionHeader
            label="Projects"
            count={projects.length}
            open={showProjects}
            onToggle={() => setShowProjects((o) => !o)}
            action={
              <button onClick={newProject} className="text-xs px-2 py-1 rounded-full font-medium bg-input shrink-0">
                New
              </button>
            }
          />
          {showProjects && (
            <div className="space-y-2">
              {projects.length === 0 && (
                <div className="px-3 py-3 text-xs rounded-xl border border-dashed border-border text-center text-secondary">
                  No projects yet. Group chats by topic.
                </div>
              )}
              {projects.map((p) => {
                const open = expanded[p.id] ?? true;
                const chats = filtered.filter((c) => c.projectId === p.id);
                return (
                  <div key={p.id} className="rounded-xl overflow-hidden border border-border bg-input">
                    <button
                      onClick={() => setExpanded((e) => ({ ...e, [p.id]: !open }))}
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
                    >
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                      <span className="flex-1 text-sm font-medium truncate">{p.name}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-bg text-secondary">{chats.length}</span>
                      <ChevronDownIcon open={open} width={12} height={12} />
                    </button>
                    {open && (
                      <div className="px-2 pb-2 space-y-1">
                        {chats.length === 0 && <div className="px-3 py-2 text-xs text-secondary">No chats here</div>}
                        {chats.map((c) => (
                          <div
                            key={c.id}
                            onClick={() => selectConversation(c.id)}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer"
                            style={{ backgroundColor: activeConversationId === c.id ? "var(--bg)" : "transparent" }}
                          >
                            <div className="text-sm truncate flex-1">{c.title}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <SectionHeader
            label="Chats"
            count={ungrouped.length}
            open={showChats}
            onToggle={() => setShowChats((o) => !o)}
          />
          {showChats && (
            <div className="space-y-1">
              {ungrouped.length === 0 && (
                <div className="px-3 py-6 text-sm text-center rounded-xl text-secondary bg-input">No conversations</div>
              )}
              {ungrouped.map((c) => (
                <div
                  key={c.id}
                  onClick={() => selectConversation(c.id)}
                  className="group relative flex items-center gap-2 pl-4 pr-3 py-2.5 rounded-xl cursor-pointer transition-colors"
                  style={{
                    backgroundColor: activeConversationId === c.id ? "var(--accent-soft)" : "transparent"
                  }}
                >
                  {/* A short rounded pill, inset from the edge. An inset box-shadow
                      here instead gets bent around the 12px radius into a crescent. */}
                  {activeConversationId === c.id && (
                    <span
                      className="absolute left-1.5 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full"
                      style={{ backgroundColor: "var(--accent)" }}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate leading-tight">{c.title}</div>
                    <div className="text-xs truncate text-secondary">
                      {c.messages.length === 0 ? "No messages" : `${c.messages.length} messages`}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(menuFor === c.id ? null : c.id);
                      setMoveFor(null);
                    }}
                    className="w-7 h-7 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0 bg-bg text-secondary"
                  >
                    <MoreIcon width={13} height={13} />
                  </button>
                  {menuFor === c.id && (
                    <div
                      className="absolute right-2 top-10 w-48 rounded-xl shadow-xl border border-border py-1 z-50 overflow-hidden bg-bg"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => {
                          setRenaming({ id: c.id, title: c.title });
                          setMenuFor(null);
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-hover"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => setMoveFor(moveFor === c.id ? null : c.id)}
                        className="w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-hover"
                      >
                        Move to project <ChevronDownIcon open={moveFor === c.id} width={11} height={11} />
                      </button>
                      {moveFor === c.id && (
                        <div className="px-2 py-1 space-y-1 border-t border-border mt-1">
                          <button
                            onClick={() => {
                              moveToProject(c.id, null);
                              setMenuFor(null);
                            }}
                            className="w-full text-left px-2 py-1.5 text-xs rounded-lg hover:bg-hover"
                          >
                            No project
                          </button>
                          {projects.map((p) => (
                            <button
                              key={p.id}
                              onClick={() => {
                                moveToProject(c.id, p.id);
                                setMenuFor(null);
                              }}
                              className="w-full text-left px-2 py-1.5 text-xs rounded-lg flex items-center gap-2 hover:bg-hover"
                            >
                              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} /> {p.name}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="h-px my-1 bg-border" />
                      <button
                        onClick={() => {
                          deleteConversation(c.id);
                          setMenuFor(null);
                        }}
                        className="w-full text-left px-3 py-2 text-sm text-red-500"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="p-3 border-t border-border space-y-2 shrink-0">
        <button
          onClick={onOpenSettings}
          className="bevel bevel-sm w-full !justify-start gap-3 px-3 py-2.5 rounded-xl text-sm font-medium"
        >
          <SettingsIcon width={16} height={16} /> Settings
        </button>
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-input">
          <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-hover border border-border">
            <AtlaMark size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium leading-none truncate">{settings.profileName?.trim() || "You"}</div>
            <div className="text-xs text-secondary">Atla · by Aerovonix</div>
          </div>
        </div>
      </div>

      {renaming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setRenaming(null)} />
          <div className="relative w-full max-w-[380px] rounded-2xl p-5 shadow-2xl border border-border bg-bg">
            <h3 className="font-semibold mb-3">Rename conversation</h3>
            <input
              autoFocus
              value={renaming.title}
              onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameConversation(renaming.id, renaming.title);
                  setRenaming(null);
                }
                if (e.key === "Escape") setRenaming(null);
              }}
              className="w-full px-3 py-2.5 rounded-xl border border-border outline-none text-sm bg-input"
            />
            <div className="flex gap-2 mt-4 justify-end">
              <button onClick={() => setRenaming(null)} className="px-4 py-2 rounded-full text-sm font-medium bg-input">
                Cancel
              </button>
              <button
                onClick={() => {
                  renameConversation(renaming.id, renaming.title);
                  setRenaming(null);
                }}
                className="px-4 py-2 rounded-full text-sm font-medium bg-text text-bg"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {(menuFor || moveFor) && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => {
            setMenuFor(null);
            setMoveFor(null);
          }}
        />
      )}
    </div>
  );
}
