/**
 * AgentsPanel (Brain integration layer): "JJ's team", the agent swarm JJ leads, live from the
 * brain's `swarm.activity`. Each agent: a state dot (pulsing while active), its name, role and
 * what it is doing now. On JJ's screen it is a large panel at the right; elsewhere a compact
 * corner card. Key A (or the header) collapses / expands it; the choice is remembered.
 */
import { useEffect, useState } from "react";
import { AudioLines, Camera, ChevronDown, ChevronUp, Ear, FileText, Gavel, ScanLine, type LucideIcon } from "lucide-react";
import type { DownlinkPayload } from "@coach/protocol";

export type SwarmAgent = DownlinkPayload<"swarm.activity">["agents"][number];
export type SwarmAgentState = SwarmAgent["state"];

const ORDER: SwarmAgent["id"][] = ["jj", "listener", "director", "body", "reporter", "feedback"];
const ACTIVE = new Set<SwarmAgentState>(["listening", "watching", "thinking", "working", "speaking"]);
const ICONS: Record<SwarmAgent["id"], LucideIcon> = {
  jj: AudioLines, listener: Ear, director: Gavel, body: Camera, reporter: FileText, feedback: ScanLine,
};
const TONES: Record<SwarmAgentState, { dot: string; text: string; ring: string }> = {
  speaking: { dot: "bg-violet-400", text: "text-violet-200", ring: "border-violet-400/50 bg-violet-500/15" },
  listening: { dot: "bg-emerald-400", text: "text-emerald-200", ring: "border-emerald-400/50 bg-emerald-500/10" },
  watching: { dot: "bg-sky-400", text: "text-sky-200", ring: "border-sky-400/50 bg-sky-500/10" },
  thinking: { dot: "bg-amber-400", text: "text-amber-200", ring: "border-amber-400/50 bg-amber-500/10" },
  working: { dot: "bg-cyan-400", text: "text-cyan-200", ring: "border-cyan-400/50 bg-cyan-500/10" },
  idle: { dot: "bg-zinc-400", text: "text-muted-foreground", ring: "border-border bg-secondary/40" },
  off: { dot: "bg-zinc-600", text: "text-muted-foreground/60", ring: "border-border/60 bg-transparent" },
  error: { dot: "bg-red-500", text: "text-red-300", ring: "border-red-500/50 bg-red-500/10" },
};

export interface AgentRow {
  id: SwarmAgent["id"]; name: string; role: string; state: SwarmAgentState; active: boolean; detail: string;
}

/** Pure: brain agents → panel rows, JJ first, in team order; "Listener · transcript + fillers" → name + role. */
export function agentRows(agents: readonly SwarmAgent[]): AgentRow[] {
  return [...agents]
    .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
    .map((a) => {
      const [name = a.id, ...rest] = a.label.split(" · ");
      return { id: a.id, name, role: rest.join(" · "), state: a.state, active: ACTIVE.has(a.state), detail: a.detail };
    });
}

const STORE_KEY = "brain.agentsPanel.collapsed";
function loadCollapsed(): boolean {
  try { return window.localStorage.getItem(STORE_KEY) === "1"; } catch { return false; }
}

/** Collapsed state shared by both layouts, toggled by key A (not while typing). */
function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = () => setCollapsed((c) => {
    try { window.localStorage.setItem(STORE_KEY, c ? "0" : "1"); } catch { /* private mode */ }
    return !c;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "a" && e.key !== "A") || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select,[contenteditable=true]")) return;
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [collapsed, toggle];
}

export function AgentsPanel({ agents, jjScreen }: { agents: readonly SwarmAgent[]; jjScreen: boolean }) {
  const [collapsed, toggle] = useCollapsed();
  const rows = agentRows(agents);
  if (!rows.length) return null;
  if (!jjScreen) return <TeamCorner rows={rows} collapsed={collapsed} onToggle={toggle} />;
  return (
    <>
      <TeamHero rows={rows} collapsed={collapsed} onToggle={toggle} className="hidden xl:block" />
      <TeamCorner rows={rows} collapsed={collapsed} onToggle={toggle} className="xl:hidden" />
    </>
  );
}

