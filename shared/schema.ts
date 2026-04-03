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
  costTier: text("cost_tier").notNull().default("cheap"),
  computeTarget: text("compute_target").notNull().default("local"),
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
  costTier: z.string().default("cheap"),
  computeTarget: z.enum(["local"]).default("local"),
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
  imageUrl: text("image_url"),
  repeat: text("repeat"),
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
  imageUrl: z.string().nullable().optional(),
  repeat: z.string().nullable().optional(),
});
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;

export const notes = pgTable("notes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  tags: text("tags").array().notNull().default([]),
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertNoteSchema = z.object({
  title: z.string(),
  body: z.string().default(""),
  tags: z.array(z.string()).default([]),
  imageUrl: z.string().nullable().optional(),
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
  imageUrl: text("image_url"),
  template: text("template"),
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
  imageUrl: z.string().nullable().optional(),
  template: z.string().nullable().optional(),
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
  evolutionVersion: integer("evolution_version"),
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
  evolutionVersion: z.number().nullable().optional(),
});
export type InsertOpenclawProposal = z.infer<typeof insertOpenclawProposalSchema>;
export type OpenclawProposal = typeof openclawProposals.$inferSelect;

export type PermissionLevel = "autonomous" | "approval" | "blocked";

export const siteProfiles = pgTable("site_profiles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  baseUrl: text("base_url").notNull().default(""),
  urlPatterns: text("url_patterns").array().notNull().default([]),
  extractionSelectors: jsonb("extraction_selectors").$type<Record<string, string>>().default({}),
  actions: jsonb("actions").$type<Record<string, { selector: string; type: string; description?: string }>>().default({}),
  defaultPermission: text("default_permission").notNull().default("autonomous"),
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
  defaultPermission: z.enum(["autonomous", "approval", "blocked"]).default("autonomous"),
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
  permissionLevel: text("permission_level").notNull().default("autonomous"),
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
  permissionLevel: z.enum(["autonomous", "approval", "blocked"]).default("autonomous"),
});
export type InsertNavigationPath = z.infer<typeof insertNavigationPathSchema>;
export type NavigationPath = typeof navigationPaths.$inferSelect;

export const recipes = pgTable("recipes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  command: text("command").notNull(),
  schedule: text("schedule"),
  cronExpression: text("cron_expression"),
  enabled: boolean("enabled").notNull().default(true),
  lastRun: timestamp("last_run"),
  nextRun: timestamp("next_run"),
  runCount: integer("run_count").notNull().default(0),
  lastOutput: text("last_output"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertRecipeSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  command: z.string(),
  schedule: z.string().nullable().optional(),
  cronExpression: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
});
export type InsertRecipe = z.infer<typeof insertRecipeSchema>;
export type Recipe = typeof recipes.$inferSelect;

export const auditLog = pgTable("audit_log", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  permissionLevel: text("permission_level"),
  result: text("result").notNull().default("success"),
  details: text("details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAuditLogSchema = z.object({
  actor: z.enum(["human", "agent"]),
  action: z.string(),
  target: z.string().nullable().optional(),
  permissionLevel: z.enum(["autonomous", "approval", "blocked"]).nullable().optional(),
  result: z.string().default("success"),
  details: z.string().nullable().optional(),
});
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLog.$inferSelect;

