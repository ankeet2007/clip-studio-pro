import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { API_BASE } from "@/lib/api";
import {
  useListClips,
  getListClipsQueryKey,
  getGetClipStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AppHeader } from "@/components/app-header";
import {
  Loader2,
  Zap,
  Plus,
  X,
  Youtube,
  Upload,
  FileVideo,
  MonitorPlay,
  Mic,
  ClipboardCopy,
  Check,
  Eye,
  Play,
  Pause,
  SendHorizonal,
  ZoomIn,
  Sparkles,
  Film,
  Trash2,
  Trophy,
  AlertTriangle,
} from "lucide-react";

const MAX_CLIPS = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024;

const clipEntrySchema = z.object({
  mode: z.enum(["edited", "raw"]).default("edited"),
  startTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Must be HH:MM:SS"),
  endTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Must be HH:MM:SS"),
  headline: z.string().optional().default(""),
  captionsEnabled: z.boolean().default(true),
  captionColor: z.string().optional().default("#FFF400"),
  outroEnabled: z.boolean().default(true),
  punchInEnabled: z.boolean().default(false),
  zoomMoments: z.string().optional().default(""),
  voiceoverEnabled: z.boolean().default(false),
  voiceoverHook: z.string().optional().default(""),
  voiceoverMode: z.enum(["hook", "script"]).default("hook"),
  narrationScript: z.string().optional().default(""),
}).superRefine((val, ctx) => {
  if (val.mode === "edited" && (!val.headline || val.headline.trim().length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Headline required for Edited mode", path: ["headline"] });
  }
  const toSecs = (t: string) => t.split(":").reduce((acc, v) => acc * 60 + Number(v), 0);
  if (toSecs(val.endTime) <= toSecs(val.startTime)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "End time must be after start time", path: ["endTime"] });
  }
});

const formSchema = z.object({
  youtubeUrl: z
    .string()
    .url("Must be a valid URL")
    .regex(/(?:youtube\.com|youtu\.be)/, "Must be a YouTube URL"),
  frameStyle: z.enum(["standard", "immersive"]).default("immersive"),
  sourceChannel: z.string().optional().default(""),
  clips: z.array(clipEntrySchema).min(1),
});

type FormValues = z.infer<typeof formSchema>;

const defaultClip = {
  mode: "edited" as const,
  startTime: "00:00:00",
  endTime: "00:00:15",
  headline: "",
  captionsEnabled: true,
  captionColor: "#FFF400",
  outroEnabled: true,
  punchInEnabled: false,
  zoomMoments: "",
  voiceoverEnabled: false,
  voiceoverHook: "",
  voiceoverMode: "hook" as const,
  narrationScript: "",
};

type SourceTab = "youtube" | "local" | "story" | "top5" | "matchstory" | "matchstory2";

// Match Story 2.0 scout candidate (as returned by GET /api/scout/:id).
interface ScoutCandidate {
  id: string;
  platform: string;
  title: string;
  author: string;
  sourceUrl: string;
  engagement: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  score: number;
  reasons: string[];
  status: "candidate" | "keep" | "drop";
  thumbUrl: string | null;
}

interface StorySeg {
  startTime: string;
  endTime: string;
  headline: string;
}

interface Top5Seg {
  rank: number;
  youtubeUrl: string;
  startTime: string;
  endTime: string;
  sourceChannel: string;
  headline: string;
  narrationLine: string;
  verify: {
    ok: boolean;
    reason?: string | null;
    message: string | null;
    videoDuration?: number | null;
    suggested?: { startTime: string; endTime: string; confidence: number; evidence: string } | null;
  } | null;
}

// Normalises a "M:SS" / "MM:SS" / "H:MM:SS" timestamp to zero-padded HH:MM:SS.
function padHMS(t: string): string {
  const parts = t.split(":");
  while (parts.length < 3) parts.unshift("0");
  return parts.slice(-3).map((p) => p.padStart(2, "0")).join(":");
}

function defaultTop5(): Top5Seg[] {
  return [5, 4, 3, 2, 1].map((rank) => ({
    rank, youtubeUrl: "", startTime: "00:00:00", endTime: "00:00:12",
    sourceChannel: "", headline: "", narrationLine: "", verify: null,
  }));
}

// One beat of a MATCH STORY: a research-driven MULTI-SOURCE narrated montage (jobType
// "matchstory"). Like a Top 5 moment but with no rank. Each beat carries its OWN source
// video AND its own narration line — the beat is paced to that line so the voice always
// matches what's on screen (no guessed timeline timestamps).
interface MatchSeg {
  youtubeUrl: string;
  startTime: string;
  endTime: string;
  sourceChannel: string;
  headline: string;
  narrationLine: string;
  // Match Story 2.0: a scout-downloaded local clip beat (no URL/timestamps/verify).
  localFile?: string;
  sourceType?: "youtube" | "local";
  thumbUrl?: string;
  verify: {
    ok: boolean;
    message: string | null;
    videoDuration?: number | null;
    suggested?: { startTime: string; endTime: string; confidence: number; evidence: string } | null;
  } | null;
}

function defaultMatchStory(): MatchSeg[] {
  return Array.from({ length: 4 }, () => ({
    youtubeUrl: "", startTime: "00:00:00", endTime: "00:00:10",
    sourceChannel: "", headline: "", narrationLine: "", verify: null,
  }));
}

interface LocalForm {
  startTime: string;
  endTime: string;
  headline: string;
  mode: "edited" | "raw";
  sourceChannel: string;
  captionsEnabled: boolean;
}

function secsToHMS(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

function toSecs(t: string): number {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(t)) return 0;
  return t.split(":").reduce((acc, v) => acc * 60 + Number(v), 0);
}

function fmtDuration(start: string, end: string): string {
  const d = Math.max(0, toSecs(end) - toSecs(start));
  const m = Math.floor(d / 60);
  const s = d % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Parses clip suggestions the user pastes back from Gemini (the AI Clip Finder flow).
 * Each line looks like "00:01:12 - 00:01:34 | Headline Here": we read the two timestamps
 * and take everything after the second one as the headline. Times are normalised to
 * HH:MM:SS. Backwards/garbage lines are skipped; the result is capped at MAX_CLIPS.
 */
function parseClipSuggestions(text: string): { startTime: string; endTime: string; headline: string }[] {
  const padTime = (t: string): string => {
    const parts = t.split(":");
    while (parts.length < 3) parts.unshift("0");
    return parts.slice(-3).map((p) => p.padStart(2, "0")).join(":");
  };
  const out: { startTime: string; endTime: string; headline: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/(\d{1,2}:\d{1,2}(?::\d{1,2})?)\s*(?:-|–|—|to|→)\s*(\d{1,2}:\d{1,2}(?::\d{1,2})?)(.*)/i);
    if (!m) continue;
    const startTime = padTime(m[1]);
    const endTime = padTime(m[2]);
    if (toSecs(endTime) <= toSecs(startTime)) continue;
    const headline = m[3].replace(/^[\s|:\-–—]+/, "").replace(/^["']|["']$/g, "").trim().slice(0, 120);
    out.push({ startTime, endTime, headline });
    if (out.length >= MAX_CLIPS) break;
  }
  return out;
}

/**
 * Copies text to the clipboard, working over plain HTTP too. The modern
 * navigator.clipboard API only exists in a secure context (HTTPS or localhost);
 * this app is served over http on a LAN IP, so we fall back to the legacy
 * execCommand("copy") approach via a hidden textarea.
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ---------- small reusable bits ---------- */

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Label className="font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted-foreground mb-1.5 block">
      {children}
    </Label>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string; icon?: React.ReactNode }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex bg-background border border-border rounded-lg p-[3px] gap-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex items-center gap-1.5 rounded-md px-3.5 py-2 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
            value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// AI voiceover voices. All are local Piper models on the phone (~/piper/*.onnx). Deep /
// human-sounding voices are listed first; "" = let the server pick the best default for the
// job (Top 5 → Joe, Story/Narration → Alan). Keep in sync with KNOWN_VOICES in clipProcessor.
const VOICE_OPTIONS = [
  { value: "", label: "Auto — best deep voice for this mode" },
  { value: "en_GB-alan-medium", label: "Alan · British, deep & warm (narrator)" },
  { value: "en_US-joe-medium", label: "Joe · deep American male" },
  { value: "en_US-norman-medium", label: "Norman · mature, gravelly US" },
  { value: "en_GB-northern_english_male-medium", label: "Northern English · deep British" },
  { value: "en_US-hfc_male-medium", label: "HFC Male · clean, neutral US" },
  { value: "en_US-ryan-medium", label: "Ryan · expressive (old default)" },
  { value: "en_US-lessac-medium", label: "Lessac · neutral reference" },
];

// Speaking pace → Piper length_scale (higher = slower). Values match the preview samples.
const SPEED_OPTIONS = [
  { value: "1.0", label: "Normal" },
  { value: "1.15", label: "Slightly slow" },
  { value: "1.3", label: "Slow · dramatic" },
];

// Only one voice preview plays at a time across every picker on the page. Kept at module
// scope so starting a new audition (or leaving the page) stops whatever was playing.
let activePreviewAudio: HTMLAudioElement | null = null;
function stopActivePreview() {
  if (activePreviewAudio) {
    activePreviewAudio.pause();
    activePreviewAudio.src = "";
    activePreviewAudio = null;
  }
}

// Play/stop button that auditions a Piper voice by streaming a short sample WAV from the
// server (GET /api/voices/preview/:voice — cached after the first hit). `voice` is the model
// to preview; for the "Auto" option we preview `autoVoice`, the default that mode would use.
function VoicePreviewButton({ voice, autoVoice }: { voice: string; autoVoice: string }) {
  const { toast } = useToast();
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewVoice = voice || autoVoice;

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      if (activePreviewAudio === audioRef.current) activePreviewAudio = null;
      audioRef.current = null;
    }
    setState("idle");
  }, []);

  // Stop playback when the chosen voice changes or the picker unmounts, so we never keep
  // playing a sample the user has moved past.
  useEffect(() => stop, [previewVoice, stop]);

  const play = useCallback(() => {
    if (state !== "idle") { stop(); return; }
    stopActivePreview();
    const audio = new Audio(`${API_BASE}/api/voices/preview/${encodeURIComponent(previewVoice)}`);
    audioRef.current = audio;
    activePreviewAudio = audio;
    setState("loading");
    audio.onplaying = () => setState("playing");
    audio.onended = () => stop();
    audio.onerror = () => {
      stop();
      toast({
        title: "Preview unavailable",
        description: "Couldn't generate that voice sample. Try again in a moment.",
        variant: "destructive",
      });
    };
    audio.play().catch(() => { /* onerror handles the toast */ });
  }, [state, previewVoice, stop, toast]);

  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); play(); }}
      title={state === "idle" ? "Preview this voice" : "Stop preview"}
      aria-label={state === "idle" ? "Preview this voice" : "Stop preview"}
      className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-md border border-[#9b7bff]/40 bg-[#9b7bff]/[0.08] text-[#b69dff] hover:bg-[#9b7bff]/[0.18] transition-colors"
    >
      {state === "loading" ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : state === "playing" ? (
        <Pause className="w-4 h-4" />
      ) : (
        <Play className="w-4 h-4" />
      )}
    </button>
  );
}

// Shared voice + pace picker. `voice`/`speed` come from the page-level state so the choice
// applies to whichever job (clip / story / top 5) the user submits. `autoVoice` is the model
// the "Auto" option resolves to for THIS mode, so its preview matches what would be rendered.
function VoicePicker({
  voice,
  speed,
  onVoice,
  onSpeed,
  autoVoice = "en_US-joe-medium",
}: {
  voice: string;
  speed: string;
  onVoice: (v: string) => void;
  onSpeed: (v: string) => void;
  autoVoice?: string;
}) {
  return (
    <div className="mt-2.5 space-y-2">
      <div>
        <span className="text-[9.5px] font-mono uppercase tracking-[0.14em] text-[#b69dff] flex items-center gap-1.5 mb-1">
          <Mic className="w-3 h-3" /> Voice
        </span>
        <div className="flex items-center gap-2">
          <select
            value={voice}
            onChange={(e) => onVoice(e.target.value)}
            className="flex-1 min-w-0 text-sm bg-background border border-border rounded-md px-2.5 py-2 font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-[#9b7bff]"
          >
            {VOICE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <VoicePreviewButton voice={voice} autoVoice={autoVoice} />
        </div>
        <span className="text-[9px] font-mono text-muted-foreground/70 mt-1 block">
          ▶ Tap play to hear this voice
        </span>
      </div>
      <div>
        <span className="text-[9.5px] font-mono uppercase tracking-[0.14em] text-[#b69dff] mb-1 block">Pace</span>
        <Segmented value={speed} onChange={onSpeed} options={SPEED_OPTIONS} />
      </div>
    </div>
  );
}

function ToggleChip({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.08em] transition-colors ${
        checked
          ? "text-primary border-primary/40 bg-primary/[0.07]"
          : "text-muted-foreground border-border bg-card hover:text-foreground"
      }`}
    >
      <span
        className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center ${
          checked ? "bg-primary border-primary" : "border-muted-foreground/50"
        }`}
      >
        {checked && <Check className="w-2.5 h-2.5 text-primary-foreground" strokeWidth={3.5} />}
      </span>
      {label}
    </button>
  );
}

/* ---------- live 9:16 preview ---------- */

