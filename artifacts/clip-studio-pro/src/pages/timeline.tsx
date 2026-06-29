import { useState } from "react";
import {
  useListClips,
  useGetClipStats,
  getListClipsQueryKey,
  getGetClipStatsQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ClipRow } from "@/components/clip-row";
import { BarChart3, AlertTriangle, Scissors, RefreshCw } from "lucide-react";
import { AppHeader } from "@/components/app-header";

type Filter = "all" | "pending" | "processing" | "done" | "error";

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  pending: "Queued",
  processing: "Processing",
  done: "Done",
  error: "Error",
};

export default function Timeline() {
  const [filter, setFilter] = useState<Filter>("all");

  const { data: clips, isLoading: isLoadingClips, isError: isErrorClips } = useListClips({
    query: { queryKey: getListClipsQueryKey(), refetchInterval: 5000 },
  });

  const { data: stats, isLoading: isLoadingStats } = useGetClipStats({
    query: { queryKey: getGetClipStatsQueryKey(), refetchInterval: 5000 },
  });

  const filteredClips = filter === "all"
    ? clips
    : clips?.filter((c) => c.status === filter);

  const countFor = (f: Filter) =>
    f === "all" ? (clips?.length ?? 0) : (clips?.filter((c) => c.status === f).length ?? 0);

  const tiles: { key: Filter; label: string; value: number; cls: string }[] = [
    { key: "all", label: "Total", value: stats?.total ?? 0, cls: "text-foreground" },
    { key: "pending", label: "Queued", value: stats?.pending ?? 0, cls: "text-amber-400" },
    { key: "processing", label: "Processing", value: stats?.processing ?? 0, cls: "text-primary" },
    { key: "done", label: "Done", value: stats?.done ?? 0, cls: "text-green-500" },
    { key: "error", label: "Error", value: stats?.error ?? 0, cls: "text-destructive" },
  ];

  return (
    <div className="h-full bg-background text-foreground flex flex-col font-sans overflow-hidden">
      <AppHeader />

      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 md:px-8 py-6 md:py-8">
          {/* heading */}
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
            <BarChart3 className="w-4 h-4 text-primary" /> Render queue
          </p>
          <h2 className="text-2xl font-extrabold tracking-tight">Timeline</h2>
          <p className="text-sm text-muted-foreground mt-1 mb-6">
            Live status of every render job on the phone.
          </p>

          {/* stat tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
            {tiles.map((t) => (
              <button
                key={t.key}
                onClick={() => setFilter(t.key)}
                className={`text-left rounded-xl border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-4 transition-colors ${
                  filter === t.key ? "border-primary/40" : "border-border hover:border-border/80"
                }`}
              >
                <div className={`text-2xl font-extrabold tracking-tight leading-none ${t.cls}`}>
                  {isLoadingStats ? <Skeleton className="h-6 w-8 bg-muted" /> : t.value}
                </div>
                <div className="font-mono text-[9.5px] uppercase tracking-[0.13em] text-muted-foreground mt-2">{t.label}</div>
              </button>
            ))}
          </div>

          {/* filter chips */}
          {clips && clips.length > 0 && (
            <div className="flex items-center gap-1.5 mb-4 flex-wrap">
              {(["all", "pending", "processing", "done", "error"] as Filter[]).map((f) => {
                const n = countFor(f);
                if (f !== "all" && n === 0) return null;
                return (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-3 py-1.5 text-[10.5px] font-mono uppercase tracking-[0.1em] rounded-lg border transition-colors ${
                      filter === f
                        ? "text-primary bg-primary/[0.08] border-primary/25"
                        : "text-muted-foreground border-transparent hover:text-foreground"
                    }`}
                  >
                    {FILTER_LABELS[f]}
                    <span className={`ml-1.5 ${filter === f ? "text-primary/60" : "text-muted-foreground/50"}`}>{n}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* job list */}
          {isLoadingClips ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[88px] w-full bg-muted/40 rounded-xl" />
              ))}
            </div>
          ) : isErrorClips ? (
            <div className="rounded-xl border border-border bg-card p-16 text-center flex flex-col items-center justify-center text-muted-foreground gap-3">
              <AlertTriangle className="w-8 h-8 text-destructive" />
              <p className="font-mono text-sm uppercase tracking-widest">Failed to load clips</p>
              <p className="text-xs text-muted-foreground mb-2">Check that the server is running.</p>
              <button
                onClick={() => window.location.reload()}
                className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
            </div>
          ) : filteredClips && filteredClips.length > 0 ? (
            <div className="space-y-3">
              {filteredClips.map((clip) => (
                <ClipRow key={clip.id} initialClip={clip} />
              ))}
            </div>
          ) : clips && clips.length > 0 ? (
            <div className="rounded-xl border border-border bg-card p-12 text-center text-muted-foreground">
              <p className="font-mono text-sm uppercase tracking-widest">
                No {FILTER_LABELS[filter].toLowerCase()} clips
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card p-16 text-center flex flex-col items-center justify-center text-muted-foreground">
              <div className="w-12 h-12 border-2 border-dashed border-border rounded-full flex items-center justify-center mb-4">
                <Scissors className="w-5 h-5 text-muted-foreground/40" />
              </div>
              <p className="font-mono text-sm uppercase tracking-widest">No jobs in timeline</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