export const transcripts = pgTable("transcripts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull().default(""),
  platform: text("platform").notNull().default("other"),
  sourceUrl: text("source_url"),
  durationSeconds: integer("duration_seconds"),
  rawText: text("raw_text").notNull().default(""),
  segments: jsonb("segments").$type<Array<{ start: number; end: number; text: string }>>().default([]),
  status: text("status").notNull().default("recording"),
  recordingType: text("recording_type").notNull().default("tab"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTranscriptSchema = z.object({
  title: z.string().default(""),
  platform: z.string().default("other"),
  sourceUrl: z.string().nullable().optional(),
  durationSeconds: z.number().nullable().optional(),
  rawText: z.string().default(""),
  segments: z.array(z.object({
    start: z.number(),
    end: z.number(),
    text: z.string(),
  })).default([]),
  status: z.string().default("recording"),
  recordingType: z.string().default("tab"),
});
export type InsertTranscript = z.infer<typeof insertTranscriptSchema>;
export type Transcript = typeof transcripts.$inferSelect;

export const actionPermissions = pgTable("action_permissions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  navPathId: integer("nav_path_id").notNull().references(() => navigationPaths.id, { onDelete: "cascade" }),
  actionName: text("action_name").notNull(),
  permissionLevel: text("permission_level").notNull().default("autonomous"),
});

export const insertActionPermissionSchema = z.object({
  navPathId: z.number(),
  actionName: z.string(),
  permissionLevel: z.enum(["autonomous", "approval", "blocked"]).default("autonomous"),
});
export type InsertActionPermission = z.infer<typeof insertActionPermissionSchema>;
export type ActionPermission = typeof actionPermissions.$inferSelect;

export const radarSeenItems = pgTable("radar_seen_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  contentHash: text("content_hash").notNull(),
  source: text("source").notNull(),
  url: text("url"),
  title: text("title"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertRadarSeenItemSchema = z.object({
  contentHash: z.string(),
  source: z.string(),
  url: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
});
export type InsertRadarSeenItem = z.infer<typeof insertRadarSeenItemSchema>;
export type RadarSeenItem = typeof radarSeenItems.$inferSelect;

export const radarEngagement = pgTable("radar_engagement", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  url: text("url").notNull(),
  source: text("source"),
  title: text("title"),
  programName: text("program_name").notNull().default("research-radar"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertRadarEngagementSchema = z.object({
  url: z.string(),
  source: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  programName: z.string().default("research-radar"),
});
export type InsertRadarEngagement = z.infer<typeof insertRadarEngagementSchema>;
export type RadarEngagement = typeof radarEngagement.$inferSelect;

export interface MealEntry {
  name: string;
  appliance: string;
  ingredients: string[];
  instructions?: string;
  isKiddoTrial?: boolean;
  bridgeRationale?: string;
}

export interface DayPlan {
  day: string;
  breakfast?: MealEntry;
  lunch?: MealEntry;
  dinner?: MealEntry;
  snacks?: MealEntry[];
}

export const mealPlans = pgTable("meal_plans", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  weekStart: text("week_start").notNull(),
  days: jsonb("days").$type<DayPlan[]>().notNull().default([]),
  preferencesSnapshot: jsonb("preferences_snapshot").$type<Record<string, any>>().default({}),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMealPlanSchema = z.object({
  weekStart: z.string(),
  days: z.array(z.any()).default([]),
  preferencesSnapshot: z.record(z.string(), z.any()).default({}),
  status: z.string().default("active"),
});
export type InsertMealPlan = z.infer<typeof insertMealPlanSchema>;
export type MealPlan = typeof mealPlans.$inferSelect;

export interface ShoppingItem {
  name: string;
  quantity: number;
  unit: string;
  category: string;
  matchedProduct?: string;
  nutriScore?: string;
  novaGroup?: number;
  price?: number;
  store?: string;
}

export const shoppingLists = pgTable("shopping_lists", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  mealPlanId: integer("meal_plan_id"),
  items: jsonb("items").$type<ShoppingItem[]>().notNull().default([]),
  cartStatus: text("cart_status").notNull().default("pending"),
  store: text("store"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertShoppingListSchema = z.object({
  mealPlanId: z.number().nullable().optional(),
  items: z.array(z.any()).default([]),
  cartStatus: z.string().default("pending"),
  store: z.string().nullable().optional(),
});
export type InsertShoppingList = z.infer<typeof insertShoppingListSchema>;
export type ShoppingList = typeof shoppingLists.$inferSelect;

export const pantryItems = pgTable("pantry_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  category: text("category").notNull().default("other"),
  quantity: text("quantity").notNull().default("1"),
  unit: text("unit").notNull().default("item"),
  purchaseDate: timestamp("purchase_date").notNull().defaultNow(),
  estimatedExpiration: timestamp("estimated_expiration"),
  consumptionHistory: jsonb("consumption_history").$type<Array<{ date: string; quantity: number }>>().default([]),
  avgDaysToConsume: integer("avg_days_to_consume"),
  status: text("status").notNull().default("in_stock"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPantryItemSchema = z.object({
  name: z.string(),
  category: z.string().default("other"),
  quantity: z.string().default("1"),
  unit: z.string().default("item"),
  purchaseDate: z.date().optional(),
  estimatedExpiration: z.date().nullable().optional(),
  consumptionHistory: z.array(z.any()).default([]),
  avgDaysToConsume: z.number().nullable().optional(),
  status: z.string().default("in_stock"),
});
export type InsertPantryItem = z.infer<typeof insertPantryItemSchema>;
export type PantryItem = typeof pantryItems.$inferSelect;

export const kiddoFoodLog = pgTable("kiddo_food_log", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  itemName: text("item_name").notNull(),
  verdict: text("verdict").notNull(),
  similaritySource: text("similarity_source"),
  notes: text("notes"),
  logDate: timestamp("log_date").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertKiddoFoodLogSchema = z.object({
  itemName: z.string(),
  verdict: z.enum(["accepted", "rejected"]),
  similaritySource: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  logDate: z.date().optional(),
});
export type InsertKiddoFoodLog = z.infer<typeof insertKiddoFoodLogSchema>;
export type KiddoFoodLog = typeof kiddoFoodLog.$inferSelect;

export const nightlyRecommendations = pgTable("nightly_recommendations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  recDate: text("rec_date").notNull(),
  recipeRecommendation: jsonb("recipe_recommendation").$type<{
    name: string;
    appliance: string;
    ingredients: string[];
    instructions: string;
    nutriScoreAvg?: string;
  }>(),
  kiddoLunchSuggestion: jsonb("kiddo_lunch_suggestion").$type<{
    item: string;
    bridgeRationale: string;
    similarTo: string;
  }>(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertNightlyRecommendationSchema = z.object({
  recDate: z.string(),
  recipeRecommendation: z.any().nullable().optional(),
  kiddoLunchSuggestion: z.any().nullable().optional(),
  status: z.string().default("pending"),
});
export type InsertNightlyRecommendation = z.infer<typeof insertNightlyRecommendationSchema>;
export type NightlyRecommendation = typeof nightlyRecommendations.$inferSelect;

export const agentMemories = pgTable("agent_memories", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  programName: text("program_name"),
  content: text("content").notNull(),
  memoryType: text("memory_type").notNull().default("fact"),
  tags: text("tags").array().notNull().default([]),
  relevanceScore: integer("relevance_score").notNull().default(100),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessed: timestamp("last_accessed").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  subject: text("subject"),
  validUntil: timestamp("valid_until"),
  qdrantId: text("qdrant_id"),
  sourceKbId: integer("source_kb_id").references(() => galaxyKb.id),
});

export const insertAgentMemorySchema = z.object({
  programName: z.string().nullable().optional(),
  content: z.string(),
  memoryType: z.enum(["fact", "outcome", "observation", "episodic", "semantic", "procedural"]).default("fact"),
  tags: z.array(z.string()).default([]),
  relevanceScore: z.number().default(100),
  subject: z.string().nullable().optional(),
  validUntil: z.date().nullable().optional(),
  qdrantId: z.string().nullable().optional(),
  sourceKbId: z.number().nullable().optional(),
});
export type InsertAgentMemory = z.infer<typeof insertAgentMemorySchema>;
export type AgentMemory = typeof agentMemories.$inferSelect;

export const evolutionVersions = pgTable("evolution_versions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  version: integer("version").notNull(),
  changes: jsonb("changes").$type<Record<string, { before: string; after: string }>>().default({}),
  gateResults: jsonb("gate_results").$type<Record<string, { passed: boolean; reason: string }>>().default({}),
  metricsSnapshot: jsonb("metrics_snapshot").$type<{ successRate: number; correctionRate: number; evolutionCount: number; rollbackCount: number }>(),
  appliedAt: timestamp("applied_at").notNull().defaultNow(),
  rolledBackAt: timestamp("rolled_back_at"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEvolutionVersionSchema = z.object({
  version: z.number(),
  changes: z.record(z.string(), z.object({ before: z.string(), after: z.string() })).default({}),
  gateResults: z.record(z.string(), z.object({ passed: z.boolean(), reason: z.string() })).default({}),
  metricsSnapshot: z.object({
    successRate: z.number(),
    correctionRate: z.number(),
    totalRuns: z.number(),
    successfulRuns: z.number(),
    corrections: z.number(),
  }).nullable().optional(),
  status: z.string().default("active"),
});
export type InsertEvolutionVersion = z.infer<typeof insertEvolutionVersionSchema>;
export type EvolutionVersion = typeof evolutionVersions.$inferSelect;

export const goldenSuite = pgTable("golden_suite", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  input: text("input").notNull(),
  expectedOutput: text("expected_output").notNull(),
  source: text("source").notNull().default("correction"),
  programName: text("program_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertGoldenSuiteSchema = z.object({
  input: z.string(),
  expectedOutput: z.string(),
  source: z.string().default("correction"),
  programName: z.string().nullable().optional(),
});
export type InsertGoldenSuite = z.infer<typeof insertGoldenSuiteSchema>;
export type GoldenSuiteEntry = typeof goldenSuite.$inferSelect;

export const evolutionObservations = pgTable("evolution_observations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  programName: text("program_name"),
  observationType: text("observation_type").notNull().default("general"),
  content: text("content").notNull(),
  consolidated: boolean("consolidated").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEvolutionObservationSchema = z.object({
  programName: z.string().nullable().optional(),
  observationType: z.string().default("general"),
  content: z.string(),
  consolidated: z.boolean().default(false),
});
export type InsertEvolutionObservation = z.infer<typeof insertEvolutionObservationSchema>;
export type EvolutionObservation = typeof evolutionObservations.$inferSelect;

export const judgeCostTracking = pgTable("judge_cost_tracking", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  judgeType: text("judge_type").notNull(),
  model: text("model").notNull(),
  tokensUsed: integer("tokens_used").notNull().default(0),
  estimatedCost: text("estimated_cost").notNull().default("0"),
  date: text("date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertJudgeCostSchema = z.object({
  judgeType: z.string(),
  model: z.string(),
  tokensUsed: z.number().default(0),
  estimatedCost: z.string().default("0"),
  date: z.string(),
});
export type InsertJudgeCost = z.infer<typeof insertJudgeCostSchema>;
export type JudgeCost = typeof judgeCostTracking.$inferSelect;

export const galaxyKb = pgTable("galaxy_kb", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  url: text("url").notNull().unique(),
  category: text("category").notNull().default("General"),
  summary: text("summary"),
  fullText: text("full_text"),
  tags: text("tags").array().notNull().default([]),
  verified: boolean("verified").notNull().default(false),
  verifiedAt: timestamp("verified_at"),
  verifiedBy: text("verified_by"),
  flagged: boolean("flagged").notNull().default(false),
  flagReason: text("flag_reason"),
  userNotes: text("user_notes"),
  memoryCount: integer("memory_count").notNull().default(0),
  agentAccessCount: integer("agent_access_count").notNull().default(0),
  searchTerm: text("search_term"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertGalaxyKbSchema = z.object({
  title: z.string(),
  url: z.string(),
  category: z.string().default("General"),
  summary: z.string().nullable().optional(),
  fullText: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  verified: z.boolean().default(false),
  verifiedAt: z.date().nullable().optional(),
  verifiedBy: z.string().nullable().optional(),
  flagged: z.boolean().default(false),
  flagReason: z.string().nullable().optional(),
  userNotes: z.string().nullable().optional(),
  memoryCount: z.number().default(0),
  agentAccessCount: z.number().default(0),
  searchTerm: z.string().nullable().optional(),
});
export type InsertGalaxyKb = z.infer<typeof insertGalaxyKbSchema>;
export type GalaxyKbEntry = typeof galaxyKb.$inferSelect;

export const outlookEmails = pgTable("outlook_emails", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  messageId: text("message_id").unique(),
  from: text("from_address").notNull(),
  subject: text("subject").notNull(),
  date: text("date").notNull(),
  body: text("body"),
  preview: text("preview"),
  unread: boolean("unread").notNull().default(true),
  isSnowNotification: boolean("is_snow_notification").notNull().default(false),
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
});

export const insertOutlookEmailSchema = z.object({
  messageId: z.string().nullable().optional(),
  from: z.string(),
  subject: z.string(),
  date: z.string(),
  body: z.string().nullable().optional(),
  preview: z.string().nullable().optional(),
  unread: z.boolean().default(true),
  isSnowNotification: z.boolean().default(false),
});
export type InsertOutlookEmail = z.infer<typeof insertOutlookEmailSchema>;
export type OutlookEmail = typeof outlookEmails.$inferSelect;

export const snowTickets = pgTable("snow_tickets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  number: text("number").notNull().unique(),
  type: text("type").notNull().default("incident"),
  shortDescription: text("short_description").notNull(),
  state: text("state").notNull().default("New"),
  priority: text("priority").notNull().default(""),
  assignedTo: text("assigned_to").notNull().default(""),
  assignmentGroup: text("assignment_group").notNull().default(""),
  updatedOn: text("updated_on").notNull().default(""),
  source: text("source").notNull().default("personal"),
  slaBreached: boolean("sla_breached").notNull().default(false),
  url: text("url"),
  detailCached: text("detail_cached"),
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
});

export const insertSnowTicketSchema = z.object({
  number: z.string(),
  type: z.string().default("incident"),
  shortDescription: z.string(),
  state: z.string().default("New"),
  priority: z.string().default(""),
  assignedTo: z.string().default(""),
  assignmentGroup: z.string().default(""),
  updatedOn: z.string().default(""),
  source: z.string().default("personal"),
  slaBreached: z.boolean().default(false),
  url: z.string().nullable().optional(),
  detailCached: z.string().nullable().optional(),
});
export type InsertSnowTicket = z.infer<typeof insertSnowTicketSchema>;
export type SnowTicket = typeof snowTickets.$inferSelect;
