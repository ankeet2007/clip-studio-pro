import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

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
  transcript: text("transcript"),
  // Pro-only: AI intro-hook voiceover. The hook line is user-supplied (typed or
  // pasted from their Gemini app); Piper TTS speaks it over the first few seconds.
  voiceoverEnabled: boolean("voiceover_enabled").notNull().default(false),
  voiceoverHook: text("voiceover_hook"),
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
