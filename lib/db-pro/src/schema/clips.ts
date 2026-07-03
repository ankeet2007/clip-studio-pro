import { pgTable, text, serial, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Pro-only: one moment of a multi-clip STORY (Feature 2). A story row carries an
// array of these in the `segments` jsonb column; timestamps are absolute in the source.
export interface StorySegment {
  startTime: string;
  endTime: string;
  headline?: string;
  zoomMoments?: string;
  punchInEnabled?: boolean;
}

// Pro-only: one ranked moment of a TOP 5 countdown (jobType "top5"). Superset of
// StorySegment: each moment can carry its OWN source URL (multi-source top-5s pull each
// rank from a different video; empty ⇒ fall back to the job-level youtubeUrl), a `rank`
// (5→1), the source channel for its "Credit:" line, and one spoken countdown line
// ("Number five: ..."). Stored in the same `segments` jsonb column as StorySegment.
export interface Top5Segment extends StorySegment {
  rank: number;
  youtubeUrl?: string;
  sourceChannel?: string;
  narrationLine?: string;
}

export const clipsTable = pgTable("clips_pro", {
  id: serial("id").primaryKey(),
  youtubeUrl: text("youtube_url"),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  headline: text("headline").notNull().default(""),
  mode: text("mode").notNull().default("edited"),
  frameStyle: text("frame_style").notNull().default("immersive"),
  sourceType: text("source_type").notNull().default("youtube"),
  localFilePath: text("local_file_path"),
  localFileName: text("local_file_name"),
  status: text("status").notNull().default("pending"),
  progress: integer("progress").notNull().default(0),
  errorMessage: text("error_message"),
  outputFilename: text("output_filename"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  sourceChannel: text("source_channel").notNull().default(""),
  captionsEnabled: boolean("captions_enabled").notNull().default(true),
  // Pro-only: highlight (spoken/active word) colour for the karaoke captions, as "#RRGGBB".
  // Blank = the classic bright-yellow default. Persisted so Retry restores the chosen colour.
  captionColor: text("caption_color").notNull().default(""),
  transcript: text("transcript"),
  // Pro-only: AI intro-hook voiceover. The hook line is user-supplied (typed or
  // pasted from their Gemini app); Piper TTS speaks it over the first few seconds.
  voiceoverEnabled: boolean("voiceover_enabled").notNull().default(false),
  voiceoverHook: text("voiceover_hook"),
  // Pro-only: full narration mode. voiceoverMode gates "hook" (one intro line over
  // the first few seconds) vs "script" (multiple timed lines spoken across the whole
  // clip). narrationScript holds those lines as "SS | text" (one per line), parsed
  // server-side like zoomMoments. Persisted so Retry re-renders the same narration.
  voiceoverMode: text("voiceover_mode").notNull().default("hook"),
  narrationScript: text("narration_script").notNull().default(""),
  // Pro-only: AI Auto-Zoom. punchInEnabled gates the effect; zoomMoments is the
  // Gemini-chosen "second type" list. Persisted so Retry re-renders WITH the zoom
  // (previously these rode only the create request and were lost on retry).
  punchInEnabled: boolean("punch_in_enabled").notNull().default(false),
  zoomMoments: text("zoom_moments").notNull().default(""),
  // Whether the closing outro/CTA is appended (a real toggle, defaults on). Persisted so
  // Retry restores it too, instead of forcing it back on.
  outroEnabled: boolean("outro_enabled").notNull().default(true),
  // Pro-only: Multi-clip Story mode (Feature 2). jobType "clip" = normal single clip;
  // "story" = stitch `segments` (9-10 moments from one source) into one video with
  // bridging narration (reuses narrationScript, timestamped on the STITCHED timeline).
  // "top5" = a Top 5 countdown: `segments` are Top5Segments (each with a rank + optional
  // per-moment source URL), stitched behind a title card with #5→#1 rank badges and a
  // countdown voiceover. Persisted so Retry re-renders the whole job from the same row.
  jobType: text("job_type").notNull().default("clip"),
  segments: jsonb("segments").$type<(StorySegment | Top5Segment)[]>().notNull().default([]),
});

export const insertClipSchema = createInsertSchema(clipsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  errorMessage: true,
  outputFilename: true,
  transcript: true,
});

export type InsertClip = z.infer<typeof insertClipSchema>;
export type Clip = typeof clipsTable.$inferSelect;
