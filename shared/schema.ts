import { pgTable, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { z } from "zod";

export const programs = pgTable("programs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull().unique(),
  type: text("type").notNull().default("monitor"),
  schedule: text("schedule"),
  cronExpression: text("cron_expression"),
  code: text("code"),
  codeLang: text("code_lang").default("typescript"),
  instructions: text("instructions").notNull().default(""),
  config: jsonb("config").$type<Record<string, string>>().default({}),
  enabled: boolean("enabled").notNull().default(true),
  costTier: text("cost_tier").notNull().default("free"),
  tags: text("tags").array().notNull().default([]),
  lastRun: timestamp("last_run"),
  nextRun: timestamp("next_run"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProgramSchema = z.object({
  name: z.string(),
  type: z.string().default("monitor"),
  schedule: z.string().nullable().optional(),
  cronExpression: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
  codeLang: z.string().default("typescript"),
  instructions: z.string().default(""),
  config: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
  costTier: z.string().default("free"),
  tags: z.array(z.string()).default([]),
});
export type InsertProgram = z.infer<typeof insertProgramSchema>;
export type Program = typeof programs.$inferSelect;

export const skills = pgTable("skills", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  content: text("content").notNull().default(""),
  type: text("type").notNull().default("skill"),
  scriptPath: text("script_path"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSkillSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  content: z.string().default(""),
  type: z.string().default("skill"),
  scriptPath: z.string().nullable().optional(),
});
export type InsertSkill = z.infer<typeof insertSkillSchema>;
export type Skill = typeof skills.$inferSelect;

export const agentConfig = pgTable("agent_config", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  key: text("key").notNull().unique(),
  value: text("value").notNull().default(""),
  category: text("category").notNull().default("general"),
});

export const insertAgentConfigSchema = z.object({
  key: z.string(),
  value: z.string().default(""),
  category: z.string().default("general"),
});
export type InsertAgentConfig = z.infer<typeof insertAgentConfigSchema>;
export type AgentConfig = typeof agentConfig.$inferSelect;

export const tasks = pgTable("tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  status: text("status").notNull().default("TODO"),
  body: text("body").notNull().default(""),
  scheduledDate: text("scheduled_date"),
  deadlineDate: text("deadline_date"),
  priority: text("priority"),
  tags: text("tags").array().notNull().default([]),
  parentId: integer("parent_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTaskSchema = z.object({
  title: z.string(),
  status: z.string().default("TODO"),
  body: z.string().default(""),
  scheduledDate: z.string().nullable().optional(),
  deadlineDate: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  parentId: z.number().nullable().optional(),
});
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;

export const notes = pgTable("notes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  tags: text("tags").array().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertNoteSchema = z.object({
  title: z.string(),
  body: z.string().default(""),
  tags: z.array(z.string()).default([]),
});
export type InsertNote = z.infer<typeof insertNoteSchema>;
export type Note = typeof notes.$inferSelect;

export const captures = pgTable("captures", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  content: text("content").notNull(),
  type: text("type").notNull().default("text"),
  source: text("source"),
  processed: boolean("processed").notNull().default(false),
  detectedType: text("detected_type"),
  urlTitle: text("url_title"),
  urlDescription: text("url_description"),
  urlImage: text("url_image"),
  urlDomain: text("url_domain"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCaptureSchema = z.object({
  content: z.string(),
  type: z.string().default("text"),
  source: z.string().nullable().optional(),
  detectedType: z.string().nullable().optional(),
  urlTitle: z.string().nullable().optional(),
  urlDescription: z.string().nullable().optional(),
  urlImage: z.string().nullable().optional(),
  urlDomain: z.string().nullable().optional(),
});
export type InsertCapture = z.infer<typeof insertCaptureSchema>;
export type Capture = typeof captures.$inferSelect;

export const agentResults = pgTable("agent_results", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  programId: integer("program_id"),
  programName: text("program_name").notNull(),
  summary: text("summary").notNull(),
  metric: text("metric"),
  model: text("model"),
  tokensUsed: integer("tokens_used"),
  iteration: integer("iteration"),
  rawOutput: text("raw_output"),
  status: text("status").notNull().default("ok"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAgentResultSchema = z.object({
  programId: z.number().nullable().optional(),
  programName: z.string(),
  summary: z.string(),
  metric: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  tokensUsed: z.number().nullable().optional(),
  iteration: z.number().nullable().optional(),
  rawOutput: z.string().nullable().optional(),
  status: z.string().default("ok"),
});
export type InsertAgentResult = z.infer<typeof insertAgentResultSchema>;
export type AgentResult = typeof agentResults.$inferSelect;

export const readerPages = pgTable("reader_pages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  url: text("url").notNull(),
  title: text("title").notNull().default(""),
  extractedText: text("extracted_text").notNull().default(""),
  domain: text("domain"),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
});

export const insertReaderPageSchema = z.object({
  url: z.string(),
  title: z.string().default(""),
  extractedText: z.string().default(""),
  domain: z.string().nullable().optional(),
});
export type InsertReaderPage = z.infer<typeof insertReaderPageSchema>;
export type ReaderPage = typeof readerPages.$inferSelect;

export const openclawProposals = pgTable("openclaw_proposals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  section: text("section").notNull(),
  targetName: text("target_name"),
  reason: text("reason").notNull(),
  currentContent: text("current_content").notNull(),
  proposedContent: text("proposed_content").notNull(),
  status: text("status").notNull().default("pending"),
  source: text("source").notNull().default("agent"),
  warnings: text("warnings"),
  proposalType: text("proposal_type").notNull().default("change"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

export const insertOpenclawProposalSchema = z.object({
  section: z.string(),
  targetName: z.string().nullable().optional(),
  reason: z.string(),
  currentContent: z.string(),
  proposedContent: z.string(),
  source: z.string().default("agent"),
  warnings: z.string().nullable().optional(),
  proposalType: z.string().default("change"),
});
export type InsertOpenclawProposal = z.infer<typeof insertOpenclawProposalSchema>;
export type OpenclawProposal = typeof openclawProposals.$inferSelect;

export const siteProfiles = pgTable("site_profiles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  baseUrl: text("base_url").notNull().default(""),
  urlPatterns: text("url_patterns").array().notNull().default([]),
  extractionSelectors: jsonb("extraction_selectors").$type<Record<string, string>>().default({}),
  actions: jsonb("actions").$type<Record<string, { selector: string; type: string; description?: string }>>().default({}),
  version: integer("version").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSiteProfileSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  baseUrl: z.string().default(""),
  urlPatterns: z.array(z.string()).default([]),
  extractionSelectors: z.record(z.string(), z.string()).default({}),
  actions: z.record(z.string(), z.object({
    selector: z.string(),
    type: z.string(),
    description: z.string().optional(),
  })).default({}),
  version: z.number().default(1),
  enabled: z.boolean().default(true),
});
export type InsertSiteProfile = z.infer<typeof insertSiteProfileSchema>;
export type SiteProfile = typeof siteProfiles.$inferSelect;

export const navigationPaths = pgTable("navigation_paths", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  siteProfileId: integer("site_profile_id").notNull().references(() => siteProfiles.id, { onDelete: "cascade" }),
  steps: jsonb("steps").$type<NavigationStep[]>().notNull().default([]),
  extractionRules: jsonb("extraction_rules").$type<Record<string, string>>().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export interface NavigationStep {
  action: "navigate" | "click" | "click_text" | "type" | "press_key" | "wait" | "scroll" | "extract";
  target?: string;
  value?: string;
  waitMs?: number;
  description?: string;
}

export const insertNavigationPathSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  siteProfileId: z.number(),
  steps: z.array(z.object({
    action: z.enum(["navigate", "click", "click_text", "type", "press_key", "wait", "scroll", "extract"]),
    target: z.string().optional(),
    value: z.string().optional(),
    waitMs: z.number().optional(),
    description: z.string().optional(),
  })).default([]),
  extractionRules: z.record(z.string(), z.string()).default({}),
});
export type InsertNavigationPath = z.infer<typeof insertNavigationPathSchema>;
export type NavigationPath = typeof navigationPaths.$inferSelect;
