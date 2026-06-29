import { Clip, useGetClip, getGetClipQueryKey, getListClipsQueryKey, getGetClipStatsQueryKey, useDeleteClip } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Download, Trash2, PlayCircle, AlertTriangle, CheckCircle, Clock, Loader2, RefreshCw, Play } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

import { API_BASE } from "@/lib/api";

export function ClipRow({ initialClip }: { initialClip: Clip }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [thumbError, setThumbError] = useState(false);
  const prevStatus = useRef(initialClip.status);

  const { data: clip = initialClip } = useGetClip(initialClip.id, {
    query: {
      refetchInterval: (query) => {
        const status = query.state.data?.status ?? initialClip.status;
        return status === "pending" || status === "processing" ? 3000 : false;
      },
      queryKey: getGetClipQueryKey(initialClip.id),
      initialData: initialClip,
    }
  });

  useEffect(() => {
    if (prevStatus.current !== clip.status) {
      const prev = prevStatus.current;
      prevStatus.current = clip.status;
      if (
        clip.status === "done" ||
        clip.status === "error" ||
        prev === "done" ||
        prev === "error"
      ) {
        queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
      }
    }
  }, [clip.status, queryClient]);

  const deleteClip = useDeleteClip({
    mutation: {
      onSuccess: () => {
        toast({ title: "Clip deleted" });
        queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
      },
      onError: () => {
        toast({ title: "Failed to delete clip", variant: "destructive" });
      }
    }
  });

  async function handleRetry(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      const res = await fetch(`${API_BASE}/api/clips/${clip.id}/retry`, { method: "POST" });
      if (!res.ok) throw new Error("Retry failed");
      queryClient.invalidateQueries({ queryKey: getGetClipQueryKey(clip.id) });
      queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
      toast({ title: "Clip re-queued" });
    } catch {
      toast({ title: "Failed to retry clip", variant: "destructive" });
    }
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteOpen(true);
  };

  const getStatusBadge = () => {
    switch (clip.status) {
      case "pending":
        return (
          <span className="inline-flex items-center gap-1.5 font-mono uppercase text-[9px] font-semibold tracking-[0.1em] px-2 py-1 rounded-md text-muted-foreground bg-card border border-border shrink-0">
            <Clock className="w-3 h-3" /> Queued
          </span>
        );
      case "processing":
        return (
          <span className="inline-flex items-center gap-1.5 font-mono uppercase text-[9px] font-semibold tracking-[0.1em] px-2 py-1 rounded-md bg-primary text-primary-foreground shrink-0">
            <Loader2 className="w-3 h-3 animate-spin" /> Processing
          </span>
        );
      case "done":
        return (
          <span className="inline-flex items-center gap-1.5 font-mono uppercase text-[9px] font-semibold tracking-[0.1em] px-2 py-1 rounded-md text-green-500 bg-green-500/10 border border-green-500/25 shrink-0">
            <CheckCircle className="w-3 h-3" /> Done
          </span>
        );
      case "error":
        return (
          <span className="inline-flex items-center gap-1.5 font-mono uppercase text-[9px] font-semibold tracking-[0.1em] px-2 py-1 rounded-md text-destructive bg-destructive/10 border border-destructive/25 shrink-0">
            <AlertTriangle className="w-3 h-3" /> Error
          </span>
        );
      default:
        return null;
    }
  };

  const isActive = clip.status === "pending" || clip.status === "processing";
  const rawPct = Math.min(100, Math.max(0, clip.progress ?? 0));
  const pct = rawPct <= 3 ? 0 : rawPct <= 48 ? Math.round((rawPct / 48) * 45) : rawPct < 55 ? 45 : Math.round(45 + ((rawPct - 55) / 45) * 55);
  const showThumb = clip.status === "done" && !thumbError;

  return (
    <>
    <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete clip?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently remove the clip and its output file. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => deleteClip.mutate({ id: clip.id })}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <div
      className={`flex gap-3.5 md:gap-4 items-center p-3.5 md:p-4 rounded-xl border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] hover:-translate-y-px transition-all cursor-pointer group ${
        clip.status === "error" ? "border-destructive/25" : "border-border hover:border-border/80"
      }`}
      onClick={() => navigate(`/clips/${clip.id}`)}
    >
      {/* thumbnail */}
      <div className="shrink-0 w-[88px] md:w-[104px] aspect-video rounded-lg overflow-hidden border border-border bg-gradient-to-br from-[#241d38] to-[#0d1626] grid place-items-center">
        {showThumb ? (
          <img
            src={`${API_BASE}/api/clips/${clip.id}/thumbnail`}
            alt="thumbnail"
            className="w-full h-full object-cover"
            onError={() => setThumbError(true)}
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-black/40 grid place-items-center">
            <Play className="w-2.5 h-2.5 text-white/70 fill-white/70 ml-0.5" />
          </div>
        )}
      </div>

      {/* main */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5 mb-1.5">
          {getStatusBadge()}
          <h3 className="font-semibold text-sm truncate">
            {clip.headline || <span className="text-muted-foreground italic font-normal">Raw clip</span>}
          </h3>
        </div>
        <div className="flex items-center gap-3.5 text-[11px] text-muted-foreground font-mono flex-wrap">
          {clip.sourceType === "local" ? (
            <span className="truncate max-w-[200px] flex items-center gap-1">
              <span className="text-primary/70 font-semibold shrink-0">LOCAL</span>
              <span className="truncate">{clip.localFileName ?? "Uploaded file"}</span>
            </span>
          ) : (
            <span className="truncate max-w-[200px]">{clip.youtubeUrl}</span>
          )}
          <span className="flex items-center gap-1 shrink-0 text-primary">
            <PlayCircle className="w-3 h-3" />
            {clip.startTime} &ndash; {clip.endTime}
          </span>
        </div>

        {/* progress */}
        {isActive && (
          <div className="mt-2.5">
            {(() => {
              const isIndeterminate = clip.status === "pending" || rawPct <= 10;
              const label =
                clip.status === "pending"
                  ? "Waiting in queue…"
                  : pct <= 3
                    ? "Downloading…"
                    : pct < 55
                      ? "Compositing…"
                      : "Encoding…";

              return (
                <>
                  <div className="h-1.5 rounded-full bg-background border border-border overflow-hidden">
                    {isIndeterminate ? (
                      <div className="h-full w-full bg-muted-foreground/25 rounded-full animate-pulse" />
                    ) : (
                      <div
                        className="h-full bg-gradient-to-r from-[#a9d600] to-primary rounded-full transition-all duration-700 ease-out"
                        style={{ width: `${Math.max(0, pct)}%` }}
                      />
                    )}
                  </div>
                  <div className="flex items-center justify-between mt-1.5 font-mono text-[10px] text-muted-foreground">
                    <span>{label}</span>
                    {!isIndeterminate && <span className="text-primary font-semibold">{pct}%</span>}
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {clip.errorMessage && (
          <div className="mt-2 text-[11px] text-destructive bg-destructive/10 px-2.5 py-2 rounded-md border border-destructive/20 font-mono break-words">
            {clip.errorMessage}
          </div>
        )}
      </div>

      {/* actions */}
      <div className="flex items-center gap-2 shrink-0">
        {clip.status === "error" && (
          <Button
            size="icon"
            variant="outline"
            className="h-9 w-9 border-border text-muted-foreground hover:text-amber-400 hover:border-amber-400/40"
            onClick={handleRetry}
            title="Retry"
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
        )}
        {clip.status === "done" && clip.outputFilename && (
          <Button
            size="sm"
            className="font-mono text-[10.5px] uppercase tracking-[0.08em] h-9 bg-green-600 hover:bg-green-500 text-white"
            asChild
            onClick={(e) => e.stopPropagation()}
          >
            <a href={`${API_BASE}/api/clips/${clip.id}/download`} download>
              <Download className="w-4 h-4 mr-1.5" />
              Download
            </a>
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9 text-muted-foreground hover:text-destructive"
          onClick={handleDelete}
          disabled={deleteClip.isPending}
          title="Delete"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
    </>
  );
}
