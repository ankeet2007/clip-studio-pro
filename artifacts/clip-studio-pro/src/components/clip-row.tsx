import { Clip, useGetClip, getGetClipQueryKey, getListClipsQueryKey, getGetClipStatsQueryKey, useDeleteClip } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Download, Trash2, PlayCircle, AlertTriangle, CheckCircle, Clock, Loader2, RefreshCw, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
      // Invalidate shared queries whenever a clip reaches a terminal state
      // (or transitions away from one, e.g. after a retry resets to pending).
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
          <Badge variant="secondary" className="flex items-center gap-1 font-mono uppercase text-[10px] shrink-0">
            <Clock className="w-3 h-3" /> QUEUED
          </Badge>
        );
      case "processing":
        return (
          <Badge className="bg-primary text-primary-foreground flex items-center gap-1 font-mono uppercase text-[10px] shrink-0">
            <Loader2 className="w-3 h-3 animate-spin" /> PROCESSING
          </Badge>
        );
      case "done":
        return (
          <Badge className="bg-green-500/10 text-green-500 border border-green-500/20 flex items-center gap-1 font-mono uppercase text-[10px] shrink-0">
            <CheckCircle className="w-3 h-3" /> DONE
          </Badge>
        );
      case "error":
        return (
          <Badge variant="destructive" className="flex items-center gap-1 font-mono uppercase text-[10px] shrink-0">
            <AlertTriangle className="w-3 h-3" /> ERROR
          </Badge>
        );
      default:
        return null;
    }
  };

  const isActive = clip.status === "pending" || clip.status === "processing";
  const rawPct = Math.min(100, Math.max(0, clip.progress ?? 0));
  const pct = rawPct <= 3 ? 0 : rawPct <= 48 ? Math.round((rawPct / 48) * 45) : rawPct < 55 ? 45 : Math.round(45 + ((rawPct - 55) / 45) * 55);

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
      className="flex flex-col md:flex-row md:items-center gap-3 p-4 bg-card/50 hover:bg-card transition-colors cursor-pointer group"
      onClick={() => navigate(`/clips/${clip.id}`)}
    >
      {clip.status === "done" && !thumbError && (
        <div className="shrink-0 w-24 aspect-video rounded overflow-hidden bg-muted border border-border/50">
          <img
            src={`${API_BASE}/api/clips/${clip.id}/thumbnail`}
            alt="thumbnail"
            className="w-full h-full object-cover"
            onError={() => setThumbError(true)}
          />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3 mb-1">
          {getStatusBadge()}
          <h3 className="font-semibold text-sm truncate">{clip.headline || <span className="text-muted-foreground italic font-normal">Raw clip</span>}</h3>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
          {clip.sourceType === "local" ? (
            <span className="truncate max-w-[200px] flex items-center gap-1">
              <span className="text-primary/70 font-semibold shrink-0">LOCAL</span>
              <span className="truncate">{clip.localFileName ?? "Uploaded file"}</span>
            </span>
          ) : (
            <span className="truncate max-w-[200px]">{clip.youtubeUrl}</span>
          )}
          <span className="flex items-center gap-1 shrink-0">
            <PlayCircle className="w-3 h-3" />
            {clip.startTime} &ndash; {clip.endTime}
          </span>
        </div>

        {/* Progress bar — visible while pending or processing */}
        {isActive && (
          <div className="mt-2.5">
            {(() => {
              // yt-dlp doesn't emit intermediate % during its internal keyframe re-encode,
              // so pct stays at 2 the whole download phase. Show an indeterminate pulse
              // instead of a frozen "2%" — switch to a real bar once encoding begins (≥50%).
              const isIndeterminate = clip.status === "pending" || rawPct <= 10;
              const label =
                clip.status === "pending"
                  ? "Waiting in queue…"
                  : pct <= 3
                    ? "Downloading…"
                    : pct < 55
                      ? "Compositing…"
                      : `Encoding… ${pct}%`;

              return (
                <>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-mono text-muted-foreground">{label}</span>
                    {!isIndeterminate && (
                      <span className="text-[10px] font-mono text-primary font-semibold">{pct}%</span>
                    )}
                  </div>
                  <div className="h-1 bg-muted rounded-full overflow-hidden">
                    {isIndeterminate ? (
                      <div className="h-full w-full bg-muted-foreground/25 rounded-full animate-pulse" />
                    ) : (
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-700 ease-out"
                        style={{ width: `${Math.max(0, pct <= 3 ? 0 : pct)}%` }}
                      />
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {clip.errorMessage && (
          <div className="mt-2 text-xs text-destructive bg-destructive/10 p-2 rounded-sm border border-destructive/20 font-mono break-words">
            {clip.errorMessage}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {clip.status === "error" && (
          <Button
            size="sm"
            variant="outline"
            className="font-mono text-xs h-8 border-destructive/50 text-destructive hover:bg-destructive hover:text-white"
            onClick={handleRetry}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            RETRY
          </Button>
        )}
        {clip.status === "done" && clip.outputFilename && (
          <Button
            size="sm"
            className="font-mono text-xs h-8 bg-green-600 hover:bg-green-500 text-white"
            asChild
            onClick={(e) => e.stopPropagation()}
          >
            <a href={`${API_BASE}/api/clips/${clip.id}/download`} download>
              <Download className="w-4 h-4 mr-2" />
              DOWNLOAD
            </a>
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          onClick={handleDelete}
          disabled={deleteClip.isPending}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
      </div>
    </div>
    </>
  );
}