function Dot({ state, size = "sm" }: { state: SwarmAgentState; size?: "sm" | "lg" }) {
  const s = size === "lg" ? "h-2.5 w-2.5" : "h-2 w-2";
  return (
    <span className={`relative inline-flex shrink-0 ${s}`} data-state={state}>
      {ACTIVE.has(state) && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-70 ${TONES[state].dot}`} />}
      <span className={`relative inline-flex rounded-full ${s} ${TONES[state].dot}`} />
    </span>
  );
}

function Header({ rows, collapsed, onToggle, big }: { rows: AgentRow[]; collapsed: boolean; onToggle: () => void; big?: boolean }) {
  const active = rows.filter((r) => r.active).length;
  return (
    <button type="button" onClick={onToggle} title="Show / hide JJ's team (A)"
      className="pointer-events-auto flex w-full items-center gap-2 text-left">
      <span className={`font-sans font-semibold text-foreground ${big ? "text-base" : "text-xs"}`}>JJ's team</span>
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{active ? `${active} active` : "standing by"}</span>
      {collapsed && <span className="ml-1 flex gap-1">{rows.map((r) => <Dot key={r.id} state={r.state} />)}</span>}
      <span className="ml-auto text-muted-foreground">{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
    </button>
  );
}

/** Compact card for the corner of every screen. */
export function TeamCorner({ rows, collapsed, onToggle, className = "" }: { rows: AgentRow[]; collapsed: boolean; onToggle: () => void; className?: string }) {
  return (
    <div className={`absolute bottom-16 right-4 w-72 rounded-xl border border-border bg-card/85 px-3 py-2 shadow-xl backdrop-blur ${className}`}
      data-testid="agents-corner">
      <Header rows={rows} collapsed={collapsed} onToggle={onToggle} />
      {!collapsed && (
        <ul className="mt-2 space-y-1.5">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2" data-agent={r.id}>
              <Dot state={r.state} />
              <span className={`w-16 shrink-0 font-sans text-[11px] font-medium ${r.state === "off" ? "text-muted-foreground/60" : "text-foreground"}`}>{r.name}</span>
              <span className={`truncate text-[10px] ${TONES[r.state].text}`} title={r.detail}>{r.detail || r.state}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Large panel on JJ's screen: JJ leads, the agents hang off it. */
export function TeamHero({ rows, collapsed, onToggle, className = "" }: { rows: AgentRow[]; collapsed: boolean; onToggle: () => void; className?: string }) {
  const [lead, ...team] = rows[0]?.id === "jj" ? rows : [undefined, ...rows];
  return (
    <div className={`absolute right-6 top-1/2 w-[21rem] -translate-y-1/2 rounded-2xl border border-border bg-card/70 p-5 shadow-2xl backdrop-blur-md ${className}`}
      data-testid="agents-hero">
      <Header rows={rows} collapsed={collapsed} onToggle={onToggle} big />
      {!collapsed && (
        <div className="mt-4">
          {lead && <HeroRow row={lead} lead />}
          <ul className="relative ml-[1.15rem] mt-1 space-y-1 border-l border-border/70 pl-4">
            {team.map((r) => r && <HeroRow key={r.id} row={r} />)}
          </ul>
          <p className="mt-4 text-[10px] uppercase tracking-widest text-muted-foreground/70">They share one board · JJ directs · A to hide</p>
        </div>
      )}
    </div>
  );
}

function HeroRow({ row, lead }: { row: AgentRow; lead?: boolean }) {
  const Icon = ICONS[row.id];
  const tone = TONES[row.state];
  const Tag = lead ? "div" : "li";
  return (
    <Tag className={`relative flex items-start gap-3 rounded-xl px-2 py-2 transition-colors ${row.active ? "bg-secondary/40" : ""}`} data-agent={row.id}>
      {!lead && <span className="absolute -left-4 top-[1.15rem] h-px w-3 bg-border/70" />}
      <span className={`flex shrink-0 items-center justify-center rounded-lg border ${tone.ring} ${lead ? "h-10 w-10" : "h-8 w-8"} ${row.state === "off" ? "opacity-50" : ""}`}>
        <Icon size={lead ? 18 : 15} className={tone.text} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={`font-sans font-medium ${lead ? "text-sm" : "text-[13px]"} ${row.state === "off" ? "text-muted-foreground" : "text-foreground"}`}>{row.name}</span>
          <span className="truncate text-[10px] text-muted-foreground">{row.role}</span>
          <span className={`ml-auto flex items-center gap-1.5 text-[10px] uppercase tracking-wider ${tone.text}`}><Dot state={row.state} size="lg" />{row.state}</span>
        </span>
        {row.detail && <span className={`mt-0.5 block line-clamp-2 text-[11px] leading-snug ${row.active ? "text-foreground/80" : "text-muted-foreground"}`}>{row.detail}</span>}
      </span>
    </Tag>
  );
}