function LivePreview({
  headline,
  mode,
  frameStyle,
  captions,
  voiceover,
  hook,
  handle,
}: {
  headline: string;
  mode: "edited" | "raw";
  frameStyle: "standard" | "immersive";
  captions: boolean;
  voiceover: boolean;
  hook: string;
  handle: string;
}) {
  const showHeadline = mode === "edited" && headline.trim().length > 0;
  const watermark = (handle || "@yourchannel").toUpperCase();
  // crude "karaoke" split for the caption mock
  const hookWords = (hook || "your spoken hook").trim().split(/\s+/).slice(0, 4);

  return (
    <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-4">
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted-foreground flex items-center gap-2">
          <Eye className="w-3.5 h-3.5 text-primary" /> Live preview
        </span>
        <span className="font-mono text-[9px] text-muted-foreground/50">9:16</span>
      </div>

      <div className="w-[200px] mx-auto aspect-[9/16] rounded-[22px] border border-border bg-black overflow-hidden relative shadow-[0_30px_60px_-30px_#000]">
        {/* 40px top drop to clear YouTube UI */}
        <div className="h-[7%] bg-black" />
        {/* video area */}
        <div className="absolute inset-x-0 top-[7%] bottom-0 grid place-items-center bg-gradient-to-br from-[#2a2140] via-[#101a2e] to-[#0a1420]">
          <div className="w-11 h-11 rounded-full grid place-items-center bg-white/10 backdrop-blur-sm border border-white/20">
            <Play className="w-4 h-4 text-white fill-white ml-0.5" />
          </div>
        </div>

        {voiceover && (
          <div className="absolute left-2 top-[calc(7%+8px)] flex items-center gap-1 rounded-md bg-[#9b7bff]/85 px-1.5 py-0.5 text-[7.5px] font-mono tracking-wide text-white">
            <Mic className="w-2.5 h-2.5" /> HOOK
          </div>
        )}

        {showHeadline && (
          <div className="absolute inset-x-0 top-[11%] px-3 text-center">
            <span className="font-extrabold text-[13px] leading-tight text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
              {headline}
            </span>
          </div>
        )}

        {mode === "edited" && (
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center font-extrabold tracking-wide text-[15px] text-white/85 drop-shadow-[0_2px_10px_rgba(0,0,0,0.7)]">
            {watermark}
          </div>
        )}

        {captions && (
          <div className="absolute inset-x-0 bottom-[13%] px-3 text-center leading-snug">
            <span className="font-extrabold text-[13px] text-black bg-primary px-1.5 py-0.5 rounded-[5px] shadow">
              {hookWords[0] ?? "your"}
            </span>{" "}
            <span className="font-extrabold text-[13px] text-white drop-shadow-[0_2px_6px_#000]">
              {hookWords.slice(1).join(" ") || "captions"}
            </span>
          </div>
        )}
      </div>

      <div className="mt-4 space-y-2">
        {[
          ["Frame", frameStyle === "immersive" ? "Immersive" : "Standard", "text-foreground"],
          ["Captions", captions ? "Karaoke ON" : "Off", captions ? "text-primary" : "text-muted-foreground"],
          ["Voiceover", voiceover ? "Hook ON" : "Off", voiceover ? "text-[#b69dff]" : "text-muted-foreground"],
        ].map(([k, v, cls]) => (
          <div key={k} className="flex items-center justify-between font-mono text-[10.5px]">
            <span className="text-muted-foreground">{k}</span>
            <span className={cls as string}>{v}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground/60 leading-relaxed text-center">
        Reflects your settings live — what you see is the Short that renders.
      </p>
    </div>
  );
}

export default function Home() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sourceTab, setSourceTab] = useState<SourceTab>("youtube");

  // YouTube preview player
  const [showPlayer, setShowPlayer] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const playerRef = useRef<any>(null);
  const playerDivRef = useRef<HTMLDivElement>(null);

  // Local file upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [localForm, setLocalForm] = useState<LocalForm>({
    startTime: "00:00:00",
    endTime: "00:01:00",
    headline: "",
    mode: "edited",
    sourceChannel: "",
    captionsEnabled: true,
  });
  const [localErrors, setLocalErrors] = useState<Partial<Record<keyof LocalForm | "file", string>>>({});

  // channel handle for the live preview watermark
  const [channelHandle, setChannelHandle] = useState("");
  useEffect(() => {
    fetch(`${API_BASE}/api/settings`)
      .then((r) => r.json() as Promise<{ channelHandle?: string }>)
      .then((d) => setChannelHandle(d.channelHandle ?? ""))
      .catch(() => {});
  }, []);

  // warm the clips list cache for the timeline
  useListClips({ query: { queryKey: getListClipsQueryKey() } });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      youtubeUrl: "",
      frameStyle: "immersive",
      clips: [{ ...defaultClip }],
    },
  });

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "clips",
  });

  // AI Clip Finder: raw text the user pastes back from Gemini, parsed into clip entries.
  const [suggestText, setSuggestText] = useState("");

  // ----- Story mode (Feature 2) state -----
  const [storyUrl, setStoryUrl] = useState("");
  const [storyCreator, setStoryCreator] = useState("");
  const [storySegments, setStorySegments] = useState<StorySeg[]>([
    { startTime: "00:00:00", endTime: "00:00:15", headline: "" },
    { startTime: "00:00:00", endTime: "00:00:15", headline: "" },
  ]);
  const [storyNarration, setStoryNarration] = useState("");
  const [storyPaste, setStoryPaste] = useState("");
  const [storyCaptions, setStoryCaptions] = useState(true);
  const [storyOutro, setStoryOutro] = useState(true);
  const [storySubmitting, setStorySubmitting] = useState(false);

  // ----- Top 5 mode state -----
  const [t5Topic, setT5Topic] = useState("");
  const [t5MultiSource, setT5MultiSource] = useState(true);
  const [t5Url, setT5Url] = useState("");
  const [t5Creator, setT5Creator] = useState("");
  const [t5Segments, setT5Segments] = useState<Top5Seg[]>(defaultTop5);
  const [t5Paste, setT5Paste] = useState("");
  const [t5Captions, setT5Captions] = useState(true);
  const [t5Outro, setT5Outro] = useState(true);
  const [t5Order, setT5Order] = useState<"5to1" | "1to5">("5to1");
  const [t5Verifying, setT5Verifying] = useState(false);
  const [t5Submitting, setT5Submitting] = useState(false);

  // ----- Match Story mode (research-driven, multi-source narrated montage) state -----
  const [msTopic, setMsTopic] = useState("");
  const [msCreator, setMsCreator] = useState("");
  const [msSegments, setMsSegments] = useState<MatchSeg[]>(defaultMatchStory);
  const [msNarration, setMsNarration] = useState("");
  const [msPaste, setMsPaste] = useState("");
  const [msCaptions, setMsCaptions] = useState(true);
  const [msOutro, setMsOutro] = useState(true);
  const [msTransitions, setMsTransitions] = useState(true);
  const [msTitleCard, setMsTitleCard] = useState(true);
  const [msVerifying, setMsVerifying] = useState(false);
  const [msSubmitting, setMsSubmitting] = useState(false);

  // ----- Match Story 2.0 (clip-scout) state -----
  const [ms2Topic, setMs2Topic] = useState("");
  const [ms2Subreddits, setMs2Subreddits] = useState("");
  const [ms2Platforms, setMs2Platforms] = useState<string[]>(["reddit"]);
  const [ms2JobId, setMs2JobId] = useState<string | null>(null);
  const [ms2Status, setMs2Status] = useState<string>("");
  const [ms2Progress, setMs2Progress] = useState(0);
  const [ms2Message, setMs2Message] = useState<string>("");
  const [ms2Candidates, setMs2Candidates] = useState<ScoutCandidate[]>([]);
  const [ms2Adapters, setMs2Adapters] = useState<{ platform: string; configured: boolean }[]>([]);
  const [ms2Building, setMs2Building] = useState(false);
  const ms2Poll = useRef<ReturnType<typeof setInterval> | null>(null);
  // MS 2.0's OWN beats (isolated from the Match Story tab) + its narration paste + submit state.
  const [ms2Beats, setMs2Beats] = useState<MatchSeg[]>([]);
  const [ms2NarrPaste, setMs2NarrPaste] = useState("");
  const [ms2Submitting, setMs2Submitting] = useState(false);

  // ----- Shared AI voice + pace (applies to whichever job you create) -----
  // voVoice "" = let the server pick the best deep voice per mode; voSpeed = Piper length_scale.
  const [voVoice, setVoVoice] = useState("");
  const [voSpeed, setVoSpeed] = useState("1.0");

  const [, navigate] = useLocation();
  const isSubmitting = form.formState.isSubmitting;

  const youtubeUrl = form.watch("youtubeUrl");
  const videoId = useMemo(() => {
    if (!youtubeUrl) return null;
    const m = youtubeUrl.match(
      /(?:youtu\.be\/|youtube\.com\/(?:shorts\/|live\/|embed\/|v\/|watch\?v=))([^&?/]+)/
    );
    return m?.[1] ?? null;
  }, [youtubeUrl]);

  const prevVideoIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (videoId !== prevVideoIdRef.current) {
      prevVideoIdRef.current = videoId;
      if (!videoId) setShowPlayer(false);
    }
  }, [videoId]);

  useEffect(() => {
    if (!showPlayer || !videoId) return;

    const mountPlayer = () => {
      if (!playerDivRef.current) return;
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      }
      setPlayerReady(false);
      playerRef.current = new (window as any).YT.Player(playerDivRef.current, {
        videoId,
        playerVars: { controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
        events: { onReady: () => setPlayerReady(true) },
      });
    };

    if ((window as any).YT?.Player) {
      mountPlayer();
    } else {
      const prev = (window as any).onYouTubeIframeAPIReady;
      (window as any).onYouTubeIframeAPIReady = () => {
        mountPlayer();
        if (typeof prev === "function") prev();
      };
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement("script");
        s.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(s);
      }
    }

    return () => {
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      }
      setPlayerReady(false);
    };
  }, [showPlayer, videoId]);

  const handleSetIn = (clipIndex: number) => {
    const t: number = playerRef.current?.getCurrentTime?.() ?? 0;
    form.setValue(`clips.${clipIndex}.startTime`, secsToHMS(t));
  };

  const handleSetOut = (clipIndex: number) => {
    const t: number = playerRef.current?.getCurrentTime?.() ?? 0;
    form.setValue(`clips.${clipIndex}.endTime`, secsToHMS(t));
  };

  // Builds a ready-made prompt for the user's own Gemini app and copies it to the
  // clipboard. The server never calls any AI — the user pastes this into Gemini,
  // then pastes the returned hook line back into the voiceover text box.
  async function copyHookPrompt(index: number) {
    const values = form.getValues();
    const clip = values.clips[index];
    if (!clip) return;
    const dur = Math.max(0, toSecs(clip.endTime) - toSecs(clip.startTime));
    const hasUrl = !!(values.youtubeUrl && values.youtubeUrl.trim());
    const prompt =
      `You are a viral short-form video editor. ` +
      (hasUrl
        ? `Open and WATCH the exact section of the source video below, then write a hook grounded in what ACTUALLY happens in it — do not guess.\n`
        : `Write a hook for this clip (a local upload — if you cannot view the footage, base it on the title below).\n`) +
      `Write ONE punchy spoken intro hook (6-10 words), read aloud over the first few seconds ` +
      `of a YouTube Short, to stop the scroll and capture THIS clip's single most attention-grabbing moment. ` +
      `Return ONLY the hook line — no quotes, no extra text.\n\n` +
      `Context:\n` +
      (hasUrl
        ? `- Video: ${values.youtubeUrl}\n- Watch ONLY this section: ${clip.startTime} to ${clip.endTime}\n`
        : "") +
      `- Headline/title: ${clip.headline || "(none)"}\n` +
      `- Source channel: ${values.sourceChannel || "(unknown)"}\n` +
      `- Clip length: ~${dur}s`;
    const ok = await copyTextToClipboard(prompt);
    if (ok) {
      toast({ title: "Prompt copied", description: "Paste it into your Gemini app, then paste the hook back here." });
    } else {
      toast({ title: "Copy failed", description: "Couldn't access the clipboard. Long-press the box to copy manually.", variant: "destructive" });
    }
  }

  // Builds a Gemini prompt for FULL NARRATION mode: a multi-line documentary script
  // with clip-relative timestamps. Same bridge pattern as the hook — the user runs it in
  // their own Gemini and pastes the "SS | sentence" lines back into the narration box.
  async function copyNarrationPrompt(index: number) {
    const values = form.getValues();
    const clip = values.clips[index];
    if (!clip) return;
    const dur = Math.max(0, toSecs(clip.endTime) - toSecs(clip.startTime));
    const hasUrl = !!(values.youtubeUrl && values.youtubeUrl.trim());
    const prompt =
      `You are a documentary editor writing spoken narration for a vertical YouTube Short. ` +
      (hasUrl
        ? `Open and WATCH the exact section of the source video below, then narrate what ACTUALLY happens in it — do not guess.\n`
        : `Write narration for this clip (a local upload — if you cannot view the footage, base it on the title below).\n`) +
      `Write a 4-6 line spoken narration that tells the story of the clip, ONE sentence per beat, timed to the action, ` +
      `to keep viewers watching to the end. Give each line's time as the number of seconds AFTER the start of the section ` +
      `(0 = ${clip.startTime}), a whole number between 1 and ${Math.max(1, dur - 1)}, and space the lines at least 3 seconds apart.\n` +
      `Return ONLY the lines in EXACTLY this format and NOTHING else:\n` +
      `SS | narration sentence\n` +
      `Example:\n` +
      `2 | Nobody saw this coming.\n` +
      `9 | He'd been planning it for months.\n` +
      `17 | And that's when everything fell apart.\n\n` +
      `Context:\n` +
      (hasUrl
        ? `- Video: ${values.youtubeUrl}\n- Watch ONLY this section: ${clip.startTime} to ${clip.endTime}\n`
        : "") +
      `- Headline/title: ${clip.headline || "(none)"}\n` +
      `- Source channel: ${values.sourceChannel || "(unknown)"}\n` +
      `- Clip length: ~${dur}s`;
    const ok = await copyTextToClipboard(prompt);
    toast(ok
      ? { title: "Narration prompt copied", description: "Paste it into your Gemini app, then paste the timed lines back here." }
      : { title: "Copy failed", description: "Couldn't access the clipboard.", variant: "destructive" });
  }

  // Builds a Gemini prompt asking it to choose AUTO-ZOOM moments AND the best zoom TYPE
  // for each. Same human-in-the-loop pattern as the hook: server makes no AI calls — the
  // user pastes this into Gemini, then pastes the returned "second type" pairs back.
  async function copyZoomPrompt(index: number) {
    const values = form.getValues();
    const clip = values.clips[index];
    if (!clip) return;
    const dur = Math.max(0, toSecs(clip.endTime) - toSecs(clip.startTime));
    const hasUrl = !!(values.youtubeUrl && values.youtubeUrl.trim());
    // Give Gemini the actual video + the exact section to watch, so it picks INFORMED
    // moments instead of guessing. Returned seconds must be clip-relative (0 = section start).
    const sourceBlock = hasUrl
      ? `Open and WATCH this exact part of the source video, then base every choice on what ACTUALLY happens in it — do not guess:\n` +
        `Video: ${values.youtubeUrl}\n` +
        `Watch ONLY the section from ${clip.startTime} to ${clip.endTime} (about ${dur} seconds long)` +
        `${clip.headline ? `, titled "${clip.headline}"` : ""}` +
        `${values.sourceChannel ? `, from ${values.sourceChannel}` : ""}.\n`
      : `This is a ${dur}-second vertical clip` +
        `${clip.headline ? `, titled "${clip.headline}"` : ""}` +
        `${values.sourceChannel ? `, from ${values.sourceChannel}` : ""}. ` +
        `(It is a local upload — if you cannot view the footage, choose sensible moments from the title and typical short-form pacing.)\n`;
    const prompt =
      `You are a short-form video editor choosing AUTO-ZOOM moments for a vertical YouTube Short.\n` +
      sourceBlock +
      `Pick 4-8 moments where a zoom would add emphasis or energy — reactions, punchlines, key beats. ` +
      `For EACH moment pick the zoom TYPE that best fits that beat, from exactly these keywords:\n` +
      `- punch — quick zoom-in and out; all-purpose emphasis on a punchline or reaction\n` +
      `- whip — fast snappy zoom; a sudden shock or hype spike\n` +
      `- cut — hard cut to a tighter shot and back; sharp, abrupt emphasis\n` +
      `- pushin — slow gradual zoom-in; rising tension or an important line\n` +
      `- pullout — snap in then slow zoom-out; a reveal or "stepping back" beat\n` +
      `- kenburns — gentle zoom with a slow diagonal pan; calmer or B-roll stretches\n` +
      `Space the moments at least 1.5 seconds apart.\n` +
      `IMPORTANT — timing: give each moment as the number of seconds AFTER the start of that section ` +
      `(0 = ${clip.startTime}), a whole number between 1 and ${Math.max(1, dur - 1)}. Do NOT use the video's ` +
      `absolute timestamp.\n` +
      `Return ONLY a comma-separated list of "second type" pairs and NOTHING else, e.g.:\n` +
      `3 punch, 8 pushin, 14 kenburns, 20 whip, 27 cut`;
    const ok = await copyTextToClipboard(prompt);
    if (ok) {
      toast({ title: "Zoom prompt copied", description: "Paste it into Gemini, then paste the second+type pairs back here." });
    } else {
      toast({ title: "Copy failed", description: "Couldn't access the clipboard.", variant: "destructive" });
    }
  }

  // Per-clip AI headline. Same bridge pattern as the hook/zoom prompts — the app writes the
  // Gemini prompt, the user runs it in their own Gemini and pastes the headline back.
  async function copyHeadlinePrompt(index: number) {
    const values = form.getValues();
    const clip = values.clips[index];
    if (!clip) return;
    const dur = Math.max(0, toSecs(clip.endTime) - toSecs(clip.startTime));
    const hasUrl = !!(values.youtubeUrl && values.youtubeUrl.trim());
    const prompt =
      `You are a viral short-form video editor. ` +
      (hasUrl
        ? `Open and WATCH the exact section of the source video below, then base the headline on what ACTUALLY happens in it — do not guess.\n`
        : `Suggest a headline for this clip (a local upload — if you cannot view the footage, base it on the context below).\n`) +
      `Write ONE punchy on-screen headline (4-7 words) for a vertical YouTube Short that stops the scroll and nails THIS clip's single most attention-grabbing moment. ` +
      `Use Title Case, no ending period, no hashtags, no emoji, no quotes. Return ONLY the headline line — nothing else.\n\n` +
      `Context:\n` +
      (hasUrl
        ? `- Video: ${values.youtubeUrl}\n- Watch ONLY this section: ${clip.startTime} to ${clip.endTime}\n`
        : "") +
      `- Source channel: ${values.sourceChannel || "(unknown)"}\n` +
      `- Clip length: ~${dur}s`;
    const ok = await copyTextToClipboard(prompt);
    toast(ok
      ? { title: "Headline prompt copied", description: "Paste it into Gemini, then paste the headline back here." }
      : { title: "Copy failed", description: "Couldn't access the clipboard.", variant: "destructive" });
  }

  // AI Clip Finder: prompt asks Gemini to watch the whole video and return the best moments as
  // "HH:MM:SS - HH:MM:SS | Headline" lines. The user pastes them back and applyClipSuggestions
  // parses them into clip entries. Server makes no AI calls (same bridge pattern as hook/zoom).
  async function copyClipFinderPrompt() {
    const values = form.getValues();
    const hasUrl = !!(values.youtubeUrl && values.youtubeUrl.trim());
    const prompt =
      `You are an expert short-form video editor hunting for viral moments to cut from a longer video.\n` +
      (hasUrl
        ? `Open and WATCH this video, then base every pick on what ACTUALLY happens — do not guess:\nVideo: ${values.youtubeUrl}\n`
        : `(Add the source video URL first, or describe/paste the video to Gemini.)\n`) +
      `Find the 3 to 5 most viral, hook-worthy moments to turn into vertical YouTube Shorts. ` +
      `Each clip should be a self-contained 15-60 second beat — a reaction, punchline, reveal, or key moment.\n` +
      (values.sourceChannel ? `Source channel: ${values.sourceChannel}.\n` : "") +
      `For EACH clip give the START and END time as ABSOLUTE timestamps in the source video (HH:MM:SS), plus a punchy 4-7 word headline.\n` +
      `Return ONLY one clip per line, in EXACTLY this format, and NOTHING else:\n` +
      `HH:MM:SS - HH:MM:SS | Headline Here\n` +
      `Example:\n` +
      `00:01:12 - 00:01:34 | He Didn't See That Coming\n` +
      `00:04:47 - 00:05:20 | The Bet That Changed Everything`;
    const ok = await copyTextToClipboard(prompt);
    toast(ok
      ? { title: "Clip-finder prompt copied", description: "Paste it into Gemini, then paste its clip list into the box below." }
      : { title: "Copy failed", description: "Couldn't access the clipboard.", variant: "destructive" });
  }

  // Turns whatever the user pasted from Gemini into clip entries. If the form still holds just
  // the untouched default clip, replace it; otherwise append (respecting MAX_CLIPS).
  function applyClipSuggestions() {
    const parsed = parseClipSuggestions(suggestText);
    if (parsed.length === 0) {
      toast({ title: "No clips found", description: "Paste Gemini's lines like  00:01:12 - 00:01:34 | Headline", variant: "destructive" });
      return;
    }
    const entries = parsed.map((p) => ({ ...defaultClip, startTime: p.startTime, endTime: p.endTime, headline: p.headline }));
    const cur = form.getValues("clips");
    const onlyDefault =
      cur.length === 1 &&
      !cur[0]?.headline?.trim() &&
      cur[0]?.startTime === defaultClip.startTime &&
      cur[0]?.endTime === defaultClip.endTime;
    let added: number;
    if (onlyDefault) {
      const next = entries.slice(0, MAX_CLIPS);
      replace(next);
      added = next.length;
    } else {
      const room = Math.max(0, MAX_CLIPS - cur.length);
      const toAdd = entries.slice(0, room);
      toAdd.forEach((e) => append(e));
      added = toAdd.length;
    }
    setSuggestText("");
    toast({
      title: `${added} clip${added === 1 ? "" : "s"} added`,
      description: added < parsed.length
        ? `Capped at ${MAX_CLIPS} clips. Review times & headlines, then Enqueue.`
        : "Review the times & headlines, then Enqueue.",
    });
  }

  /* ---------- Story mode (Feature 2) ---------- */

  // Bridge prompt: asks Gemini for 9-10 ordered moments + bridging narration on the
  // stitched timeline. Same human-in-the-loop pattern — no server AI call.
  async function copyStoryPrompt() {
    const hasUrl = !!storyUrl.trim();
    const prompt =
      `ROLE: You are a world-class short-form editor building ONE tight 60-120 second STORY from a longer video — a single narrative with a clear arc (hook → escalation → payoff) that holds viewers to the very end.\n` +
      (hasUrl
        ? `WATCH this video and base every pick on what ACTUALLY happens — never guess a timestamp:\nVideo: ${storyUrl}\n`
        : `(Add the source video URL first, or describe the video to Gemini so it picks real moments.)\n`) +
      (storyCreator ? `Source channel: ${storyCreator}.\n` : "") +
      `SELECT 9-10 moments that, IN ORDER, tell ONE escalating story:\n` +
      `- Moment 1 is the HOOK — the single most curiosity-grabbing beat, even if it happens later in the source.\n` +
      `- Each following moment RAISES the stakes; save the biggest payoff for last.\n` +
      `- Every moment is a self-contained 6-12s beat with clear visual action (no dead air, no slow lead-ins).\n` +
      `- Drop anything that repeats a beat you already have — each moment must add something NEW.\n` +
      `For EACH moment give START and END as ABSOLUTE source timestamps (HH:MM:SS) + a punchy 4-7 word headline.\n` +
      `THEN write bridging NARRATION on the FINAL stitched timeline (0 = start of the stitched video, NOT the source). Each line should open a curiosity gap that pulls the viewer into the next moment (e.g. "But that wasn't even the crazy part...") — short, spoken aloud naturally, and NOT just describing what's already on screen. Put one line near 0s as the hook; time the rest as whole seconds from the stitched start, at least 3s apart.\n` +
      `Return EXACTLY this format and NOTHING else:\n` +
      `SEGMENTS:\n` +
      `HH:MM:SS - HH:MM:SS | Headline\n` +
      `...\n` +
      `NARRATION:\n` +
      `SS | bridging line\n` +
      `...\n\n` +
      `Example:\n` +
      `SEGMENTS:\n` +
      `00:01:12 - 00:01:26 | He Didn't See It Coming\n` +
      `00:04:47 - 00:05:03 | The Bet That Changed Everything\n` +
      `NARRATION:\n` +
      `0 | It started as an ordinary bet.\n` +
      `16 | But that was only the beginning.`;
    const ok = await copyTextToClipboard(prompt);
    toast(ok
      ? { title: "Story prompt copied", description: "Paste it into Gemini, then paste its reply into the box below." }
      : { title: "Copy failed", description: "Couldn't access the clipboard.", variant: "destructive" });
  }

  // Parses Gemini's reply into SEGMENTS (reusing parseClipSuggestions) + a NARRATION block.
  function applyStoryPaste() {
    const text = storyPaste;
    const nIdx = text.search(/narration\s*:/i);
    let segBlock = text;
    let narrBlock = "";
    if (nIdx >= 0) {
      segBlock = text.slice(0, nIdx);
      narrBlock = text.slice(nIdx).replace(/^[^\n]*\n?/, ""); // drop the "NARRATION:" label line
    }
    segBlock = segBlock.replace(/segments\s*:/i, "");
    const parsedSegs = parseClipSuggestions(segBlock).slice(0, 10);
    if (parsedSegs.length < 2) {
      toast({ title: "No story found", description: "Paste Gemini's SEGMENTS lines like  00:01:12 - 00:01:26 | Headline", variant: "destructive" });
      return;
    }
    const narration = narrBlock
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d{1,2}(:\d{2})?\s*\|/.test(l))
      .join("\n");
    setStorySegments(parsedSegs.map((p) => ({ startTime: p.startTime, endTime: p.endTime, headline: p.headline })));
    if (narration) setStoryNarration(narration);
    setStoryPaste("");
    toast({ title: `${parsedSegs.length} moments added`, description: narration ? "Segments + narration filled. Review, then Enqueue." : "Segments filled. Add narration, then Enqueue." });
  }

  function updateStorySeg(i: number, patch: Partial<StorySeg>) {
    setStorySegments((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  async function submitStory() {
    if (!storyUrl.trim() || !/(youtube\.com|youtu\.be)/.test(storyUrl)) {
      toast({ title: "Add a valid YouTube URL", variant: "destructive" });
      return;
    }
    const valid = storySegments.filter(
      (s) => /^\d{2}:\d{2}:\d{2}$/.test(s.startTime) && /^\d{2}:\d{2}:\d{2}$/.test(s.endTime) && toSecs(s.endTime) > toSecs(s.startTime),
    );
    if (valid.length < 2) {
      toast({ title: "Need at least 2 valid segments", description: "Each moment needs a start and end (end after start).", variant: "destructive" });
      return;
    }
    setStorySubmitting(true);
    try {
      const r = await fetch(`${API_BASE}/api/clips/story`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          youtubeUrl: storyUrl,
          frameStyle: wFrame,
          sourceChannel: storyCreator,
          captionsEnabled: storyCaptions,
          outroEnabled: storyOutro,
          captionColor: "#FFF400",
          narrationScript: storyNarration,
          voiceoverVoice: voVoice,
          voiceoverSpeed: voSpeed,
          segments: valid.slice(0, 10),
        }),
      });
      if (!r.ok) {
        let msg = "Failed to create story";
        try { msg = ((await r.json()) as { error?: string }).error ?? msg; } catch { /* ignore */ }
        throw new Error(msg);
      }
      queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
      toast({ title: "Story job enqueued", description: "It renders each moment, stitches them, then narrates — watch the Timeline." });
      setStorySegments([
        { startTime: "00:00:00", endTime: "00:00:15", headline: "" },
        { startTime: "00:00:00", endTime: "00:00:15", headline: "" },
      ]);
      setStoryNarration("");
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    } finally {
      setStorySubmitting(false);
    }
  }

  /* ---------- Top 5 mode ---------- */

  // Research brief for Gemini. Research is the make-or-break of these videos, so this is
  // a full brief (evidence → rubric → final 5 + alternates), not just a format spec.
  async function copyTop5Prompt() {
    const topic = t5Topic.trim() || "<your topic — e.g. Top 5 craziest F1 crashes ever>";
    const single = !t5MultiSource;
    const sourceRule = single
      ? `ALL five moments are inside THIS ONE video: ${t5Url.trim() || "<paste the source video URL first>"}\n  Only use timestamps within THAT video — do not reference any other video.`
      : `Use ONLY real, public YouTube videos that actually contain the moment. NEVER invent a URL, channel, or video. If unsure a video is real & public, drop it and pick another.`;
    const outputBlock = single
      ? `TITLE: <the video's title>\nMOMENTS:\n5 | HH:MM:SS - HH:MM:SS | <channel> | <headline> | Number five: <narration> | why: <reason>\n4 | ...\n3 | ...\n2 | ...\n1 | HH:MM:SS - HH:MM:SS | <channel> | <headline> | Number one: <narration> | why: <reason>`
      : `TITLE: <the video's title>\nMOMENTS:\n5 | <youtube url> | HH:MM:SS - HH:MM:SS | <channel> | <headline> | Number five: <narration> | why: <reason>\n4 | ...\n3 | ...\n2 | ...\n1 | <youtube url> | HH:MM:SS - HH:MM:SS | <channel> | <headline> | Number one: <narration> | why: <reason>\nALTERNATES:\n<youtube url> | HH:MM:SS - HH:MM:SS | <channel> | <what it is>   (2-3 backups if a video above is unavailable)`;
    const prompt =
`ROLE: You are a world-class YouTube compilation researcher building the DEFINITIVE "Top 5" countdown for the topic below. The PICKS are everything — a great edit can't save weak moments — so base every choice on real evidence, not memory.

TOPIC: ${topic}

USE YOUR TOOLS: search the web / run deep research. Judge candidates using existing "best of / top 10" lists & articles, view counts, other popular compilations, Reddit/forum/comment consensus, and official highlight reels.

STEP 1 (internal): gather 12-20 candidate moments; note how iconic each is + where the clip lives.
STEP 2 (internal): rank by — Notoriety (instantly recognizable?) · Peak intensity (shock/awe/hype/drama/laughter) · Consensus (do sources/community agree?) · Clean source (real public video that clearly shows it) · Variety (5 distinct clips).
STEP 3: pick the FINAL 5, ordered 5 → 1, best/most-agreed moment as #1 (the finale).

HARD RULES:
- ${sourceRule}
- Timestamp = best estimate, ABSOLUTE HH:MM:SS - HH:MM:SS, 6-15s, tight on the moment (I verify & fine-tune every one — close is fine, wild guesses are not).
- CHECK THE LENGTH first: confirm each source video's real duration and keep BOTH times inside it — never past the end. Prefer moments a narrator names on-camera (so a wrong time can be auto-recovered from the transcript).
- HEADLINE: punchy 4-7 word on-screen title.
- NARRATION: one line starting with the rank ("Number five: ..."), under 12 words, hype building to #1.
- After each pick add "why:" — one honest line on why it ranks there.

OUTPUT — return EXACTLY this and nothing else (fields separated by " | "):
${outputBlock}`;
    const ok = await copyTextToClipboard(prompt);
    toast(ok
      ? { title: "Research prompt copied", description: "Run it in Gemini 2.5 Pro · Deep Research, then paste its reply below." }
      : { title: "Copy failed", description: "Couldn't access the clipboard.", variant: "destructive" });
  }

  // Parses Gemini's reply. Strips zero-width chars (Gemini injects them on section headers),
  // reads TITLE + the MOMENTS block (ignores ALTERNATES), and tolerates the single-source
  // variant where the URL field is absent by locating fields by shape, not position.
  function applyTop5Paste() {
    const text = t5Paste.replace(/[​‌‍﻿⁠]/g, "");
    const titleMatch = text.match(/^\s*TITLE\s*:\s*(.+)$/im);
    if (titleMatch && titleMatch[1].trim() && !t5Topic.trim()) {
      setT5Topic(titleMatch[1].trim().slice(0, 120));
    }
    let body = text;
    const altIdx = body.search(/ALTERNATES\s*:/i);
    if (altIdx >= 0) body = body.slice(0, altIdx);

    const timeRe = /(\d{1,2}:\d{1,2}(?::\d{1,2})?)\s*(?:-|–|—|to|→)\s*(\d{1,2}:\d{1,2}(?::\d{1,2})?)/;
    const segs: Top5Seg[] = [];
    for (const rawLine of body.split(/\r?\n/)) {
      const m = rawLine.trim().match(/^(\d{1,2})\s*\|(.+)$/);
      if (!m) continue;
      const rank = Number(m[1]);
      if (!Number.isFinite(rank) || rank < 1) continue;
      const fields = m[2].split("|").map((f) => f.trim()).filter((f) => f.length > 0);
      const timeField = fields.find((f) => timeRe.test(f));
      if (!timeField) continue;
      const tm = timeField.match(timeRe)!;
      const urlField = fields.find((f) => /^https?:\/\//i.test(f)) ?? "";
      const rest = fields.filter((f) => f !== urlField && f !== timeField && !/^why\s*:/i.test(f));
      segs.push({
        rank,
        youtubeUrl: urlField,
        startTime: padHMS(tm[1]),
        endTime: padHMS(tm[2]),
        sourceChannel: (rest[0] ?? "").slice(0, 80),
        headline: (rest[1] ?? "").slice(0, 120),
        narrationLine: (rest[2] ?? "").replace(/\s*\|?\s*why\s*:.*$/i, "").trim().slice(0, 200),
        verify: null,
      });
    }
    if (segs.length < 2) {
      toast({ title: "Couldn't read the moments", description: "Paste Gemini's MOMENTS lines like  5 | url | 00:00:22 - 00:00:35 | Channel | Headline | Number five: …", variant: "destructive" });
      return;
    }
    segs.sort((a, b) => b.rank - a.rank);
    if (segs.some((s) => s.youtubeUrl)) setT5MultiSource(true);
    setT5Segments(segs);
    setT5Paste("");
    toast({ title: `${segs.length} moments loaded`, description: "Review, Verify timestamps, then Enqueue." });
  }

  function updateT5Seg(i: number, patch: Partial<Top5Seg>) {
    setT5Segments((prev) => prev.map((s, idx) => {
      if (idx !== i) return s;
      const next = { ...s, ...patch };
      // Editing time or URL invalidates a prior verify result.
      if (patch.startTime !== undefined || patch.endTime !== undefined || patch.youtubeUrl !== undefined) next.verify = null;
      return next;
    }));
  }

  async function verifyTop5() {
    if (!t5MultiSource && !/(youtube\.com|youtu\.be)/.test(t5Url)) {
      toast({ title: "Add the source URL first", variant: "destructive" });
      return;
    }
    const payload = t5Segments
      .filter((s) => /^\d{2}:\d{2}:\d{2}$/.test(s.startTime) && /^\d{2}:\d{2}:\d{2}$/.test(s.endTime))
      .map((s) => ({ rank: s.rank, youtubeUrl: t5MultiSource ? s.youtubeUrl : t5Url, startTime: s.startTime, endTime: s.endTime, headline: s.headline, narrationLine: s.narrationLine }));
    if (payload.length === 0) {
      toast({ title: "Nothing to verify", description: "Add valid in/out times first.", variant: "destructive" });
      return;
    }
    setT5Verifying(true);
    try {
      const r = await fetch(`${API_BASE}/api/clips/top5/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtubeUrl: t5MultiSource ? "" : t5Url, segments: payload }),
      });
      const data = (await r.json()) as { results?: { rank: number; ok: boolean; message: string | null; videoDuration?: number | null; suggested?: { startTime: string; endTime: string; confidence: number; evidence: string } | null }[]; error?: string };
      if (!r.ok) throw new Error(data.error ?? "Verify failed");
      const byRank = new Map((data.results ?? []).map((x) => [x.rank, x]));
      setT5Segments((prev) => prev.map((s) => {
        const v = byRank.get(s.rank);
        return v ? { ...s, verify: { ok: v.ok, message: v.message, videoDuration: v.videoDuration ?? null, suggested: v.suggested ?? null } } : s;
      }));
      const bad = (data.results ?? []).filter((x) => !x.ok).length;
      toast(bad
        ? { title: `${bad} moment${bad > 1 ? "s" : ""} out of range`, description: "Fix the flagged timestamps, then re-verify.", variant: "destructive" }
        : { title: "All timestamps look valid", description: "You're clear to enqueue." });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Verify failed", variant: "destructive" });
    } finally {
      setT5Verifying(false);
    }
  }

  // Fallback when a flagged moment has no transcript match (wrong video, or no captions):
  // copies a surgical prompt asking Gemini to fix ONLY the broken moments, armed with each
  // video's real length so it re-locates within range (or swaps in a correct video).
  async function reaskTop5Flagged() {
    const flagged = t5Segments.filter((s) => s.verify && !s.verify.ok);
    if (flagged.length === 0) {
      toast({ title: "Nothing flagged", description: "Run Verify timestamps first.", variant: "destructive" });
      return;
    }
    const blocks = flagged.map((s) => {
      const url = (t5MultiSource ? s.youtubeUrl : t5Url) || "<video url>";
      const len = s.verify?.videoDuration
        ? `${Math.floor(s.verify.videoDuration / 60)}:${String(Math.round(s.verify.videoDuration % 60)).padStart(2, "0")}`
        : "its real length";
      return `#${s.rank} — ${s.headline || s.narrationLine || "(this moment)"}\n  video: ${url}\n  This video is only ${len} long, but you gave ${s.startTime}–${s.endTime} (out of range). WATCH it and reply with a corrected timestamp WITHIN ${len}. If the moment isn't actually in this video, replace it with a real public YouTube video that clearly shows it, and give that video's URL + timestamp.`;
    }).join("\n\n");
    const prompt =
`These Top 5 moments have out-of-range timestamps. Fix ONLY these — verify each video's real length first, then reply with corrected lines in this exact format (one per moment):
<rank> | <youtube url> | HH:MM:SS - HH:MM:SS | <channel> | <headline> | Number <n>: <narration>

${blocks}`;
    const ok = await copyTextToClipboard(prompt);
    toast(ok
      ? { title: "Re-ask prompt copied", description: "Run it in Gemini, paste the reply into the box above, then re-Verify." }
      : { title: "Copy failed", description: "Couldn't access the clipboard.", variant: "destructive" });
  }

  async function submitTop5() {
    if (!t5MultiSource && !/(youtube\.com|youtu\.be)/.test(t5Url)) {
      toast({ title: "Add a valid source URL", variant: "destructive" });
      return;
    }
    const valid = t5Segments.filter((s) =>
      /^\d{2}:\d{2}:\d{2}$/.test(s.startTime) &&
      /^\d{2}:\d{2}:\d{2}$/.test(s.endTime) &&
      toSecs(s.endTime) > toSecs(s.startTime) &&
      (t5MultiSource ? /(youtube\.com|youtu\.be)/.test(s.youtubeUrl) : true)
    );
    if (valid.length < 2) {
      toast({ title: "Need at least 2 complete moments", description: t5MultiSource ? "Each moment needs a URL and a valid in/out." : "Each moment needs a valid in/out.", variant: "destructive" });
      return;
    }
    if (t5Segments.some((s) => s.verify && !s.verify.ok)) {
      toast({ title: "Fix flagged timestamps first", description: "A moment is out of range — re-verify after fixing.", variant: "destructive" });
      return;
    }
    setT5Submitting(true);
    try {
      const r = await fetch(`${API_BASE}/api/clips/top5`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: t5Topic,
          youtubeUrl: t5MultiSource ? "" : t5Url,
          frameStyle: wFrame,
          sourceChannel: t5Creator,
          captionsEnabled: t5Captions,
          outroEnabled: t5Outro,
          captionColor: "#FFF400",
          order: t5Order,
          voiceoverVoice: voVoice,
          voiceoverSpeed: voSpeed,
          segments: valid.map((s) => ({
            rank: s.rank,
            youtubeUrl: t5MultiSource ? s.youtubeUrl : t5Url,
            startTime: s.startTime,
            endTime: s.endTime,
            headline: s.headline,
            sourceChannel: s.sourceChannel,
            narrationLine: s.narrationLine,
          })),
        }),
      });
      if (!r.ok) {
        let msg = "Failed to create Top 5";
        try { msg = ((await r.json()) as { error?: string }).error ?? msg; } catch { /* ignore */ }
        throw new Error(msg);
      }
      queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
      toast({ title: "Top 5 job enqueued", description: "It renders each moment, badges + stitches them, then narrates — watch the Timeline." });
      setT5Segments(defaultTop5());
      setT5Paste("");
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    } finally {
      setT5Submitting(false);
    }
  }

  /* ---------- Match Story mode (research-driven, multi-source narrated montage) ---------- */

  // The research brain. Research is the make-or-break of these videos, so this is a full
  // deep-research brief: pick the single most viral SEQUENCE of a match, source a REAL
  // public video per beat (multi-angle encouraged), and write DENSE play-by-play narration
  // on the stitched timeline. Same human-in-the-loop pattern — the server makes no AI call.
  async function copyMatchStoryPrompt() {
    const topic = msTopic.trim() || "<the match — e.g. Argentina vs Cape Verde, [date]>";
    const prompt =
`ROLE: You are a world-class football short-form researcher + editor. Build ONE 60-90 second vertical "story" montage about the match below, told as a single dramatic arc (hook → escalation → payoff) that holds viewers to the very end. The PICKS are everything — a great edit can't save weak moments — so base every choice on real evidence, not memory.

MATCH / TOPIC: ${topic}
${msCreator.trim() ? `Preferred channel/credit: ${msCreator.trim()}.\n` : ""}
USE YOUR TOOLS: search the web + run deep research. Identify the single most viral, most-talked-about SEQUENCE of this match (a goal build-up, a controversy, a comeback, a red card) using highlight reels, news clips, Reddit/forum/comment consensus and view counts.

SELECT 4-8 beats that, IN ORDER, tell that one sequence:
- Beat 1 is the HOOK — the single most curiosity-grabbing moment.
- Each following beat RAISES the stakes; save the biggest payoff for last.
- Every beat is a self-contained 6-12s window with clear visual action (no dead air).
- For EACH beat find a REAL, PUBLIC YouTube video that clearly shows it — DIFFERENT videos / camera angles are encouraged (broadcast, fan cam, club upload). NEVER invent a URL; if unsure a video is real & public, drop it and pick another.
- Timestamp = best estimate, ABSOLUTE HH:MM:SS - HH:MM:SS, tight on the action. CHECK each video's real length first and keep BOTH times inside it (I verify & fine-tune every one — close is fine, wild guesses are not). Prefer moments a commentator names on-camera so a wrong time can be auto-recovered from the transcript.

For EACH beat, write ONE punchy commentator line (6-16 words) that narrates THAT beat and advances the story — hype tone, curiosity/tension building to the payoff. It's spoken OVER that beat and the beat is auto-timed to it, so don't reference other beats or absolute timestamps.

OUTPUT — return EXACTLY this and nothing else (fields separated by " | "):
TITLE: <4-7 word title>
BEATS:
<youtube url> | HH:MM:SS - HH:MM:SS | <channel> | <headline> | <one narration line for this beat>
...

Example:
TITLE: Messi's Free Kick Masterclass
BEATS:
https://youtu.be/abcd | 00:12:04 - 00:12:12 | FIFA | The Wall Sets Up | Ninety-third minute — one last chance, and Messi stands over it.
https://youtu.be/efgh | 00:00:31 - 00:00:41 | ESPN | He Curls It In | He whips it up and over the wall — the keeper never even moved.`;
    const ok = await copyTextToClipboard(prompt);
    toast(ok
      ? { title: "Research prompt copied", description: "Run it in Gemini 2.5 Pro · Deep Research, then paste its reply below." }
      : { title: "Copy failed", description: "Couldn't access the clipboard.", variant: "destructive" });
  }

  // Parses Gemini's reply: TITLE + a BEATS block where each line is
  //   <url> | HH:MM:SS - HH:MM:SS | <channel> | <headline> | <narration line>
  // (fields located by shape, not position). Still honors a legacy separate NARRATION
  // block if the older prompt was used. Strips the zero-width chars Gemini injects.
  function applyMatchStoryPaste() {
    const text = msPaste.replace(/[​‌‍﻿⁠]/g, "");
    const titleMatch = text.match(/^\s*TITLE\s*:\s*(.+)$/im);
    if (titleMatch && titleMatch[1].trim() && !msTopic.trim()) {
      setMsTopic(titleMatch[1].trim().slice(0, 120));
    }
    const nIdx = text.search(/narration\s*:/i);
    let segBlock = nIdx >= 0 ? text.slice(0, nIdx) : text;
    const narrBlock = nIdx >= 0 ? text.slice(nIdx).replace(/^[^\n]*\n?/, "") : "";
    segBlock = segBlock.replace(/(?:beats|segments)\s*:/i, "").replace(/^\s*TITLE\s*:.*$/im, "");

    const timeRe = /(\d{1,2}:\d{1,2}(?::\d{1,2})?)\s*(?:-|–|—|to|→)\s*(\d{1,2}:\d{1,2}(?::\d{1,2})?)/;
    const segs: MatchSeg[] = [];
    for (const rawLine of segBlock.split(/\r?\n/)) {
      if (!timeRe.test(rawLine)) continue;
      const fields = rawLine.split("|").map((f) => f.trim()).filter((f) => f.length > 0);
      const timeField = fields.find((f) => timeRe.test(f));
      if (!timeField) continue;
      const tm = timeField.match(timeRe)!;
      const urlField = fields.find((f) => /^https?:\/\//i.test(f)) ?? "";
      if (!urlField) continue; // Match Story beats are multi-source — each needs its own URL
      const rest = fields.filter((f) => f !== urlField && f !== timeField);
      segs.push({
        youtubeUrl: urlField,
        startTime: padHMS(tm[1]),
        endTime: padHMS(tm[2]),
        sourceChannel: (rest[0] ?? "").slice(0, 80),
        headline: (rest[1] ?? "").slice(0, 120),
        narrationLine: (rest[2] ?? "").replace(/\s*\|?\s*why\s*:.*$/i, "").trim().slice(0, 200),
        verify: null,
      });
      if (segs.length >= 8) break;
    }
    if (segs.length < 2) {
      toast({ title: "Couldn't read the beats", description: "Paste BEATS lines like  https://youtu.be/… | 00:01:12 - 00:01:24 | Channel | Headline | Narration line", variant: "destructive" });
      return;
    }
    const narration = narrBlock
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d{1,2}(:\d{2})?\s*\|/.test(l))
      .join("\n");
    setMsSegments(segs);
    if (narration) setMsNarration(narration);
    setMsPaste("");
    const withNarr = segs.filter((s) => s.narrationLine).length;
    toast({ title: `${segs.length} beats loaded`, description: withNarr ? `${withNarr} with narration. Verify timestamps, then Enqueue.` : "Beats filled. Add a line per beat, then Enqueue." });
  }

  function updateMsSeg(i: number, patch: Partial<MatchSeg>) {
    setMsSegments((prev) => prev.map((s, idx) => {
      if (idx !== i) return s;
      const next = { ...s, ...patch };
      // Editing time or URL invalidates a prior verify result.
      if (patch.startTime !== undefined || patch.endTime !== undefined || patch.youtubeUrl !== undefined) next.verify = null;
      return next;
    }));
  }

  // Match Story verify: send every beat (in order) to the dedicated /matchstory/verify
  // endpoint — timestamp-in-video check + transcript auto-locate (using the beat's headline
  // AND narration line for a better match). Results come back keyed by array index.
  async function verifyMatchStory() {
    const ok = msSegments.some((s) => /^\d{2}:\d{2}:\d{2}$/.test(s.startTime) && /^\d{2}:\d{2}:\d{2}$/.test(s.endTime) && /(youtube\.com|youtu\.be)/.test(s.youtubeUrl));
    if (!ok) {
      toast({ title: "Nothing to verify", description: "Add a source URL + valid in/out on each beat first.", variant: "destructive" });
      return;
    }
    const payload = msSegments.map((s) => ({ youtubeUrl: s.youtubeUrl, startTime: s.startTime, endTime: s.endTime, headline: s.headline, narrationLine: s.narrationLine }));
    setMsVerifying(true);
    try {
      const r = await fetch(`${API_BASE}/api/clips/matchstory/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: payload }),
      });
      const data = (await r.json()) as { results?: { index: number; ok: boolean; reason?: string | null; message: string | null; videoDuration?: number | null; suggested?: { startTime: string; endTime: string; confidence: number; evidence: string } | null }[]; error?: string };
      if (!r.ok) throw new Error(data.error ?? "Verify failed");
      const byIndex = new Map((data.results ?? []).map((x) => [x.index, x]));
      setMsSegments((prev) => prev.map((s, i) => {
        const v = byIndex.get(i);
        return v ? { ...s, verify: { ok: v.ok, reason: v.reason ?? null, message: v.message, videoDuration: v.videoDuration ?? null, suggested: v.suggested ?? null } } : s;
      }));
      const bad = (data.results ?? []).filter((x) => !x.ok).length;
      const unchecked = (data.results ?? []).filter((x) => x.ok && x.reason === "unverified").length;
      toast(bad
        ? { title: `${bad} beat${bad > 1 ? "s" : ""} out of range`, description: "Fix the flagged timestamps, then re-verify.", variant: "destructive" }
        : unchecked
          ? { title: `Couldn't check ${unchecked} beat${unchecked > 1 ? "s" : ""}`, description: "YouTube length lookup failed (phone busy/throttled) — re-verify, or it's re-checked at render.", variant: "destructive" }
          : { title: "All timestamps look valid", description: "You're clear to enqueue." });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Verify failed", variant: "destructive" });
    } finally {
      setMsVerifying(false);
    }
  }

  // Fallback for a flagged beat with no transcript match: a surgical prompt to fix ONLY
  // the broken beats, armed with each video's real length so Gemini re-locates in range
  // (or swaps in a correct video).
  async function reaskMatchFlagged() {
    const flagged = msSegments.map((s, i) => ({ s, n: i + 1 })).filter(({ s }) => s.verify && !s.verify.ok);
    if (flagged.length === 0) {
      toast({ title: "Nothing flagged", description: "Run Verify timestamps first.", variant: "destructive" });
      return;
    }
    const blocks = flagged.map(({ s, n }) => {
      const url = s.youtubeUrl || "<video url>";
      const len = s.verify?.videoDuration
        ? `${Math.floor(s.verify.videoDuration / 60)}:${String(Math.round(s.verify.videoDuration % 60)).padStart(2, "0")}`
        : "its real length";
      return `Beat #${n} — ${s.headline || "(this beat)"}\n  video: ${url}\n  narration: ${s.narrationLine || "(write one punchy line)"}\n  This video is only ${len} long, but you gave ${s.startTime}–${s.endTime} (out of range). WATCH it and reply with a corrected timestamp WITHIN ${len}. If the moment isn't actually in this video, replace it with a real public YouTube video that clearly shows it, and give that video's URL + timestamp.`;
    }).join("\n\n");
    const prompt =
`These Match Story beats have out-of-range timestamps. Fix ONLY these — verify each video's real length first, then reply with corrected lines in this exact format (one per beat), keeping the same headline + narration:
<youtube url> | HH:MM:SS - HH:MM:SS | <channel> | <headline> | <narration line>

${blocks}`;
    const ok = await copyTextToClipboard(prompt);
    toast(ok
      ? { title: "Re-ask prompt copied", description: "Run it in Gemini, paste the reply into the box above, then re-Verify." }
      : { title: "Copy failed", description: "Couldn't access the clipboard.", variant: "destructive" });
  }

  async function submitMatchStory() {
    const valid = msSegments.filter((s) =>
      // Local (scout) beats need only a file; YouTube beats need a valid URL + in/out.
      (s.sourceType === "local" && !!s.localFile) ||
      (/^\d{2}:\d{2}:\d{2}$/.test(s.startTime) &&
        /^\d{2}:\d{2}:\d{2}$/.test(s.endTime) &&
        toSecs(s.endTime) > toSecs(s.startTime) &&
        /(youtube\.com|youtu\.be)/.test(s.youtubeUrl))
    );
    if (valid.length < 2) {
      toast({ title: "Need at least 2 complete beats", description: "Each beat needs a source (URL or scouted clip) and a valid in/out.", variant: "destructive" });
      return;
    }
    if (msSegments.some((s) => s.verify && !s.verify.ok)) {
      toast({ title: "Fix flagged timestamps first", description: "A beat is out of range — re-verify after fixing.", variant: "destructive" });
      return;
    }
    setMsSubmitting(true);
    try {
      const r = await fetch(`${API_BASE}/api/clips/matchstory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: msTopic,
          frameStyle: wFrame,
          sourceChannel: msCreator,
          captionsEnabled: msCaptions,
          outroEnabled: msOutro,
          captionColor: "#FFF400",
          narrationScript: msNarration,
          transitionsEnabled: msTransitions,
          titleCardEnabled: msTitleCard,
          voiceoverVoice: voVoice,
          voiceoverSpeed: voSpeed,
          segments: valid.slice(0, 8).map((s) => (s.sourceType === "local"
            ? { sourceType: "local", localFile: s.localFile, startTime: s.startTime, endTime: s.endTime, headline: s.headline, sourceChannel: s.sourceChannel, narrationLine: s.narrationLine }
            : { youtubeUrl: s.youtubeUrl, startTime: s.startTime, endTime: s.endTime, headline: s.headline, sourceChannel: s.sourceChannel, narrationLine: s.narrationLine })),
        }),
      });
      if (!r.ok) {
        let msg = "Failed to create Match Story";
        try { msg = ((await r.json()) as { error?: string }).error ?? msg; } catch { /* ignore */ }
        throw new Error(msg);
      }
      queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
      toast({ title: "Match Story job enqueued", description: "It downloads each beat, stitches the montage, then narrates — watch the Timeline." });
      setMsSegments(defaultMatchStory());
      setMsNarration("");
      setMsPaste("");
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    } finally {
      setMsSubmitting(false);
    }
  }

  // ---------- Match Story 2.0 (clip-scout) ----------
  // Hook-first narration prompt for the SCOUTED beats (clips already exist + are in order, so
  // Gemini only writes the voiceover arc). Self-contained to MS 2.0.
  async function copyMs2NarrationPrompt() {
    if (ms2Beats.length < 2) { toast({ title: "Build at least 2 beats first", variant: "destructive" }); return; }
    const topic = ms2Topic.trim() || "<the topic of this montage>";
    const list = ms2Beats.map((s, i) => `${i + 1} | ${s.headline || "(clip)"} — ${s.sourceChannel || "?"}, ${fmtDuration(s.startTime, s.endTime)}`).join("\n");
    const prompt =
`ROLE: You are a viral short-form sports editor writing the VOICEOVER for a fast vertical montage titled "${topic}". I ALREADY have these clips, in THIS order. Write ONE punchy commentator line per clip so that together they tell a HOOK-FIRST story arc (hook → escalation → payoff) that holds viewers to the very end.

RULES:
- Clip 1's line is the HOOK — a curiosity-gap opener that makes people NOT scroll.
- Each line 6-16 words, present tense, hype commentator tone; ADVANCE the story, don't just describe what's on screen.
- Don't reference other clips, the montage, or timestamps.

CLIPS (in order):
${list}

OUTPUT — return EXACTLY one line per clip and nothing else:
1 | <narration for clip 1>
2 | <narration for clip 2>
...`;
    const ok = await copyTextToClipboard(prompt);
    toast(ok
      ? { title: "Narration prompt copied", description: "Run it in Gemini, then paste its numbered lines back below." }
      : { title: "Copy failed", variant: "destructive" });
  }

  function applyMs2NarrationPaste() {
    const text = ms2NarrPaste.replace(/[​‌‍﻿⁠]/g, "");
    const map = new Map<number, string>();
    for (const line of text.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d{1,2})\s*[|.):\-]\s*(.+)$/);
      if (!m) continue;
      const n = Number(m[1]);
      if (n) map.set(n, m[2].trim().slice(0, 200));
    }
    if (map.size === 0) { toast({ title: "Couldn't read the lines", description: "Paste numbered lines like  1 | Ninety-third minute…", variant: "destructive" }); return; }
    setMs2Beats((prev) => prev.map((s, i) => (map.has(i + 1) ? { ...s, narrationLine: map.get(i + 1)! } : s)));
    setMs2NarrPaste("");
    toast({ title: `Narration filled for ${map.size} beats`, description: "Review the lines, then Enqueue." });
  }

  function updateMs2Beat(i: number, patch: Partial<MatchSeg>) {
    setMs2Beats((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  async function submitMs2() {
    const beats = ms2Beats.filter((s) => s.localFile);
    if (beats.length < 2) { toast({ title: "Need at least 2 clips", variant: "destructive" }); return; }
    setMs2Submitting(true);
    try {
      const r = await fetch(`${API_BASE}/api/clips/matchstory`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: ms2Topic, frameStyle: wFrame, sourceChannel: msCreator,
          captionsEnabled: msCaptions, outroEnabled: msOutro, captionColor: "#FFF400",
          transitionsEnabled: msTransitions, titleCardEnabled: msTitleCard,
          voiceoverVoice: voVoice, voiceoverSpeed: voSpeed,
          segments: beats.slice(0, 8).map((s) => ({ sourceType: "local", localFile: s.localFile, startTime: s.startTime, endTime: s.endTime, headline: s.headline, sourceChannel: s.sourceChannel, narrationLine: s.narrationLine })),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed to enqueue");
      queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
      toast({ title: "Match Story 2.0 job enqueued", description: "It stitches your scouted clips, narrates, then renders — watch the Timeline." });
      setMs2Beats([]); setMs2Candidates([]); setMs2JobId(null); setMs2Status("");
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    } finally { setMs2Submitting(false); }
  }


  useEffect(() => {
    if (sourceTab === "matchstory2" && ms2Adapters.length === 0) {
      fetch(`${API_BASE}/api/scout/adapters`).then((r) => r.json()).then((d) => setMs2Adapters(d.adapters ?? [])).catch(() => {});
    }
  }, [sourceTab]);
  useEffect(() => () => { if (ms2Poll.current) clearInterval(ms2Poll.current); }, []);

  function toggleMs2Platform(p: string) {
    setMs2Platforms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  async function pollScout(id: string) {
    try {
      const r = await fetch(`${API_BASE}/api/scout/${id}`);
      const j = await r.json();
      if (!r.ok) return;
      setMs2Status(j.status); setMs2Progress(j.progress ?? 0); setMs2Message(j.message ?? "");
      setMs2Candidates(j.candidates ?? []);
      if (j.status === "ready" || j.status === "error") { if (ms2Poll.current) clearInterval(ms2Poll.current); }
    } catch { /* keep polling */ }
  }

  async function startScout() {
    const topic = ms2Topic.trim();
    if (topic.length < 2) { toast({ title: "Enter a topic to scout for", variant: "destructive" }); return; }
    if (ms2Platforms.length === 0) { toast({ title: "Pick at least one platform", variant: "destructive" }); return; }
    setMs2Candidates([]); setMs2Message(""); setMs2Status("searching"); setMs2Progress(2); setMs2JobId(null);
    try {
      const subs = ms2Subreddits.split(",").map((s) => s.trim()).filter(Boolean);
      const r = await fetch(`${API_BASE}/api/scout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, platforms: ms2Platforms, subreddits: subs, maxCandidates: 40 }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Scout failed");
      setMs2JobId(j.id);
      if (ms2Poll.current) clearInterval(ms2Poll.current);
      ms2Poll.current = setInterval(() => pollScout(j.id), 2500);
    } catch (e) {
      setMs2Status("error"); setMs2Message(e instanceof Error ? e.message : "Scout failed");
    }
  }

  async function toggleCandidate(candId: string, keep: boolean) {
    if (!ms2JobId) return;
    setMs2Candidates((prev) => prev.map((c) => (c.id === candId ? { ...c, status: keep ? "keep" : "drop" } : c)));
    try { await fetch(`${API_BASE}/api/scout/${ms2JobId}/candidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candId, status: keep ? "keep" : "drop" }) }); } catch { /* best effort */ }
  }

  async function buildScoutBeats() {
    if (!ms2JobId) return;
    const kept = ms2Candidates.filter((c) => c.status === "keep");
    if (kept.length < 2) { toast({ title: "Keep at least 2 clips first", variant: "destructive" }); return; }
    setMs2Building(true);
    try {
      const r = await fetch(`${API_BASE}/api/scout/${ms2JobId}/approve`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Build failed");
      const beats: MatchSeg[] = (j.beats ?? []).map((b: { localFile: string; startTime: string; endTime: string; headline: string; sourceChannel: string; narrationLine: string; thumbUrl: string | null }) => ({
        youtubeUrl: "", startTime: b.startTime, endTime: b.endTime,
        sourceChannel: b.sourceChannel ?? "", headline: b.headline ?? "", narrationLine: b.narrationLine ?? "",
        localFile: b.localFile, sourceType: "local" as const,
        thumbUrl: b.thumbUrl ? (b.thumbUrl.startsWith("http") ? b.thumbUrl : `${API_BASE}${b.thumbUrl}`) : undefined,
        verify: null,
      }));
      setMs2Beats(beats);
      toast({ title: `${beats.length} clips ready`, description: "Add a narration line per beat (or use the Gemini prompt below), then Enqueue." });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Build failed", variant: "destructive" });
    } finally { setMs2Building(false); }
  }

  async function onSubmit(values: FormValues) {
    let successCount = 0;
    const failReasons: string[] = [];

    for (const clip of values.clips) {
      try {
        const r = await fetch(`${API_BASE}/api/clips`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            youtubeUrl: values.youtubeUrl,
            frameStyle: values.frameStyle,
            startTime: clip.startTime,
            endTime: clip.endTime,
            headline: clip.headline ?? "",
            mode: clip.mode,
            sourceChannel: values.sourceChannel ?? "",
            captionsEnabled: clip.captionsEnabled ?? true,
            captionColor: clip.captionColor ?? "#FFF400",
            outroEnabled: clip.outroEnabled ?? true,
            punchInEnabled: clip.punchInEnabled ?? false,
            zoomMoments: clip.zoomMoments ?? "",
            voiceoverEnabled: clip.voiceoverEnabled ?? false,
            voiceoverHook: clip.voiceoverHook ?? "",
            voiceoverMode: clip.voiceoverMode ?? "hook",
            narrationScript: clip.narrationScript ?? "",
            voiceoverVoice: voVoice,
            voiceoverSpeed: voSpeed,
          }),
        });
        if (!r.ok) {
          let reason = "Failed";
          try { reason = ((await r.json()) as { error?: string }).error ?? reason; } catch { /* ignore */ }
          failReasons.push(reason);
        } else {
          successCount++;
        }
      } catch {
        failReasons.push("Network error");
      }
    }

    queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });

    if (successCount > 0) {
      toast({
        title: successCount === 1 ? "1 clip job enqueued" : `${successCount} clip jobs enqueued`,
        description: failReasons.length > 0 ? `${failReasons.length} failed: ${failReasons[0]}` : undefined,
      });
      form.reset({
        youtubeUrl: values.youtubeUrl,
        frameStyle: values.frameStyle,
        sourceChannel: values.sourceChannel,
        clips: [{ ...defaultClip }],
      });
    } else {
      toast({ title: "All submissions failed", description: failReasons[0], variant: "destructive" });
    }
  }

  const validateLocalForm = useCallback((): boolean => {
    const errors: typeof localErrors = {};
    if (!selectedFile) errors.file = "Please select a video file";
    const startValid = !!localForm.startTime.match(/^\d{2}:\d{2}:\d{2}$/);
    const endValid = !!localForm.endTime.match(/^\d{2}:\d{2}:\d{2}$/);
    if (!startValid) errors.startTime = "Must be HH:MM:SS";
    if (!endValid) errors.endTime = "Must be HH:MM:SS";
    if (startValid && endValid) {
      if (toSecs(localForm.endTime) <= toSecs(localForm.startTime))
        errors.endTime = "End time must be after start time";
    }
    if (localForm.mode === "edited" && !localForm.headline.trim())
      errors.headline = "Headline required for Edited mode";
    setLocalErrors(errors);
    return Object.keys(errors).length === 0;
  }, [selectedFile, localForm]);

  const handleLocalUpload = useCallback(async () => {
    if (!validateLocalForm() || !selectedFile) return;
    setIsUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("startTime", localForm.startTime);
    formData.append("endTime", localForm.endTime);
    formData.append("headline", localForm.headline);
    formData.append("mode", localForm.mode);
    formData.append("frameStyle", form.getValues("frameStyle"));
    formData.append("sourceChannel", localForm.sourceChannel ?? "");
    formData.append("captionsEnabled", String(localForm.captionsEnabled));

    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          setUploadProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        setIsUploading(false);
        setUploadProgress(null);
        if (xhr.status === 201) {
          toast({ title: "File uploaded — processing started" });
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
          setLocalForm({ startTime: "00:00:00", endTime: "00:01:00", headline: "", mode: "edited", sourceChannel: "", captionsEnabled: true });
          setLocalErrors({});
          queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
        } else {
          let msg = "Upload failed";
          try { msg = (JSON.parse(xhr.responseText) as { error: string }).error || msg; } catch { /* ignore */ }
          toast({ title: msg, variant: "destructive" });
        }
        resolve();
      };
      xhr.onerror = () => {
        setIsUploading(false);
        setUploadProgress(null);
        toast({ title: "Network error — upload failed", variant: "destructive" });
        resolve();
      };
      xhr.open("POST", `${API_BASE}/api/clips/upload`);
      xhr.send(formData);
    });
  }, [selectedFile, localForm, validateLocalForm, queryClient, toast, form]);

  const clipCount = fields.length;

  // ----- values driving the live preview -----
  const wFrame = form.watch("frameStyle");
  const wClip0 = form.watch("clips.0");
  const preview =
    sourceTab === "youtube"
      ? {
          headline: wClip0?.headline ?? "",
          mode: (wClip0?.mode ?? "edited") as "edited" | "raw",
          captions: wClip0?.captionsEnabled ?? true,
          voiceover: wClip0?.voiceoverEnabled ?? false,
          hook: wClip0?.voiceoverHook ?? "",
        }
      : {
          headline: localForm.headline,
          mode: localForm.mode,
          captions: localForm.captionsEnabled,
          voiceover: false,
          hook: "",
        };

  return (
    <div className="h-full bg-background text-foreground flex flex-col font-sans overflow-hidden">
      <AppHeader />

      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-6 md:py-8">
          {/* Page heading */}
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
            <Zap className="w-4 h-4 text-primary" /> New job definition
          </p>
          <h2 className="text-2xl font-extrabold tracking-tight">Create a Short</h2>
          <p className="text-sm text-muted-foreground mt-1 mb-6">
            Pick a source, mark your in/out points, and dispatch render jobs to the phone.
          </p>

          <div className="grid lg:grid-cols-[1fr_320px] gap-6 items-start">
            {/* LEFT — form */}
            <div className="min-w-0">
              {/* source + frame toolbar */}
              <div className="flex flex-wrap gap-3 mb-5">
                <Segmented
                  value={sourceTab}
                  onChange={(v) => { setSourceTab(v as SourceTab); setLocalErrors({}); }}
                  options={[
                    { value: "youtube", label: "YouTube", icon: <Youtube className="w-3.5 h-3.5" /> },
                    { value: "local", label: "Local file", icon: <Upload className="w-3.5 h-3.5" /> },
                    { value: "story", label: "Story", icon: <Film className="w-3.5 h-3.5" /> },
                    { value: "top5", label: "Top 5", icon: <Trophy className="w-3.5 h-3.5" /> },
                    { value: "matchstory", label: "Match Story", icon: <Zap className="w-3.5 h-3.5" /> },
                    { value: "matchstory2", label: "MS 2.0 · Scout", icon: <Sparkles className="w-3.5 h-3.5" /> },
                  ]}
                />
                <Segmented
                  value={wFrame}
                  onChange={(v) => form.setValue("frameStyle", v as "standard" | "immersive")}
                  options={[
                    { value: "immersive", label: "Immersive" },
                    { value: "standard", label: "Standard" },
                  ]}
                />
              </div>

              {sourceTab === "youtube" && (
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                  {/* URL + source creator card */}
                  <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-5 space-y-4">
                    <div>
                      <FieldLabel>Source URL</FieldLabel>
                      <div className="flex gap-2">
                        <Input
                          placeholder="https://youtube.com/watch?v=..."
                          className="font-mono text-sm bg-background flex-1 min-w-0"
                          {...form.register("youtubeUrl")}
                        />
                        {videoId && (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setShowPlayer((p) => !p)}
                            className={`font-mono text-xs tracking-wider border transition-colors shrink-0 ${
                              showPlayer
                                ? "border-primary/40 bg-primary/15 text-primary"
                                : "border-border bg-card text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            <MonitorPlay className="w-4 h-4" />
                            <span className="hidden sm:inline ml-2">{showPlayer ? "HIDE" : "PREVIEW"}</span>
                          </Button>
                        )}
                      </div>
                      {form.formState.errors.youtubeUrl && (
                        <p className="text-xs text-destructive font-mono mt-1.5">{form.formState.errors.youtubeUrl.message}</p>
                      )}
                    </div>

                    {showPlayer && videoId && (
                      <div className="rounded-lg border border-border overflow-hidden bg-black">
                        <div className="aspect-video w-full relative">
                          <div ref={playerDivRef} className="w-full h-full" />
                          {!playerReady && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black">
                              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                            </div>
                          )}
                        </div>
                        {playerReady && (
                          <div className="border-t border-border bg-card px-3 py-2 flex flex-wrap gap-2">
                            {fields.map((_, i) => (
                              <div key={i} className="flex items-center gap-1.5">
                                {clipCount > 1 && (
                                  <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">
                                    {String(i + 1).padStart(2, "0")}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleSetIn(i)}
                                  className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider border border-border bg-background hover:bg-muted rounded transition-colors"
                                >
                                  Set In
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleSetOut(i)}
                                  className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider border border-border bg-background hover:bg-muted rounded transition-colors"
                                >
                                  Set Out
                                </button>
                              </div>
                            ))}
                            <span className="text-[10px] font-mono text-muted-foreground/40 self-center ml-auto">
                              pause first, then set
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    <div>
                      <FieldLabel>Source creator <span className="text-muted-foreground/40 normal-case">(optional)</span></FieldLabel>
                      <Input
                        placeholder="e.g. KSI, MrBeast, IShowSpeed"
                        className="font-mono text-sm bg-background"
                        {...form.register("sourceChannel")}
                      />
                    </div>

                    {/* AI Clip Finder — bridge pattern: copy prompt → run in Gemini → paste clips back */}
                    <div className="rounded-lg border border-primary/30 bg-primary/[0.05] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-foreground flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-primary" /> AI Clip Finder
                          <span className="text-[8.5px] font-semibold tracking-[0.14em] text-primary border border-primary/40 rounded px-1.5 py-0.5 inline-flex items-center gap-1"><Sparkles className="w-2.5 h-2.5" />AI</span>
                        </span>
                        <button
                          type="button"
                          onClick={copyClipFinderPrompt}
                          className="text-[10px] font-mono uppercase tracking-[0.08em] text-primary hover:underline flex items-center gap-1.5 shrink-0"
                        >
                          <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                        </button>
                      </div>
                      <Textarea
                        value={suggestText}
                        onChange={(e) => setSuggestText(e.target.value)}
                        placeholder={"Paste Gemini's clips here — one per line:\n00:01:12 - 00:01:34 | Headline"}
                        className="text-sm bg-background mt-2.5 font-mono min-h-[72px]"
                      />
                      <button
                        type="button"
                        onClick={applyClipSuggestions}
                        disabled={!suggestText.trim()}
                        className="mt-2 w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-primary/40 py-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add clips from paste
                      </button>
                    </div>
                  </div>

                  {/* clip entries */}
                  <div className="space-y-3">
                    {fields.map((field, index) => {
                      const currentMode = form.watch(`clips.${index}.mode`);
                      const isRaw = currentMode === "raw";
                      const start = form.watch(`clips.${index}.startTime`);
                      const end = form.watch(`clips.${index}.endTime`);
                      const voOn = form.watch(`clips.${index}.voiceoverEnabled`) ?? false;
                      const voMode = form.watch(`clips.${index}.voiceoverMode`) ?? "hook";
                      const punchOn = form.watch(`clips.${index}.punchInEnabled`) ?? false;

                      return (
                        <div key={field.id} className="rounded-xl border border-border bg-background/40 overflow-hidden">
                          {/* clip header */}
                          <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                            <span className="font-mono text-[11px] text-primary bg-primary/[0.08] border border-primary/20 w-7 h-7 rounded-md grid place-items-center font-semibold tabular-nums">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <Segmented
                              value={currentMode}
                              onChange={(v) => form.setValue(`clips.${index}.mode`, v as "edited" | "raw")}
                              options={[
                                { value: "edited", label: "Edited" },
                                { value: "raw", label: "Raw" },
                              ]}
                            />
                            {clipCount > 1 && (
                              <button
                                type="button"
                                onClick={() => remove(index)}
                                className="ml-auto w-7 h-7 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors"
                                aria-label="Remove clip"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>

                          <div className="p-4 space-y-3.5">
                            {/* in / out / duration */}
                            <div className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
                              <div>
                                <FieldLabel>In</FieldLabel>
                                <Input
                                  placeholder="00:00:00"
                                  className={`font-mono text-sm bg-background ${form.formState.errors.clips?.[index]?.startTime ? "border-destructive" : ""}`}
                                  {...form.register(`clips.${index}.startTime`)}
                                />
                              </div>
                              <div>
                                <FieldLabel>Out</FieldLabel>
                                <Input
                                  placeholder="00:00:15"
                                  className={`font-mono text-sm bg-background ${form.formState.errors.clips?.[index]?.endTime ? "border-destructive" : ""}`}
                                  {...form.register(`clips.${index}.endTime`)}
                                />
                              </div>
                              <div className="font-mono text-[11px] text-primary border border-dashed border-primary/30 rounded-lg px-3 py-2.5 text-center whitespace-nowrap">
                                <span className="block text-[9px] text-muted-foreground/60 uppercase tracking-[0.12em]">Length</span>
                                {fmtDuration(start, end)}
                              </div>
                            </div>
                            {form.formState.errors.clips?.[index]?.endTime && (
                              <p className="text-[10px] text-destructive font-mono -mt-1.5">{form.formState.errors.clips[index]!.endTime!.message}</p>
                            )}

                            {/* headline */}
                            {!isRaw && (
                              <div>
                                <div className="flex items-center justify-between gap-2 mb-1.5">
                                  <FieldLabel>Headline</FieldLabel>
                                  <button
                                    type="button"
                                    onClick={() => copyHeadlinePrompt(index)}
                                    className="text-[10px] font-mono uppercase tracking-[0.08em] text-primary hover:underline flex items-center gap-1.5 shrink-0"
                                  >
                                    <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                                  </button>
                                </div>
                                <Input
                                  placeholder="Overlay headline…  (type it, or paste from Gemini)"
                                  className={`text-sm bg-background ${form.formState.errors.clips?.[index]?.headline ? "border-destructive" : ""}`}
                                  {...form.register(`clips.${index}.headline`)}
                                />
                                {form.formState.errors.clips?.[index]?.headline && (
                                  <p className="text-[10px] text-destructive font-mono mt-1">{form.formState.errors.clips[index]!.headline!.message}</p>
                                )}
                              </div>
                            )}

                            {/* toggles */}
                            <div className="flex flex-wrap gap-2">
                              <ToggleChip
                                label="Captions"
                                checked={form.watch(`clips.${index}.captionsEnabled`) ?? true}
                                onChange={(v) => form.setValue(`clips.${index}.captionsEnabled`, v)}
                              />
                              <ToggleChip
                                label="Outro card"
                                checked={form.watch(`clips.${index}.outroEnabled`) ?? true}
                                onChange={(v) => form.setValue(`clips.${index}.outroEnabled`, v)}
                              />
                            </div>

                            {/* caption highlight colour — the spoken/active word colour (edited + captions on) */}
                            {!isRaw && (form.watch(`clips.${index}.captionsEnabled`) ?? true) && (
                              <div className="flex items-center gap-2.5 rounded-lg border border-border bg-background/40 px-3 py-2">
                                <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-muted-foreground">Caption highlight</span>
                                <input
                                  type="color"
                                  value={form.watch(`clips.${index}.captionColor`) || "#FFF400"}
                                  onChange={(e) => form.setValue(`clips.${index}.captionColor`, e.target.value.toUpperCase())}
                                  className="w-8 h-8 rounded cursor-pointer bg-transparent border border-border p-0.5 shrink-0"
                                  aria-label="Caption highlight colour"
                                />
                                <span className="font-mono text-[11px] text-foreground">{(form.watch(`clips.${index}.captionColor`) || "#FFF400").toUpperCase()}</span>
                                <button
                                  type="button"
                                  onClick={() => form.setValue(`clips.${index}.captionColor`, "#FFF400")}
                                  className="ml-auto text-[10px] font-mono uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
                                >
                                  Reset
                                </button>
                              </div>
                            )}

                            {/* AI Auto-Zoom panel (edited only) */}
                            {!isRaw && (
                              <div className="rounded-lg border border-primary/30 bg-primary/[0.05] p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <label className="flex items-center gap-2.5 cursor-pointer">
                                    <span
                                      className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center ${punchOn ? "bg-primary border-primary" : "border-muted-foreground/50"}`}
                                      onClick={(e) => { e.preventDefault(); form.setValue(`clips.${index}.punchInEnabled`, !punchOn); }}
                                    >
                                      {punchOn && <Check className="w-2.5 h-2.5 text-primary-foreground" strokeWidth={3.5} />}
                                    </span>
                                    <span
                                      className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-foreground flex items-center gap-1.5"
                                      onClick={(e) => { e.preventDefault(); form.setValue(`clips.${index}.punchInEnabled`, !punchOn); }}
                                    >
                                      <ZoomIn className="w-3.5 h-3.5 text-primary" /> AI Auto-Zoom
                                      <span className="text-[8.5px] font-semibold tracking-[0.14em] text-primary border border-primary/40 rounded px-1.5 py-0.5 inline-flex items-center gap-1"><Sparkles className="w-2.5 h-2.5" />AI</span>
                                    </span>
                                  </label>
                                  {punchOn && (
                                    <button
                                      type="button"
                                      onClick={() => copyZoomPrompt(index)}
                                      className="text-[10px] font-mono uppercase tracking-[0.08em] text-primary hover:underline flex items-center gap-1.5 shrink-0"
                                    >
                                      <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                                    </button>
                                  )}
                                </div>
                                {punchOn && (
                                  <Input
                                    placeholder="Paste Gemini's pairs — e.g. 3 punch, 9 pushin, 16 kenburns   (blank = auto punch every 5s)"
                                    className="text-sm bg-background mt-2.5 font-mono"
                                    {...form.register(`clips.${index}.zoomMoments`)}
                                  />
                                )}
                              </div>
                            )}

                            {/* voiceover PRO panel (edited only) */}
                            {!isRaw && (
                              <div className="rounded-lg border border-[#9b7bff]/30 bg-gradient-to-b from-[#9b7bff]/[0.08] to-[#9b7bff]/[0.02] p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <label className="flex items-center gap-2.5 cursor-pointer">
                                    <span
                                      className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center ${
                                        voOn ? "bg-[#9b7bff] border-[#9b7bff]" : "border-muted-foreground/50"
                                      }`}
                                      onClick={(e) => { e.preventDefault(); form.setValue(`clips.${index}.voiceoverEnabled`, !voOn); }}
                                    >
                                      {voOn && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3.5} />}
                                    </span>
                                    <span
                                      className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff] flex items-center gap-1.5"
                                      onClick={(e) => { e.preventDefault(); form.setValue(`clips.${index}.voiceoverEnabled`, !voOn); }}
                                    >
                                      <Mic className="w-3.5 h-3.5 text-[#9b7bff]" /> AI Voiceover
                                      <span className="text-[8.5px] font-semibold tracking-[0.14em] text-[#b69dff] border border-[#9b7bff]/40 rounded px-1.5 py-0.5">PRO</span>
                                    </span>
                                  </label>
                                  {voOn && (
                                    <button
                                      type="button"
                                      onClick={() => (voMode === "script" ? copyNarrationPrompt(index) : copyHookPrompt(index))}
                                      className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#b69dff] hover:underline flex items-center gap-1.5 shrink-0"
                                    >
                                      <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                                    </button>
                                  )}
                                </div>
                                {voOn && (
                                  <>
                                    <div className="mt-2.5">
                                      <Segmented
                                        value={voMode}
                                        onChange={(v) => form.setValue(`clips.${index}.voiceoverMode`, v as "hook" | "script")}
                                        options={[
                                          { value: "hook", label: "Hook" },
                                          { value: "script", label: "Narration" },
                                        ]}
                                      />
                                    </div>
                                    {voMode === "script" ? (
                                      <Textarea
                                        placeholder={"Timed narration — one line per beat (or paste from Gemini):\n2 | Nobody saw this coming.\n9 | He'd been planning it for months."}
                                        className="text-sm bg-background mt-2.5 font-mono min-h-[84px]"
                                        {...form.register(`clips.${index}.narrationScript`)}
                                      />
                                    ) : (
                                      <Input
                                        placeholder="Spoken intro hook — type it, or paste from your Gemini app…"
                                        className="text-sm bg-background mt-2.5"
                                        {...form.register(`clips.${index}.voiceoverHook`)}
                                      />
                                    )}
                                    <VoicePicker voice={voVoice} speed={voSpeed} onVoice={setVoVoice} onSpeed={setVoSpeed} />
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* add clip */}
                  <button
                    type="button"
                    onClick={() => clipCount < MAX_CLIPS && append({ ...defaultClip })}
                    disabled={clipCount >= MAX_CLIPS}
                    className={`w-full flex items-center justify-center gap-2 rounded-xl border border-dashed py-3 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                      clipCount >= MAX_CLIPS
                        ? "text-muted-foreground/30 border-border cursor-not-allowed"
                        : "text-muted-foreground border-border hover:text-primary hover:border-primary/40"
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {clipCount >= MAX_CLIPS ? `Max ${MAX_CLIPS} clips reached` : `Add clip (${clipCount}/${MAX_CLIPS})`}
                  </button>

                  {/* CTA */}
                  <div className="flex items-center justify-between gap-4 flex-wrap pt-1">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {clipCount} job{clipCount > 1 ? "s" : ""} ready · ~25–30 min on phone
                    </span>
                    <Button type="submit" disabled={isSubmitting} className="font-mono uppercase tracking-[0.13em] text-xs h-12 px-7">
                      {isSubmitting ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />DISPATCHING…</>
                      ) : (
                        <><SendHorizonal className="mr-2 h-4 w-4" />ENQUEUE {clipCount} JOB{clipCount > 1 ? "S" : ""}</>
                      )}
                    </Button>
                  </div>
                </form>
              )}

              {sourceTab === "local" && (
                <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-5 space-y-5">
                  <div>
                    <FieldLabel>Video file <span className="text-muted-foreground/50 normal-case">(max 20 GB)</span></FieldLabel>
                    <div
                      className={`relative flex items-center gap-3 rounded-lg border bg-background px-4 py-3 cursor-pointer hover:bg-background/70 transition-colors ${localErrors.file ? "border-destructive" : "border-border"}`}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <FileVideo className={`w-5 h-5 shrink-0 ${selectedFile ? "text-primary" : "text-muted-foreground/50"}`} />
                      <div className="flex-1 min-w-0">
                        {selectedFile ? (
                          <>
                            <p className="text-sm font-medium truncate">{selectedFile.name}</p>
                            <p className="text-[10px] font-mono text-muted-foreground">
                              {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                            </p>
                          </>
                        ) : (
                          <p className="text-sm text-muted-foreground">Click to browse or drag a video file here</p>
                        )}
                      </div>
                      {selectedFile && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                          className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0] ?? null;
                          if (file && file.size > MAX_FILE_BYTES) {
                            toast({ title: "File too large", variant: "destructive" });
                            return;
                          }
                          setSelectedFile(file);
                          setLocalErrors((prev) => ({ ...prev, file: undefined }));
                        }}
                      />
                    </div>
                    {localErrors.file && <p className="text-xs text-destructive font-mono mt-1.5">{localErrors.file}</p>}
                  </div>

                  <div>
                    <FieldLabel>Mode</FieldLabel>
                    <Segmented
                      value={localForm.mode}
                      onChange={(m) => {
                        setLocalForm((p) => ({ ...p, mode: m as "edited" | "raw" }));
                        if (m === "raw") setLocalErrors((p) => ({ ...p, headline: undefined }));
                      }}
                      options={[
                        { value: "edited", label: "Edited" },
                        { value: "raw", label: "Raw" },
                      ]}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <FieldLabel>In</FieldLabel>
                      <Input
                        placeholder="00:00:00"
                        className={`font-mono text-sm bg-background ${localErrors.startTime ? "border-destructive" : ""}`}
                        value={localForm.startTime}
                        onChange={(e) => setLocalForm((p) => ({ ...p, startTime: e.target.value }))}
                      />
                      {localErrors.startTime && <p className="text-xs text-destructive font-mono mt-1">{localErrors.startTime}</p>}
                    </div>
                    <div>
                      <FieldLabel>Out</FieldLabel>
                      <Input
                        placeholder="00:01:00"
                        className={`font-mono text-sm bg-background ${localErrors.endTime ? "border-destructive" : ""}`}
                        value={localForm.endTime}
                        onChange={(e) => setLocalForm((p) => ({ ...p, endTime: e.target.value }))}
                      />
                      {localErrors.endTime && <p className="text-xs text-destructive font-mono mt-1">{localErrors.endTime}</p>}
                    </div>
                  </div>

                  {localForm.mode === "edited" && (
                    <div>
                      <FieldLabel>Overlay headline</FieldLabel>
                      <Input
                        placeholder="Overlay headline…"
                        className={`text-sm bg-background ${localErrors.headline ? "border-destructive" : ""}`}
                        value={localForm.headline}
                        onChange={(e) => setLocalForm((p) => ({ ...p, headline: e.target.value }))}
                      />
                      {localErrors.headline && <p className="text-xs text-destructive font-mono mt-1">{localErrors.headline}</p>}
                    </div>
                  )}

                  <div>
                    <FieldLabel>Source creator <span className="text-muted-foreground/50 normal-case">(optional)</span></FieldLabel>
                    <Input
                      placeholder="e.g. KSI, MrBeast, IShowSpeed"
                      className="font-mono text-sm bg-background"
                      value={localForm.sourceChannel}
                      onChange={(e) => setLocalForm((p) => ({ ...p, sourceChannel: e.target.value }))}
                    />
                  </div>

                  <ToggleChip
                    label="Enable captions"
                    checked={localForm.captionsEnabled}
                    onChange={(v) => setLocalForm((p) => ({ ...p, captionsEnabled: v }))}
                  />

                  {uploadProgress !== null && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                        <span>Uploading…</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-300"
                          style={{ width: `${uploadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end pt-1">
                    <Button
                      type="button"
                      disabled={isUploading}
                      onClick={handleLocalUpload}
                      className="font-mono uppercase tracking-[0.13em] text-xs h-12 px-7"
                    >
                      {isUploading ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />UPLOADING…</>
                      ) : (
                        <><Upload className="mr-2 h-4 w-4" />UPLOAD &amp; PROCESS</>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {sourceTab === "story" && (
                <div className="space-y-5">
                  <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-5 space-y-4">
                    <div>
                      <FieldLabel>Source URL</FieldLabel>
                      <Input
                        placeholder="https://youtube.com/watch?v=..."
                        className="font-mono text-sm bg-background"
                        value={storyUrl}
                        onChange={(e) => setStoryUrl(e.target.value)}
                      />
                    </div>
                    <div>
                      <FieldLabel>Source creator <span className="text-muted-foreground/40 normal-case">(optional)</span></FieldLabel>
                      <Input
                        placeholder="e.g. KSI, MrBeast, IShowSpeed"
                        className="font-mono text-sm bg-background"
                        value={storyCreator}
                        onChange={(e) => setStoryCreator(e.target.value)}
                      />
                    </div>

                    {/* Story bridge: copy prompt → run in Gemini → paste moments + narration back */}
                    <div className="rounded-lg border border-primary/30 bg-primary/[0.05] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-foreground flex items-center gap-1.5">
                          <Film className="w-3.5 h-3.5 text-primary" /> AI Story Builder
                          <span className="text-[8.5px] font-semibold tracking-[0.14em] text-primary border border-primary/40 rounded px-1.5 py-0.5 inline-flex items-center gap-1"><Sparkles className="w-2.5 h-2.5" />AI</span>
                        </span>
                        <button
                          type="button"
                          onClick={copyStoryPrompt}
                          className="text-[10px] font-mono uppercase tracking-[0.08em] text-primary hover:underline flex items-center gap-1.5 shrink-0"
                        >
                          <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                        </button>
                      </div>
                      <Textarea
                        value={storyPaste}
                        onChange={(e) => setStoryPaste(e.target.value)}
                        placeholder={"Paste Gemini's reply here (SEGMENTS + NARRATION blocks)…"}
                        className="text-sm bg-background mt-2.5 font-mono min-h-[96px]"
                      />
                      <button
                        type="button"
                        onClick={applyStoryPaste}
                        disabled={!storyPaste.trim()}
                        className="mt-2 w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-primary/40 py-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Plus className="w-3.5 h-3.5" /> Fill moments + narration from paste
                      </button>
                    </div>
                  </div>

                  {/* Segments (moments) */}
                  <div className="space-y-3">
                    <p className="font-mono text-[11px] uppercase tracking-[0.13em] text-muted-foreground">
                      Moments <span className="text-muted-foreground/50">({storySegments.length}/10 · min 2)</span>
                    </p>
                    {storySegments.map((seg, index) => {
                      const bad = !/^\d{2}:\d{2}:\d{2}$/.test(seg.startTime) || !/^\d{2}:\d{2}:\d{2}$/.test(seg.endTime) || toSecs(seg.endTime) <= toSecs(seg.startTime);
                      return (
                        <div key={index} className="rounded-xl border border-border bg-background/40 p-4 space-y-3">
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-[11px] text-primary bg-primary/[0.08] border border-primary/20 w-7 h-7 rounded-md grid place-items-center font-semibold tabular-nums">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
                              {bad ? <span className="text-destructive">check times</span> : `length ${fmtDuration(seg.startTime, seg.endTime)}`}
                            </span>
                            {storySegments.length > 2 && (
                              <button
                                type="button"
                                onClick={() => setStorySegments((p) => p.filter((_, i) => i !== index))}
                                className="ml-auto w-7 h-7 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors"
                                aria-label="Remove moment"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <FieldLabel>In</FieldLabel>
                              <Input
                                placeholder="00:00:00"
                                className={`font-mono text-sm bg-background ${bad ? "border-destructive/50" : ""}`}
                                value={seg.startTime}
                                onChange={(e) => updateStorySeg(index, { startTime: e.target.value })}
                              />
                            </div>
                            <div>
                              <FieldLabel>Out</FieldLabel>
                              <Input
                                placeholder="00:00:15"
                                className={`font-mono text-sm bg-background ${bad ? "border-destructive/50" : ""}`}
                                value={seg.endTime}
                                onChange={(e) => updateStorySeg(index, { endTime: e.target.value })}
                              />
                            </div>
                          </div>
                          <div>
                            <FieldLabel>Headline</FieldLabel>
                            <Input
                              placeholder="On-screen headline for this moment…"
                              className="text-sm bg-background"
                              value={seg.headline}
                              onChange={(e) => updateStorySeg(index, { headline: e.target.value })}
                            />
                          </div>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => storySegments.length < 10 && setStorySegments((p) => [...p, { startTime: "00:00:00", endTime: "00:00:15", headline: "" }])}
                      disabled={storySegments.length >= 10}
                      className={`w-full flex items-center justify-center gap-2 rounded-xl border border-dashed py-3 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                        storySegments.length >= 10
                          ? "text-muted-foreground/30 border-border cursor-not-allowed"
                          : "text-muted-foreground border-border hover:text-primary hover:border-primary/40"
                      }`}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      {storySegments.length >= 10 ? "Max 10 moments" : `Add moment (${storySegments.length}/10)`}
                    </button>
                  </div>

                  {/* Bridging narration */}
                  <div className="rounded-xl border border-[#9b7bff]/30 bg-gradient-to-b from-[#9b7bff]/[0.08] to-[#9b7bff]/[0.02] p-4">
                    <div className="flex items-center gap-1.5 mb-2">
                      <Mic className="w-3.5 h-3.5 text-[#9b7bff]" />
                      <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff]">Bridging narration</span>
                      <span className="text-[8.5px] font-semibold tracking-[0.14em] text-[#b69dff] border border-[#9b7bff]/40 rounded px-1.5 py-0.5">PRO</span>
                    </div>
                    <Textarea
                      value={storyNarration}
                      onChange={(e) => setStoryNarration(e.target.value)}
                      placeholder={"Timed on the STITCHED timeline — one line per beat:\n1 | It started as an ordinary bet.\n16 | But that was only the beginning."}
                      className="text-sm bg-background font-mono min-h-[84px]"
                    />
                    <p className="mt-2 text-[10.5px] text-muted-foreground/60 leading-relaxed">
                      Seconds count from the start of the FINAL stitched video (0 = first moment). Spoken by Piper, ducking the footage while it plays.
                    </p>
                    <VoicePicker voice={voVoice} speed={voSpeed} onVoice={setVoVoice} onSpeed={setVoSpeed} autoVoice="en_GB-alan-medium" />
                  </div>

                  {/* Global toggles */}
                  <div className="flex flex-wrap gap-2">
                    <ToggleChip label="Captions" checked={storyCaptions} onChange={setStoryCaptions} />
                    <ToggleChip label="Outro card" checked={storyOutro} onChange={setStoryOutro} />
                  </div>

                  <div className="flex items-center justify-between gap-4 flex-wrap pt-1">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {storySegments.length} moments · one stitched Short · slow on phone
                    </span>
                    <Button
                      type="button"
                      disabled={storySubmitting}
                      onClick={submitStory}
                      className="font-mono uppercase tracking-[0.13em] text-xs h-12 px-7"
                    >
                      {storySubmitting ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />DISPATCHING…</>
                      ) : (
                        <><Film className="mr-2 h-4 w-4" />ENQUEUE STORY</>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {sourceTab === "top5" && (
                <div className="space-y-5">
                  <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-5 space-y-4">
                    <div>
                      <FieldLabel>Video title / topic</FieldLabel>
                      <Input
                        placeholder="e.g. Top 5 Craziest F1 Crashes Ever"
                        className="text-sm bg-background"
                        value={t5Topic}
                        onChange={(e) => setT5Topic(e.target.value)}
                      />
                    </div>

                    <div className="flex flex-wrap items-end gap-3">
                      <div>
                        <FieldLabel>Sources</FieldLabel>
                        <Segmented
                          value={t5MultiSource ? "multi" : "single"}
                          onChange={(v) => setT5MultiSource(v === "multi")}
                          options={[
                            { value: "multi", label: "Different videos" },
                            { value: "single", label: "One video" },
                          ]}
                        />
                      </div>
                      <div>
                        <FieldLabel>Countdown</FieldLabel>
                        <Segmented
                          value={t5Order}
                          onChange={(v) => setT5Order(v === "1to5" ? "1to5" : "5to1")}
                          options={[
                            { value: "5to1", label: "5 → 1" },
                            { value: "1to5", label: "1 → 5" },
                          ]}
                        />
                      </div>
                    </div>

                    {!t5MultiSource && (
                      <div>
                        <FieldLabel>Source URL <span className="text-muted-foreground/40 normal-case">(all moments from this one video)</span></FieldLabel>
                        <Input
                          placeholder="https://youtube.com/watch?v=..."
                          className="font-mono text-sm bg-background"
                          value={t5Url}
                          onChange={(e) => setT5Url(e.target.value)}
                        />
                      </div>
                    )}

                    <div>
                      <FieldLabel>Channel credit <span className="text-muted-foreground/40 normal-case">(fallback "Credit:" line)</span></FieldLabel>
                      <Input
                        placeholder="e.g. FORMULA 1"
                        className="font-mono text-sm bg-background"
                        value={t5Creator}
                        onChange={(e) => setT5Creator(e.target.value)}
                      />
                    </div>

                    {/* Research bridge: copy prompt → Gemini Deep Research → paste back */}
                    <div className="rounded-lg border border-primary/30 bg-primary/[0.05] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-foreground flex items-center gap-1.5">
                          <Trophy className="w-3.5 h-3.5 text-primary" /> AI Top 5 Researcher
                          <span className="text-[8.5px] font-semibold tracking-[0.14em] text-primary border border-primary/40 rounded px-1.5 py-0.5 inline-flex items-center gap-1"><Sparkles className="w-2.5 h-2.5" />AI</span>
                        </span>
                        <button
                          type="button"
                          onClick={copyTop5Prompt}
                          className="text-[10px] font-mono uppercase tracking-[0.08em] text-primary hover:underline flex items-center gap-1.5 shrink-0"
                        >
                          <ClipboardCopy className="w-3 h-3" /> Copy research prompt
                        </button>
                      </div>
                      <p className="mt-2 text-[10.5px] text-muted-foreground/70 leading-relaxed">
                        Run it in <span className="text-foreground/80">Gemini 2.5 Pro · Deep Research</span> — the research is what makes or breaks these videos.
                      </p>
                      <Textarea
                        value={t5Paste}
                        onChange={(e) => setT5Paste(e.target.value)}
                        placeholder={"Paste Gemini's reply here (TITLE + MOMENTS + ALTERNATES)…"}
                        className="text-sm bg-background mt-2.5 font-mono min-h-[96px]"
                      />
                      <button
                        type="button"
                        onClick={applyTop5Paste}
                        disabled={!t5Paste.trim()}
                        className="mt-2 w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-primary/40 py-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Plus className="w-3.5 h-3.5" /> Fill moments from paste
                      </button>
                    </div>
                  </div>

                  {/* Ranked moments */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-mono text-[11px] uppercase tracking-[0.13em] text-muted-foreground">
                        Ranked moments <span className="text-muted-foreground/50">({t5Segments.length} · min 2)</span>
                      </p>
                      <div className="flex items-center gap-3 shrink-0">
                        {t5Segments.some((s) => s.verify && !s.verify.ok) && (
                          <button
                            type="button"
                            onClick={reaskTop5Flagged}
                            className="text-[10px] font-mono uppercase tracking-[0.08em] text-amber-400 hover:underline flex items-center gap-1.5"
                          >
                            <ClipboardCopy className="w-3 h-3" /> Re-ask Gemini
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={verifyTop5}
                          disabled={t5Verifying}
                          className="text-[10px] font-mono uppercase tracking-[0.08em] text-primary hover:underline flex items-center gap-1.5 disabled:opacity-40"
                        >
                          {t5Verifying ? <><Loader2 className="w-3 h-3 animate-spin" /> Verifying…</> : <><Eye className="w-3 h-3" /> Verify timestamps</>}
                        </button>
                      </div>
                    </div>

                    {t5Segments.map((seg, index) => {
                      const bad = !/^\d{2}:\d{2}:\d{2}$/.test(seg.startTime) || !/^\d{2}:\d{2}:\d{2}$/.test(seg.endTime) || toSecs(seg.endTime) <= toSecs(seg.startTime);
                      return (
                        <div key={index} className="rounded-xl border border-border bg-background/40 p-4 space-y-3">
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-[13px] text-primary bg-primary/[0.08] border border-primary/20 min-w-[2.6rem] h-7 px-2 rounded-md grid place-items-center font-bold tabular-nums">
                              #{seg.rank}
                            </span>
                            <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                              {bad
                                ? <span className="text-destructive">check times</span>
                                : seg.verify
                                  ? (seg.verify.ok
                                      ? <span className="text-emerald-400 inline-flex items-center gap-1"><Check className="w-3 h-3" /> valid</span>
                                      : <span className="text-destructive inline-flex items-center gap-1" title={seg.verify.message ?? ""}><X className="w-3 h-3" /> not in video</span>)
                                  : <span className="text-muted-foreground">length {fmtDuration(seg.startTime, seg.endTime)}</span>}
                            </span>
                            {t5Segments.length > 2 && (
                              <button
                                type="button"
                                onClick={() => setT5Segments((p) => p.filter((_, i) => i !== index))}
                                className="ml-auto w-7 h-7 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors"
                                aria-label="Remove moment"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>

                          {t5MultiSource && (
                            <div>
                              <FieldLabel>Source URL</FieldLabel>
                              <Input
                                placeholder="https://youtube.com/watch?v=..."
                                className="font-mono text-sm bg-background"
                                value={seg.youtubeUrl}
                                onChange={(e) => updateT5Seg(index, { youtubeUrl: e.target.value })}
                              />
                            </div>
                          )}

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <FieldLabel>In</FieldLabel>
                              <Input
                                placeholder="00:00:00"
                                className={`font-mono text-sm bg-background ${bad ? "border-destructive/50" : ""}`}
                                value={seg.startTime}
                                onChange={(e) => updateT5Seg(index, { startTime: e.target.value })}
                              />
                            </div>
                            <div>
                              <FieldLabel>Out</FieldLabel>
                              <Input
                                placeholder="00:00:12"
                                className={`font-mono text-sm bg-background ${bad ? "border-destructive/50" : ""}`}
                                value={seg.endTime}
                                onChange={(e) => updateT5Seg(index, { endTime: e.target.value })}
                              />
                            </div>
                          </div>

                          {seg.verify && !seg.verify.ok && (
                            <div className="rounded-lg border border-destructive/30 bg-destructive/[0.06] p-3 space-y-2">
                              <p className="text-[11px] text-destructive leading-snug">{seg.verify.message}</p>
                              {seg.verify.suggested ? (
                                <div className="flex items-start gap-2">
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[11px] text-foreground">
                                      Transcript match: <span className="font-mono">{seg.verify.suggested.startTime}–{seg.verify.suggested.endTime}</span>
                                      <span className="text-muted-foreground"> · {Math.round(seg.verify.suggested.confidence * 100)}% conf</span>
                                    </p>
                                    <p className="text-[10px] text-muted-foreground italic truncate">“{seg.verify.suggested.evidence}”</p>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => updateT5Seg(index, { startTime: seg.verify!.suggested!.startTime, endTime: seg.verify!.suggested!.endTime })}
                                    className="shrink-0 text-[10px] font-mono uppercase tracking-[0.08em] px-2.5 h-7 rounded-md bg-primary/15 border border-primary/30 text-primary hover:bg-primary/25 transition-colors"
                                  >
                                    Apply
                                  </button>
                                </div>
                              ) : (
                                <p className="text-[10px] text-muted-foreground">No transcript match — use “Re-ask Gemini for flagged moments” below, or fix the time manually.</p>
                              )}
                            </div>
                          )}

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <FieldLabel>Headline</FieldLabel>
                              <Input
                                placeholder="On-screen title…"
                                className="text-sm bg-background"
                                value={seg.headline}
                                onChange={(e) => updateT5Seg(index, { headline: e.target.value })}
                              />
                            </div>
                            <div>
                              <FieldLabel>Channel</FieldLabel>
                              <Input
                                placeholder="Credit channel…"
                                className="font-mono text-sm bg-background"
                                value={seg.sourceChannel}
                                onChange={(e) => updateT5Seg(index, { sourceChannel: e.target.value })}
                              />
                            </div>
                          </div>

                          <div>
                            <FieldLabel>Voiceover line</FieldLabel>
                            <Input
                              placeholder='e.g. "Number five: this rookie lost control at 200mph."'
                              className="text-sm bg-background"
                              value={seg.narrationLine}
                              onChange={(e) => updateT5Seg(index, { narrationLine: e.target.value })}
                            />
                          </div>
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => t5Segments.length < 10 && setT5Segments((p) => [...p, { rank: p.length ? Math.max(...p.map((s) => s.rank)) + 1 : 1, youtubeUrl: "", startTime: "00:00:00", endTime: "00:00:12", sourceChannel: "", headline: "", narrationLine: "", verify: null }])}
                      disabled={t5Segments.length >= 10}
                      className={`w-full flex items-center justify-center gap-2 rounded-xl border border-dashed py-3 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                        t5Segments.length >= 10
                          ? "text-muted-foreground/30 border-border cursor-not-allowed"
                          : "text-muted-foreground border-border hover:text-primary hover:border-primary/40"
                      }`}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      {t5Segments.length >= 10 ? "Max 10 moments" : `Add moment (${t5Segments.length})`}
                    </button>
                  </div>

                  {/* Countdown voiceover voice */}
                  <div className="rounded-xl border border-[#9b7bff]/30 bg-gradient-to-b from-[#9b7bff]/[0.08] to-[#9b7bff]/[0.02] p-4">
                    <div className="flex items-center gap-1.5">
                      <Mic className="w-3.5 h-3.5 text-[#9b7bff]" />
                      <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff]">Countdown voiceover</span>
                      <span className="text-[8.5px] font-semibold tracking-[0.14em] text-[#b69dff] border border-[#9b7bff]/40 rounded px-1.5 py-0.5">PRO</span>
                    </div>
                    <VoicePicker voice={voVoice} speed={voSpeed} onVoice={setVoVoice} onSpeed={setVoSpeed} />
                  </div>

                  {/* Toggles + submit */}
                  <div className="flex flex-wrap gap-2">
                    <ToggleChip label="Captions" checked={t5Captions} onChange={setT5Captions} />
                    <ToggleChip label="Outro card" checked={t5Outro} onChange={setT5Outro} />
                  </div>

                  <div className="flex items-center justify-between gap-4 flex-wrap pt-1">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      Title card · rank badges · countdown VO · slow on phone
                    </span>
                    <Button
                      type="button"
                      disabled={t5Submitting}
                      onClick={submitTop5}
                      className="font-mono uppercase tracking-[0.13em] text-xs h-12 px-7"
                    >
                      {t5Submitting ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />DISPATCHING…</>
                      ) : (
                        <><Trophy className="mr-2 h-4 w-4" />ENQUEUE TOP 5</>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {sourceTab === "matchstory2" && (
                <div className="space-y-5">
                  <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-4">
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-primary" />
                      <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-primary">Clip-Scout — auto-find clips across your platforms</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5">Enter a topic. The bot searches, ranks and downloads the best clips; you keep the ones you want, then it hands them to Match Story to narrate + render.</p>
                  </div>

                  <div>
                    <FieldLabel>Topic</FieldLabel>
                    <Input placeholder="e.g. Messi free kick goal" value={ms2Topic} onChange={(e) => setMs2Topic(e.target.value)} className="text-sm bg-background" />
                  </div>
                  <div>
                    <FieldLabel>Subreddit hints <span className="text-muted-foreground/40 normal-case">(optional, comma-separated)</span></FieldLabel>
                    <Input placeholder="soccer, football" value={ms2Subreddits} onChange={(e) => setMs2Subreddits(e.target.value)} className="font-mono text-sm bg-background" />
                  </div>
                  <div>
                    <FieldLabel>Platforms</FieldLabel>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {["reddit", "x", "instagram", "facebook"].map((p) => {
                        const conf = ms2Adapters.find((a) => a.platform === p)?.configured;
                        const on = ms2Platforms.includes(p);
                        return (
                          <button key={p} type="button" onClick={() => toggleMs2Platform(p)}
                            className={`text-[11px] font-mono uppercase tracking-[0.08em] px-3 h-8 rounded-md border transition-colors ${on ? "bg-primary/15 border-primary/40 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                            {p}{conf === false ? " · add cookie" : ""}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1.5">Reddit works now. X / Instagram / Facebook need a cookies.txt in <span className="font-mono">~/myapp/scout_cookies/</span> (and their search is more limited).</p>
                  </div>
                  <Button type="button" onClick={startScout} disabled={ms2Status === "searching" || ms2Status === "downloading"} className="font-mono uppercase tracking-[0.13em] text-xs h-11 px-6">
                    {(ms2Status === "searching" || ms2Status === "downloading") ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Scouting… {Math.round(ms2Progress)}%</> : <><Sparkles className="mr-2 h-4 w-4" />Scout clips</>}
                  </Button>

                  {ms2Message && <p className="text-xs text-muted-foreground">{ms2Message}</p>}

                  {ms2Candidates.length > 0 && (
                    <div className="space-y-3">
                      <FieldLabel>Candidates <span className="text-muted-foreground/50">({ms2Candidates.filter((c) => c.status === "keep").length} kept / {ms2Candidates.length})</span></FieldLabel>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {ms2Candidates.map((c) => (
                          <div key={c.id} className={`rounded-xl border p-3 flex gap-3 transition-colors ${c.status === "keep" ? "border-emerald-500/40 bg-emerald-500/[0.06]" : c.status === "drop" ? "border-border opacity-40" : "border-border"}`}>
                            {c.thumbUrl ? <img src={c.thumbUrl.startsWith("http") ? c.thumbUrl : `${API_BASE}${c.thumbUrl}`} alt="" className="w-20 h-20 object-cover rounded-md border border-border shrink-0" /> : <div className="w-20 h-20 rounded-md bg-muted grid place-items-center shrink-0"><Film className="w-5 h-5 text-muted-foreground" /></div>}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-primary">{c.platform}</span>
                                <span className="text-[10px] font-mono text-emerald-400">{c.score}%</span>
                                {c.durationSec ? <span className="text-[10px] text-muted-foreground">{Math.round(c.durationSec)}s</span> : null}
                              </div>
                              <p className="text-[12px] text-foreground leading-snug line-clamp-2 mt-0.5">{c.title}</p>
                              <p className="text-[10px] text-muted-foreground truncate">{c.author}</p>
                              <div className="flex gap-2 mt-1.5">
                                <button type="button" onClick={() => toggleCandidate(c.id, c.status !== "keep")} className={`text-[10px] font-mono uppercase tracking-[0.08em] px-2.5 h-7 rounded-md border transition-colors ${c.status === "keep" ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-400" : "border-border text-muted-foreground hover:border-emerald-500/30"}`}>{c.status === "keep" ? "✓ keep" : "keep"}</button>
                                <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="text-[10px] font-mono uppercase tracking-[0.08em] px-2.5 h-7 rounded-md border border-border text-muted-foreground hover:text-primary inline-flex items-center">source</a>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      {ms2Status === "ready" && (
                        <Button type="button" onClick={buildScoutBeats} disabled={ms2Building || ms2Candidates.filter((c) => c.status === "keep").length < 2} className="w-full font-mono uppercase tracking-[0.13em] text-xs h-11">
                          {ms2Building ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Building…</> : <>Build montage from {ms2Candidates.filter((c) => c.status === "keep").length} clips</>}
                        </Button>
                      )}
                    </div>
                  )}

                  {ms2Beats.length > 0 && (
                    <div className="space-y-4 pt-3 border-t border-border">
                      <FieldLabel>Your montage <span className="text-muted-foreground/50">({ms2Beats.length} clips · in order)</span></FieldLabel>
                      {ms2Beats.map((b, i) => (
                        <div key={i} className="rounded-xl border border-border bg-background/40 p-3 space-y-2.5">
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-[13px] text-primary bg-primary/[0.08] border border-primary/20 min-w-[2.6rem] h-7 px-2 rounded-md grid place-items-center font-bold tabular-nums">#{i + 1}</span>
                            {b.thumbUrl ? <img src={b.thumbUrl} alt="" className="w-12 h-12 object-cover rounded-md border border-border" /> : <div className="w-12 h-12 rounded-md bg-muted grid place-items-center"><Film className="w-4 h-4 text-muted-foreground" /></div>}
                            <span className="text-[11px] text-muted-foreground truncate flex-1">{fmtDuration(b.startTime, b.endTime)} · {b.sourceChannel || "—"}</span>
                            {ms2Beats.length > 2 && <button type="button" onClick={() => setMs2Beats((p) => p.filter((_, idx) => idx !== i))} className="w-7 h-7 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>}
                          </div>
                          <div>
                            <FieldLabel>Headline</FieldLabel>
                            <Input value={b.headline} onChange={(e) => updateMs2Beat(i, { headline: e.target.value })} className="text-sm bg-background" placeholder="On-screen title…" />
                          </div>
                          <div>
                            <FieldLabel>Narration <span className="text-muted-foreground/40 normal-case">(spoken over this clip)</span></FieldLabel>
                            <Textarea value={b.narrationLine} onChange={(e) => updateMs2Beat(i, { narrationLine: e.target.value })} className="text-sm bg-background min-h-[52px]" placeholder="One punchy hook-first line…" />
                          </div>
                        </div>
                      ))}

                      <div className="rounded-xl border border-primary/20 bg-primary/[0.03] p-4 space-y-2.5">
                        <div className="flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-primary" /><span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-primary">Narrate with Gemini (hook-first)</span></div>
                        <p className="text-[11px] text-muted-foreground">Copy a prompt listing your clips → run it in Gemini → paste the numbered lines back to fill each beat's narration.</p>
                        <button type="button" onClick={copyMs2NarrationPrompt} className="text-[11px] font-mono uppercase tracking-[0.08em] px-3 h-8 rounded-md bg-primary/15 border border-primary/30 text-primary hover:bg-primary/25 transition-colors inline-flex items-center gap-1.5"><SendHorizonal className="w-3 h-3" /> Copy narration prompt</button>
                        <Textarea value={ms2NarrPaste} onChange={(e) => setMs2NarrPaste(e.target.value)} placeholder={"Paste Gemini's reply:\n1 | Ninety-third minute — one chance left.\n2 | The wall goes up, and Messi stands over it."} className="text-sm bg-background font-mono min-h-[90px]" />
                        <button type="button" onClick={applyMs2NarrationPaste} disabled={!ms2NarrPaste.trim()} className="text-[11px] font-mono uppercase tracking-[0.08em] px-3 h-8 rounded-md border border-border text-foreground hover:border-primary/40 disabled:opacity-40 transition-colors">Apply narration</button>
                      </div>

                      <div className="rounded-xl border border-[#9b7bff]/30 bg-gradient-to-b from-[#9b7bff]/[0.08] to-[#9b7bff]/[0.02] p-4">
                        <div className="flex items-center gap-1.5"><Mic className="w-3.5 h-3.5 text-[#9b7bff]" /><span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff]">Commentary voiceover</span></div>
                        <VoicePicker voice={voVoice} speed={voSpeed} onVoice={setVoVoice} onSpeed={setVoSpeed} autoVoice="en_GB-alan-medium" />
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <ToggleChip label="Captions" checked={msCaptions} onChange={setMsCaptions} />
                        <ToggleChip label="Outro card" checked={msOutro} onChange={setMsOutro} />
                        <ToggleChip label="Title card" checked={msTitleCard} onChange={setMsTitleCard} />
                        <ToggleChip label="Crossfades" checked={msTransitions} onChange={setMsTransitions} />
                      </div>
                      <Button type="button" disabled={ms2Submitting} onClick={submitMs2} className="w-full font-mono uppercase tracking-[0.13em] text-xs h-12">
                        {ms2Submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />DISPATCHING…</> : <><Zap className="mr-2 h-4 w-4" />ENQUEUE MATCH STORY 2.0</>}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {sourceTab === "matchstory" && (
                <div className="space-y-5">
                  <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-5 space-y-4">
                    <div>
                      <FieldLabel>Match / topic</FieldLabel>
                      <Input
                        placeholder="e.g. Argentina vs Cape Verde — the disallowed goal"
                        className="text-sm bg-background"
                        value={msTopic}
                        onChange={(e) => setMsTopic(e.target.value)}
                      />
                    </div>

                    <div>
                      <FieldLabel>Channel credit <span className="text-muted-foreground/40 normal-case">(fallback "Credit:" line)</span></FieldLabel>
                      <Input
                        placeholder="e.g. FIFA"
                        className="font-mono text-sm bg-background"
                        value={msCreator}
                        onChange={(e) => setMsCreator(e.target.value)}
                      />
                    </div>

                    {/* Research bridge: copy prompt → Gemini Deep Research → paste back */}
                    <div className="rounded-lg border border-primary/30 bg-primary/[0.05] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-foreground flex items-center gap-1.5">
                          <Zap className="w-3.5 h-3.5 text-primary" /> AI Match Researcher
                          <span className="text-[8.5px] font-semibold tracking-[0.14em] text-primary border border-primary/40 rounded px-1.5 py-0.5 inline-flex items-center gap-1"><Sparkles className="w-2.5 h-2.5" />AI</span>
                        </span>
                        <button
                          type="button"
                          onClick={copyMatchStoryPrompt}
                          className="text-[10px] font-mono uppercase tracking-[0.08em] text-primary hover:underline flex items-center gap-1.5 shrink-0"
                        >
                          <ClipboardCopy className="w-3 h-3" /> Copy research prompt
                        </button>
                      </div>
                      <p className="mt-2 text-[10.5px] text-muted-foreground/70 leading-relaxed">
                        Run it in <span className="text-foreground/80">Gemini 2.5 Pro · Deep Research</span> — it finds the real source clips + writes the play-by-play. The research is what makes or breaks these videos.
                      </p>
                      <Textarea
                        value={msPaste}
                        onChange={(e) => setMsPaste(e.target.value)}
                        placeholder={"Paste Gemini's reply here (TITLE + SEGMENTS + NARRATION)…"}
                        className="text-sm bg-background mt-2.5 font-mono min-h-[96px]"
                      />
                      <button
                        type="button"
                        onClick={applyMatchStoryPaste}
                        disabled={!msPaste.trim()}
                        className="mt-2 w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-primary/40 py-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Plus className="w-3.5 h-3.5" /> Fill beats + narration from paste
                      </button>
                    </div>
                  </div>

                  {/* Beats (each its own source clip) */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-mono text-[11px] uppercase tracking-[0.13em] text-muted-foreground">
                        Beats <span className="text-muted-foreground/50">({msSegments.length} · min 2 · max 8)</span>
                      </p>
                      <div className="flex items-center gap-3 shrink-0">
                        {msSegments.some((s) => s.verify && !s.verify.ok) && (
                          <button
                            type="button"
                            onClick={reaskMatchFlagged}
                            className="text-[10px] font-mono uppercase tracking-[0.08em] text-amber-400 hover:underline flex items-center gap-1.5"
                          >
                            <ClipboardCopy className="w-3 h-3" /> Re-ask Gemini
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={verifyMatchStory}
                          disabled={msVerifying}
                          className="text-[10px] font-mono uppercase tracking-[0.08em] text-primary hover:underline flex items-center gap-1.5 disabled:opacity-40"
                        >
                          {msVerifying ? <><Loader2 className="w-3 h-3 animate-spin" /> Verifying…</> : <><Eye className="w-3 h-3" /> Verify timestamps</>}
                        </button>
                      </div>
                    </div>

                    {msSegments.map((seg, index) => {
                      const bad = !/^\d{2}:\d{2}:\d{2}$/.test(seg.startTime) || !/^\d{2}:\d{2}:\d{2}$/.test(seg.endTime) || toSecs(seg.endTime) <= toSecs(seg.startTime);
                      return (
                        <div key={index} className="rounded-xl border border-border bg-background/40 p-4 space-y-3">
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-[13px] text-primary bg-primary/[0.08] border border-primary/20 min-w-[2.6rem] h-7 px-2 rounded-md grid place-items-center font-bold tabular-nums">
                              #{index + 1}
                            </span>
                            <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                              {bad
                                ? <span className="text-destructive">check times</span>
                                : seg.verify
                                  ? (seg.verify.reason === "unverified"
                                      ? <span className="text-amber-400 inline-flex items-center gap-1" title={seg.verify.message ?? ""}><AlertTriangle className="w-3 h-3" /> couldn't check</span>
                                      : seg.verify.ok
                                        ? <span className="text-emerald-400 inline-flex items-center gap-1" title={seg.verify.videoDuration ? `video is ${Math.round(seg.verify.videoDuration)}s long` : ""}><Check className="w-3 h-3" /> valid{seg.verify.videoDuration ? ` · vid ${Math.round(seg.verify.videoDuration)}s` : ""}</span>
                                        : <span className="text-destructive inline-flex items-center gap-1" title={seg.verify.message ?? ""}><X className="w-3 h-3" /> not in video</span>)
                                  : <span className="text-muted-foreground">length {fmtDuration(seg.startTime, seg.endTime)}</span>}
                            </span>
                            {msSegments.length > 2 && (
                              <button
                                type="button"
                                onClick={() => setMsSegments((p) => p.filter((_, i) => i !== index))}
                                className="ml-auto w-7 h-7 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors"
                                aria-label="Remove beat"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>

                          {seg.sourceType === "local" ? (
                            <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/[0.04] p-2.5">
                              {seg.thumbUrl ? (
                                <img src={seg.thumbUrl} alt="" className="w-16 h-16 object-cover rounded-md border border-border shrink-0" />
                              ) : (
                                <div className="w-16 h-16 rounded-md bg-muted grid place-items-center shrink-0"><Film className="w-5 h-5 text-muted-foreground" /></div>
                              )}
                              <div className="min-w-0">
                                <p className="text-[11px] font-mono uppercase tracking-[0.1em] text-primary">Scouted clip</p>
                                <p className="text-[11px] text-muted-foreground truncate">{fmtDuration(seg.startTime, seg.endTime)} · {seg.sourceChannel || "—"}</p>
                              </div>
                            </div>
                          ) : (
                          <>
                          <div>
                            <FieldLabel>Source URL</FieldLabel>
                            <Input
                              placeholder="https://youtube.com/watch?v=..."
                              className="font-mono text-sm bg-background"
                              value={seg.youtubeUrl}
                              onChange={(e) => updateMsSeg(index, { youtubeUrl: e.target.value })}
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <FieldLabel>In</FieldLabel>
                              <Input
                                placeholder="00:00:00"
                                className={`font-mono text-sm bg-background ${bad ? "border-destructive/50" : ""}`}
                                value={seg.startTime}
                                onChange={(e) => updateMsSeg(index, { startTime: e.target.value })}
                              />
                            </div>
                            <div>
                              <FieldLabel>Out</FieldLabel>
                              <Input
                                placeholder="00:00:10"
                                className={`font-mono text-sm bg-background ${bad ? "border-destructive/50" : ""}`}
                                value={seg.endTime}
                                onChange={(e) => updateMsSeg(index, { endTime: e.target.value })}
                              />
                            </div>
                          </div>

                          {seg.verify && !seg.verify.ok && (
                            <div className="rounded-lg border border-destructive/30 bg-destructive/[0.06] p-3 space-y-2">
                              <p className="text-[11px] text-destructive leading-snug">{seg.verify.message}</p>
                              {seg.verify.suggested ? (
                                <div className="flex items-start gap-2">
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[11px] text-foreground">
                                      Transcript match: <span className="font-mono">{seg.verify.suggested.startTime}–{seg.verify.suggested.endTime}</span>
                                      <span className="text-muted-foreground"> · {Math.round(seg.verify.suggested.confidence * 100)}% conf</span>
                                    </p>
                                    <p className="text-[10px] text-muted-foreground italic truncate">“{seg.verify.suggested.evidence}”</p>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => updateMsSeg(index, { startTime: seg.verify!.suggested!.startTime, endTime: seg.verify!.suggested!.endTime })}
                                    className="shrink-0 text-[10px] font-mono uppercase tracking-[0.08em] px-2.5 h-7 rounded-md bg-primary/15 border border-primary/30 text-primary hover:bg-primary/25 transition-colors"
                                  >
                                    Apply
                                  </button>
                                </div>
                              ) : (
                                <p className="text-[10px] text-muted-foreground">No transcript match — use “Re-ask Gemini” above, or fix the time manually.</p>
                              )}
                            </div>
                          )}
                          </>
                          )}

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <FieldLabel>Headline</FieldLabel>
                              <Input
                                placeholder="On-screen title…"
                                className="text-sm bg-background"
                                value={seg.headline}
                                onChange={(e) => updateMsSeg(index, { headline: e.target.value })}
                              />
                            </div>
                            <div>
                              <FieldLabel>Channel</FieldLabel>
                              <Input
                                placeholder="Credit channel…"
                                className="font-mono text-sm bg-background"
                                value={seg.sourceChannel}
                                onChange={(e) => updateMsSeg(index, { sourceChannel: e.target.value })}
                              />
                            </div>
                          </div>

                          <div>
                            <FieldLabel>Narration <span className="text-muted-foreground/40 normal-case">(spoken over this beat — the beat is timed to it)</span></FieldLabel>
                            <Textarea
                              placeholder="One punchy commentator line for this beat…"
                              className="text-sm bg-background min-h-[52px]"
                              value={seg.narrationLine}
                              onChange={(e) => updateMsSeg(index, { narrationLine: e.target.value })}
                            />
                          </div>
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => msSegments.length < 8 && setMsSegments((p) => [...p, { youtubeUrl: "", startTime: "00:00:00", endTime: "00:00:10", sourceChannel: "", headline: "", narrationLine: "", verify: null }])}
                      disabled={msSegments.length >= 8}
                      className={`w-full flex items-center justify-center gap-2 rounded-xl border border-dashed py-3 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                        msSegments.length >= 8
                          ? "text-muted-foreground/30 border-border cursor-not-allowed"
                          : "text-muted-foreground border-border hover:text-primary hover:border-primary/40"
                      }`}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      {msSegments.length >= 8 ? "Max 8 beats" : `Add beat (${msSegments.length})`}
                    </button>
                  </div>

                  {/* Legacy flat narration — optional. Per-beat lines above are used by default;
                      this is only read when NO beat has its own narration line. */}
                  <details className="group">
                    <summary className="cursor-pointer list-none">
                      <FieldLabel>Legacy flat narration <span className="text-muted-foreground/40 normal-case">(optional — only used if no beat has its own line)</span></FieldLabel>
                    </summary>
                    <Textarea
                      value={msNarration}
                      onChange={(e) => setMsNarration(e.target.value)}
                      placeholder={"0 | Ninety-third minute. One chance left.\n5 | The wall goes up — Messi stands over it.\n11 | And what he does next... is unreal."}
                      className="text-sm bg-background font-mono min-h-[100px] mt-2"
                    />
                  </details>

                  {/* Narration voice */}
                  <div className="rounded-xl border border-[#9b7bff]/30 bg-gradient-to-b from-[#9b7bff]/[0.08] to-[#9b7bff]/[0.02] p-4">
                    <div className="flex items-center gap-1.5">
                      <Mic className="w-3.5 h-3.5 text-[#9b7bff]" />
                      <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff]">Commentary voiceover</span>
                      <span className="text-[8.5px] font-semibold tracking-[0.14em] text-[#b69dff] border border-[#9b7bff]/40 rounded px-1.5 py-0.5">PRO</span>
                    </div>
                    <VoicePicker voice={voVoice} speed={voSpeed} onVoice={setVoVoice} onSpeed={setVoSpeed} autoVoice="en_GB-alan-medium" />
                  </div>

                  {/* Toggles + submit */}
                  <div className="flex flex-wrap gap-2">
                    <ToggleChip label="Captions" checked={msCaptions} onChange={setMsCaptions} />
                    <ToggleChip label="Outro card" checked={msOutro} onChange={setMsOutro} />
                    <ToggleChip label="Title card" checked={msTitleCard} onChange={setMsTitleCard} />
                    <ToggleChip label="Crossfades" checked={msTransitions} onChange={setMsTransitions} />
                  </div>

                  <div className="flex items-center justify-between gap-4 flex-wrap pt-1">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      Multi-source stitch · karaoke captions · commentary VO · slow on phone
                    </span>
                    <Button
                      type="button"
                      disabled={msSubmitting}
                      onClick={submitMatchStory}
                      className="font-mono uppercase tracking-[0.13em] text-xs h-12 px-7"
                    >
                      {msSubmitting ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />DISPATCHING…</>
                      ) : (
                        <><Zap className="mr-2 h-4 w-4" />ENQUEUE MATCH STORY</>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT — live preview (sticky on desktop) */}
            <div className="lg:sticky lg:top-[84px]">
              <LivePreview
                headline={preview.headline}
                mode={preview.mode}
                frameStyle={wFrame}
                captions={preview.captions}
                voiceover={preview.voiceover}
                hook={preview.hook}
                handle={channelHandle}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
