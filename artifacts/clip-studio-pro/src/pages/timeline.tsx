import { useState } from "react";
import { useLocation } from "wouter";
import {
  useListClips,
  useGetClipStats,
  getListClipsQueryKey,
  getGetClipStatsQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ClipRow } from "@/components/clip-row";
import { ArrowLeft, BarChart2, AlertTriangle, Scissors, RefreshCw } from "lucide-react";
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
  const [, navigate] = useLocation();
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

  return (
    <div className="h-full bg-background text-foreground flex flex-col font-sans overflow-hidden">
      <AppHeader />

      {/* Sub-header */}
      <div className="shrink-0 border-b border-border bg-card px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/")}
            aria-label="Back to home"
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors group"
          >
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
          </button>
          <div className="flex items-center gap-2 text-sm font-mono text-muted-foreground uppercase tracking-widest">
            <BarChart2 className="w-4 h-4" />
            Timeline
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs font-mono flex-wrap justify-end">
          {isLoadingStats ? (
            <Skeleton className="h-4 w-32 bg-muted" />
          ) : stats ? (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">TOTAL:</span>
                <span className="text-foreground">{stats.total}</span>
              </div>
              <div className="w-px h-3 bg-border hidden sm:block" />
              <div className="hidden sm:flex items-center gap-1.5">
                <span className="text-muted-foreground">PROC:</span>
                <span className="text-primary">{stats.processing + stats.pending}</span>
              </div>
              <div className="w-px h-3 bg-border hidden sm:block" />
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">DONE:</span>
                <span className="text-green-500">{stats.done}</span>
              </div>
              <div className="w-px h-3 bg-border hidden sm:block" />
              <div className="hidden sm:flex items-center gap-1.5">
                <span className="text-muted-foreground">ERR:</span>
                <span className="text-destructive">{stats.error}</span>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* Filter bar */}
      {clips && clips.length > 0 && (
        <div className="shrink-0 border-b border-border bg-card px-4 md:px-6 py-1.5 flex items-center gap-0.5 overflow-x-auto">
          {(["all", "pending", "processing", "done", "error"] as Filter[]).map((f) => {
            const n = countFor(f);
            if (f !== "all" && n === 0) return null;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded transition-colors shrink-0 ${
                  filter === f
                    ? "text-primary bg-primary/10"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {FILTER_LABELS[f]}
                <span className={`ml-1 ${filter === f ? "text-primary/70" : "text-muted-foreground/50"}`}>
                  {n}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Job list */}
      <main className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 bg-muted/20">
        <div className="max-w-4xl mx-auto border border-border bg-card rounded-md shadow-sm overflow-hidden">
          {isLoadingClips ? (
            <div className="p-8 space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full bg-muted/50 rounded" />
              ))}
            </div>
          ) : isErrorClips ? (
            <div className="p-16 text-center flex flex-col items-center justify-center text-muted-foreground gap-3">
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
            <div className="divide-y divide-border flex flex-col">
              {filteredClips.map((clip) => (
                <ClipRow key={clip.id} initialClip={clip} />
              ))}
            </div>
          ) : clips && clips.length > 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              <p className="font-mono text-sm uppercase tracking-widest">
                No {FILTER_LABELS[filter].toLowerCase()} clips
              </p>
            </div>
          ) : (
            <div className="p-16 text-center flex flex-col items-center justify-center text-muted-foreground">
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
