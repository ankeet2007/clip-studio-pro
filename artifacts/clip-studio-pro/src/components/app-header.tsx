import { Scissors, Plus, BarChart3, Settings, Clock } from "lucide-react";
import { useLocation } from "wouter";
import { useGetClipStats, getGetClipStatsQueryKey } from "@workspace/api-client-react";

interface AppHeaderProps {
  /** Optional extra controls rendered at the far right (rarely needed now). */
  children?: React.ReactNode;
}

const TABS: { label: string; path: string; icon: typeof Plus; match: (loc: string) => boolean }[] = [
  { label: "Create", path: "/", icon: Plus, match: (l) => l === "/" },
  { label: "Timeline", path: "/timeline", icon: BarChart3, match: (l) => l === "/timeline" || l.startsWith("/clips") },
  { label: "Settings", path: "/settings", icon: Settings, match: (l) => l === "/settings" },
];

export function AppHeader({ children }: AppHeaderProps) {
  const [location, navigate] = useLocation();

  const { data: stats, isError } = useGetClipStats({
    query: { queryKey: getGetClipStatsQueryKey(), refetchInterval: 5000 },
  });

  const active = stats ? stats.pending + stats.processing : 0;
  const online = !isError;

  return (
    <header className="shrink-0 sticky top-0 z-30 flex items-center gap-3 md:gap-4 px-4 md:px-6 py-3 border-b border-border bg-card/80 backdrop-blur-xl">
      {/* Brand */}
      <button
        onClick={() => navigate("/")}
        className="flex items-center gap-3 shrink-0 group"
        aria-label="Clip Studio Pro home"
      >
        <div className="w-9 h-9 rounded-lg flex items-center justify-center text-primary-foreground bg-gradient-to-br from-primary to-[#a9d600] shadow-[0_6px_18px_-4px_hsl(var(--primary)/0.5)] group-hover:brightness-105 transition">
          <Scissors className="w-5 h-5" strokeWidth={2.5} />
        </div>
        <div className="hidden sm:block text-left">
          <h1 className="font-extrabold tracking-tight leading-none flex items-center gap-2 text-sm">
            CLIP STUDIO
            <span className="font-mono text-[9px] font-semibold tracking-[0.16em] px-1.5 py-0.5 rounded text-[#b69dff] border border-[#9b7bff]/40 bg-[#9b7bff]/10">
              PRO
            </span>
          </h1>
          <p className="text-[9.5px] uppercase font-mono text-muted-foreground tracking-[0.18em] mt-1">
            Viral Shorts Factory
          </p>
        </div>
      </button>

      {/* Nav tabs */}
      <nav className="flex items-center gap-1 ml-1 md:ml-3">
        {TABS.map((t) => {
          const on = t.match(location);
          const Icon = t.icon;
          return (
            <button
              key={t.path}
              onClick={() => navigate(t.path)}
              className={`flex items-center gap-1.5 md:gap-2 rounded-lg px-2.5 md:px-3.5 py-2 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                on
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              <Icon className="w-3.5 h-3.5" strokeWidth={2} />
              <span className="hidden sm:inline">{t.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Queue chip — only when there is active work */}
      {active > 0 && (
        <div className="hidden sm:flex items-center gap-2 font-mono text-[10.5px] text-primary border border-primary/25 bg-primary/[0.06] px-3 py-1.5 rounded-full">
          <Clock className="w-3 h-3" strokeWidth={2.5} />
          {active} rendering
        </div>
      )}

      {/* Server status pill */}
      <div className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground border border-border bg-background/60 px-3 py-1.5 rounded-full">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            online
              ? "bg-green-500 shadow-[0_0_0_4px_rgba(34,197,94,0.15)] animate-pulse"
              : "bg-destructive shadow-[0_0_0_4px_rgba(239,68,68,0.15)]"
          }`}
        />
        <span className="hidden sm:inline">:3001</span> {online ? "online" : "offline"}
      </div>

      {children}
    </header>
  );
}
