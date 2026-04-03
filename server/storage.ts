import {
  type Program, type InsertProgram, programs,
  type Skill, type InsertSkill, skills,
  type AgentConfig, type InsertAgentConfig, agentConfig,
  type Task, type InsertTask, tasks,
  type Note, type InsertNote, notes,
  type Capture, type InsertCapture, captures,
  type AgentResult, type InsertAgentResult, agentResults,
  type ReaderPage, type InsertReaderPage, readerPages,
  type OpenclawProposal, type InsertOpenclawProposal, openclawProposals,
  type SiteProfile, type InsertSiteProfile, siteProfiles,
  type NavigationPath, type InsertNavigationPath, navigationPaths,
  type AuditLog, type InsertAuditLog, auditLog,
  type ActionPermission, actionPermissions,
  type Recipe, type InsertRecipe, recipes,
  type Transcript, type InsertTranscript, transcripts,
  type RadarSeenItem, type InsertRadarSeenItem, radarSeenItems,
  type RadarEngagement, type InsertRadarEngagement, radarEngagement,
  type MealPlan, type InsertMealPlan, mealPlans,
  type ShoppingList, type InsertShoppingList, shoppingLists,
  type PantryItem, type InsertPantryItem, pantryItems,
  type KiddoFoodLog, type InsertKiddoFoodLog, kiddoFoodLog,
  type NightlyRecommendation, type InsertNightlyRecommendation, nightlyRecommendations,
  type AgentMemory, type InsertAgentMemory, agentMemories,
  type EvolutionVersion, type InsertEvolutionVersion, evolutionVersions,
  type GoldenSuiteEntry, type InsertGoldenSuite, goldenSuite,
  type EvolutionObservation, type InsertEvolutionObservation, evolutionObservations,
  type JudgeCost, type InsertJudgeCost, judgeCostTracking,
  type GalaxyKbEntry, type InsertGalaxyKb, galaxyKb,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, or, lte, gte, ilike, sql, asc } from "drizzle-orm";

export interface IStorage {
  getPrograms(): Promise<Program[]>;
  getProgram(id: number): Promise<Program | undefined>;
  getProgramByName(name: string): Promise<Program | undefined>;
  createProgram(p: InsertProgram): Promise<Program>;
  updateProgram(id: number, data: Partial<InsertProgram>): Promise<Program | undefined>;
  deleteProgram(id: number): Promise<void>;
  toggleProgramEnabled(id: number): Promise<Program | undefined>;
  updateProgramLastRun(id: number, lastRun: Date, nextRun: Date | null): Promise<void>;

  getSkills(): Promise<Skill[]>;
  getSkill(id: number): Promise<Skill | undefined>;
  createSkill(s: InsertSkill): Promise<Skill>;
  updateSkill(id: number, data: Partial<InsertSkill>): Promise<Skill | undefined>;
  deleteSkill(id: number): Promise<void>;

  getAgentConfigs(): Promise<AgentConfig[]>;
  getAgentConfig(key: string): Promise<AgentConfig | undefined>;
  setAgentConfig(key: string, value: string, category?: string): Promise<AgentConfig>;
  deleteAgentConfig(key: string): Promise<void>;

  getTasks(status?: string): Promise<Task[]>;
  getTask(id: number): Promise<Task | undefined>;
  createTask(t: InsertTask): Promise<Task>;
  updateTask(id: number, data: Partial<InsertTask>): Promise<Task | undefined>;
  deleteTask(id: number): Promise<void>;
  getTasksByDate(date: string): Promise<Task[]>;
  getOverdueTasks(today: string): Promise<Task[]>;
  getUpcomingTasks(today: string, limit?: number): Promise<Task[]>;

  getNotes(): Promise<Note[]>;
  getNote(id: number): Promise<Note | undefined>;
  createNote(n: InsertNote): Promise<Note>;
  updateNote(id: number, data: Partial<InsertNote>): Promise<Note | undefined>;
  deleteNote(id: number): Promise<void>;

  getCaptures(processed?: boolean): Promise<Capture[]>;
  getCapture(id: number): Promise<Capture | undefined>;
  createCapture(c: InsertCapture): Promise<Capture>;
  updateCapture(id: number, data: Partial<InsertCapture>): Promise<Capture | undefined>;
  markCaptureProcessed(id: number): Promise<void>;
  deleteCapture(id: number): Promise<void>;

  getAgentResults(programName?: string, limit?: number): Promise<AgentResult[]>;
  getAgentResult(id: number): Promise<AgentResult | undefined>;
  createAgentResult(r: InsertAgentResult): Promise<AgentResult>;
  getLatestResults(limit?: number): Promise<AgentResult[]>;

  getReaderPages(): Promise<ReaderPage[]>;
  getReaderPage(id: number): Promise<ReaderPage | undefined>;
  createReaderPage(p: InsertReaderPage): Promise<ReaderPage>;
  deleteReaderPage(id: number): Promise<void>;

  createProposal(proposal: InsertOpenclawProposal): Promise<OpenclawProposal>;
  getProposals(status?: string): Promise<OpenclawProposal[]>;
  getProposal(id: number): Promise<OpenclawProposal | undefined>;
  updateProposalStatus(id: number, status: string, resolvedAt: Date): Promise<OpenclawProposal | undefined>;

  getSiteProfiles(): Promise<SiteProfile[]>;
  getSiteProfile(id: number): Promise<SiteProfile | undefined>;
  getSiteProfileByName(name: string): Promise<SiteProfile | undefined>;
  createSiteProfile(p: InsertSiteProfile): Promise<SiteProfile>;
  updateSiteProfile(id: number, data: Partial<InsertSiteProfile>): Promise<SiteProfile | undefined>;
  deleteSiteProfile(id: number): Promise<void>;

  getNavigationPaths(siteProfileId?: number): Promise<NavigationPath[]>;
  getNavigationPath(id: number): Promise<NavigationPath | undefined>;
  createNavigationPath(p: InsertNavigationPath): Promise<NavigationPath>;
  updateNavigationPath(id: number, data: Partial<InsertNavigationPath>): Promise<NavigationPath | undefined>;
  deleteNavigationPath(id: number): Promise<void>;

  createAuditLog(entry: InsertAuditLog): Promise<AuditLog>;
  getAuditLogs(limit?: number): Promise<AuditLog[]>;
  getAuditLogsByActor(actor: string, limit?: number): Promise<AuditLog[]>;

  getActionPermissions(): Promise<ActionPermission[]>;
  getActionPermission(navPathId: number, actionName: string): Promise<ActionPermission | undefined>;
  setActionPermission(navPathId: number, actionName: string, level: string): Promise<ActionPermission>;
  deleteActionPermission(id: number): Promise<void>;

  getRecipes(): Promise<Recipe[]>;
  getRecipe(id: number): Promise<Recipe | undefined>;
  getRecipeByName(name: string): Promise<Recipe | undefined>;
  createRecipe(r: InsertRecipe): Promise<Recipe>;
  updateRecipe(id: number, data: Partial<InsertRecipe>): Promise<Recipe | undefined>;
  deleteRecipe(id: number): Promise<void>;
  updateRecipeLastRun(id: number, lastRun: Date, nextRun: Date | null, output: string): Promise<void>;
  toggleRecipeEnabled(id: number): Promise<Recipe | undefined>;

  getTranscripts(): Promise<Transcript[]>;
  getTranscript(id: number): Promise<Transcript | undefined>;
  createTranscript(t: InsertTranscript): Promise<Transcript>;
  updateTranscript(id: number, data: Partial<InsertTranscript>): Promise<Transcript | undefined>;
  deleteTranscript(id: number): Promise<void>;

  getRadarSeenHashes(since: Date): Promise<string[]>;
  createRadarSeenItems(items: InsertRadarSeenItem[]): Promise<void>;
  cleanOldRadarSeenItems(before: Date): Promise<void>;

  getRadarEngagement(since: Date): Promise<RadarEngagement[]>;
  createRadarEngagement(e: InsertRadarEngagement): Promise<RadarEngagement>;

  updateProgramConfig(id: number, config: Record<string, string>): Promise<Program | undefined>;

  searchAll(query: string): Promise<Array<{ type: string; id: number; title: string; snippet: string }>>;

  getMealPlans(): Promise<MealPlan[]>;
  getMealPlan(id: number): Promise<MealPlan | undefined>;
  createMealPlan(p: InsertMealPlan): Promise<MealPlan>;
  updateMealPlan(id: number, data: Partial<InsertMealPlan>): Promise<MealPlan | undefined>;
  deleteMealPlan(id: number): Promise<void>;
  getActiveMealPlan(): Promise<MealPlan | undefined>;

  getShoppingLists(): Promise<ShoppingList[]>;
  getShoppingList(id: number): Promise<ShoppingList | undefined>;
  createShoppingList(s: InsertShoppingList): Promise<ShoppingList>;
  updateShoppingList(id: number, data: Partial<InsertShoppingList>): Promise<ShoppingList | undefined>;
  deleteShoppingList(id: number): Promise<void>;

  getPantryItems(status?: string): Promise<PantryItem[]>;
  getPantryItem(id: number): Promise<PantryItem | undefined>;
  getPantryItemByName(name: string): Promise<PantryItem | undefined>;
  createPantryItem(p: InsertPantryItem): Promise<PantryItem>;
  updatePantryItem(id: number, data: Partial<InsertPantryItem>): Promise<PantryItem | undefined>;
  deletePantryItem(id: number): Promise<void>;

  getKiddoFoodLogs(): Promise<KiddoFoodLog[]>;
  createKiddoFoodLog(l: InsertKiddoFoodLog): Promise<KiddoFoodLog>;

  getNightlyRecommendations(limit?: number): Promise<NightlyRecommendation[]>;
  getNightlyRecommendation(id: number): Promise<NightlyRecommendation | undefined>;
  getNightlyRecommendationByDate(date: string): Promise<NightlyRecommendation | undefined>;
  createNightlyRecommendation(r: InsertNightlyRecommendation): Promise<NightlyRecommendation>;
  updateNightlyRecommendationStatus(id: number, status: string): Promise<NightlyRecommendation | undefined>;

  createMemory(m: InsertAgentMemory): Promise<AgentMemory>;
  getMemoriesForProgram(programName: string | null, options?: { tags?: string[]; type?: string; limit?: number; minRelevance?: number }): Promise<AgentMemory[]>;
  updateMemoryRelevance(id: number, relevanceScore: number): Promise<void>;
  updateMemoryAccess(id: number): Promise<void>;
  deleteMemory(id: number): Promise<void>;
  searchMemories(query: string, limit?: number, programName?: string): Promise<AgentMemory[]>;
  getAllMemories(limit?: number): Promise<AgentMemory[]>;
  consolidateOldMemories(beforeDate: Date, decayAmount?: number): Promise<number>;
  updateMemoryQdrantId(id: number, qdrantId: string): Promise<void>;
  searchMemoriesBySubject(subject: string, programName: string | null): Promise<AgentMemory[]>;
  expireMemory(id: number, validUntil: Date): Promise<void>;
  getMemoriesByIds(ids: number[]): Promise<AgentMemory[]>;

  getEvolutionVersions(limit?: number): Promise<EvolutionVersion[]>;
  getEvolutionVersion(id: number): Promise<EvolutionVersion | undefined>;
  getLatestEvolutionVersion(): Promise<EvolutionVersion | undefined>;
  createEvolutionVersion(v: InsertEvolutionVersion): Promise<EvolutionVersion>;
  updateEvolutionVersionStatus(id: number, status: string): Promise<EvolutionVersion | undefined>;

  getGoldenSuite(): Promise<GoldenSuiteEntry[]>;
  createGoldenSuiteEntry(e: InsertGoldenSuite): Promise<GoldenSuiteEntry>;
  deleteGoldenSuiteEntry(id: number): Promise<void>;

  getEvolutionObservations(limit?: number): Promise<EvolutionObservation[]>;
  getUnconsolidatedObservations(limit?: number): Promise<EvolutionObservation[]>;
  createEvolutionObservation(o: InsertEvolutionObservation): Promise<EvolutionObservation>;
  markObservationConsolidated(id: number): Promise<void>;

  getJudgeCostsForDate(date: string): Promise<JudgeCost[]>;
  createJudgeCost(c: InsertJudgeCost): Promise<JudgeCost>;
  getJudgeCostSummary(): Promise<JudgeCost[]>;

  getGalaxyKbEntries(category?: string): Promise<GalaxyKbEntry[]>;
  getGalaxyKbEntry(id: number): Promise<GalaxyKbEntry | undefined>;
  getGalaxyKbByUrl(url: string): Promise<GalaxyKbEntry | undefined>;
  createGalaxyKbEntry(e: InsertGalaxyKb): Promise<GalaxyKbEntry>;
  updateGalaxyKbEntry(id: number, data: Partial<InsertGalaxyKb>): Promise<GalaxyKbEntry | undefined>;
  deleteGalaxyKbEntry(id: number): Promise<void>;
  searchGalaxyKb(query: string, limit?: number): Promise<GalaxyKbEntry[]>;
  getLinkedMemories(kbId: number): Promise<AgentMemory[]>;
  verifyGalaxyKbEntry(id: number, verifiedBy: string): Promise<GalaxyKbEntry | undefined>;
  flagGalaxyKbEntry(id: number, reason: string): Promise<GalaxyKbEntry | undefined>;
  incrementGalaxyKbAccess(id: number): Promise<void>;
  getGalaxyKbStats(): Promise<{ total: number; verified: number; flagged: number; categories: string[] }>;
}

export class DatabaseStorage implements IStorage {
  async getPrograms(): Promise<Program[]> {
    return db.select().from(programs).orderBy(programs.name);
  }
  async getProgram(id: number): Promise<Program | undefined> {
    const [p] = await db.select().from(programs).where(eq(programs.id, id));
    return p;
  }
  async getProgramByName(name: string): Promise<Program | undefined> {
    const [p] = await db.select().from(programs).where(eq(programs.name, name));
    return p;
  }
  async createProgram(p: InsertProgram): Promise<Program> {
    const [created] = await db.insert(programs).values(p).returning();
    return created;
  }
  async updateProgram(id: number, data: Partial<InsertProgram>): Promise<Program | undefined> {
    const [updated] = await db.update(programs).set(data).where(eq(programs.id, id)).returning();
    return updated;
  }
  async deleteProgram(id: number): Promise<void> {
    await db.delete(programs).where(eq(programs.id, id));
  }
  async toggleProgramEnabled(id: number): Promise<Program | undefined> {
    const p = await this.getProgram(id);
    if (!p) return undefined;
    const [updated] = await db.update(programs).set({ enabled: !p.enabled }).where(eq(programs.id, id)).returning();
    return updated;
  }
  async updateProgramLastRun(id: number, lastRun: Date, nextRun: Date | null): Promise<void> {
    await db.update(programs).set({ lastRun, nextRun }).where(eq(programs.id, id));
  }

  async getSkills(): Promise<Skill[]> {
    return db.select().from(skills).orderBy(skills.name);
  }
  async getSkill(id: number): Promise<Skill | undefined> {
    const [s] = await db.select().from(skills).where(eq(skills.id, id));
    return s;
  }
  async createSkill(s: InsertSkill): Promise<Skill> {
    const [created] = await db.insert(skills).values(s).returning();
    return created;
  }
  async updateSkill(id: number, data: Partial<InsertSkill>): Promise<Skill | undefined> {
    const [updated] = await db.update(skills).set(data).where(eq(skills.id, id)).returning();
    return updated;
  }
  async deleteSkill(id: number): Promise<void> {
    await db.delete(skills).where(eq(skills.id, id));
  }

  async getAgentConfigs(): Promise<AgentConfig[]> {
    return db.select().from(agentConfig).orderBy(agentConfig.category, agentConfig.key);
  }
  async getAgentConfig(key: string): Promise<AgentConfig | undefined> {
    const [c] = await db.select().from(agentConfig).where(eq(agentConfig.key, key));
    return c;
  }
  async setAgentConfig(key: string, value: string, category?: string): Promise<AgentConfig> {
    const existing = await this.getAgentConfig(key);
    if (existing) {
      const [updated] = await db.update(agentConfig).set({ value, ...(category ? { category } : {}) }).where(eq(agentConfig.key, key)).returning();
      return updated;
    }
    const [created] = await db.insert(agentConfig).values({ key, value, category: category || "general" }).returning();
    return created;
  }
  async deleteAgentConfig(key: string): Promise<void> {
    await db.delete(agentConfig).where(eq(agentConfig.key, key));
  }

  async getTasks(status?: string): Promise<Task[]> {
    if (status) {
      return db.select().from(tasks).where(eq(tasks.status, status)).orderBy(tasks.scheduledDate, tasks.createdAt);
    }
    return db.select().from(tasks).orderBy(tasks.scheduledDate, tasks.createdAt);
  }
  async getTask(id: number): Promise<Task | undefined> {
    const [t] = await db.select().from(tasks).where(eq(tasks.id, id));
    return t;
  }
  async createTask(t: InsertTask): Promise<Task> {
    const [created] = await db.insert(tasks).values(t).returning();
    return created;
  }
  async updateTask(id: number, data: Partial<InsertTask>): Promise<Task | undefined> {
    const [updated] = await db.update(tasks).set(data).where(eq(tasks.id, id)).returning();
    return updated;
  }
  async deleteTask(id: number): Promise<void> {
    await db.delete(tasks).where(eq(tasks.id, id));
  }
  async getTasksByDate(date: string): Promise<Task[]> {
    return db.select().from(tasks).where(eq(tasks.scheduledDate, date)).orderBy(tasks.createdAt);
  }
  async getOverdueTasks(today: string): Promise<Task[]> {
    return db.select().from(tasks).where(
      and(eq(tasks.status, "TODO"), sql`${tasks.scheduledDate} < ${today}`, sql`${tasks.scheduledDate} IS NOT NULL`)
    ).orderBy(tasks.scheduledDate);
  }
  async getUpcomingTasks(today: string, limit = 14): Promise<Task[]> {
    return db.select().from(tasks).where(
      and(sql`${tasks.scheduledDate} > ${today}`, sql`${tasks.scheduledDate} IS NOT NULL`)
    ).orderBy(tasks.scheduledDate).limit(limit * 5);
  }

  async getNotes(): Promise<Note[]> {
    return db.select().from(notes).orderBy(desc(notes.createdAt));
  }
  async getNote(id: number): Promise<Note | undefined> {
    const [n] = await db.select().from(notes).where(eq(notes.id, id));
    return n;
  }
  async createNote(n: InsertNote): Promise<Note> {
    const [created] = await db.insert(notes).values(n).returning();
    return created;
  }
  async updateNote(id: number, data: Partial<InsertNote>): Promise<Note | undefined> {
    const [updated] = await db.update(notes).set(data).where(eq(notes.id, id)).returning();
    return updated;
  }
  async deleteNote(id: number): Promise<void> {
    await db.delete(notes).where(eq(notes.id, id));
  }

  async getCaptures(processed?: boolean): Promise<Capture[]> {
    if (processed !== undefined) {
      return db.select().from(captures).where(eq(captures.processed, processed)).orderBy(desc(captures.createdAt));
    }
    return db.select().from(captures).orderBy(desc(captures.createdAt));
  }
  async getCapture(id: number): Promise<Capture | undefined> {
    const [c] = await db.select().from(captures).where(eq(captures.id, id));
    return c;
  }
  async createCapture(c: InsertCapture): Promise<Capture> {
    const [created] = await db.insert(captures).values(c).returning();
    return created;
  }
  async updateCapture(id: number, data: Partial<InsertCapture>): Promise<Capture | undefined> {
    const [updated] = await db.update(captures).set(data).where(eq(captures.id, id)).returning();
    return updated;
  }
  async markCaptureProcessed(id: number): Promise<void> {
    await db.update(captures).set({ processed: true }).where(eq(captures.id, id));
  }
  async deleteCapture(id: number): Promise<void> {
    await db.delete(captures).where(eq(captures.id, id));
  }

  async getAgentResults(programName?: string, limit = 50): Promise<AgentResult[]> {
    if (programName) {
      return db.select().from(agentResults).where(eq(agentResults.programName, programName)).orderBy(desc(agentResults.createdAt)).limit(limit);
    }
    return db.select().from(agentResults).orderBy(desc(agentResults.createdAt)).limit(limit);
  }
  async getAgentResult(id: number): Promise<AgentResult | undefined> {
    const [r] = await db.select().from(agentResults).where(eq(agentResults.id, id));
    return r;
  }
  async createAgentResult(r: InsertAgentResult): Promise<AgentResult> {
    const [created] = await db.insert(agentResults).values(r).returning();
    return created;
  }
  async getLatestResults(limit = 10): Promise<AgentResult[]> {
    return db.select().from(agentResults).orderBy(desc(agentResults.createdAt)).limit(limit);
  }

  async getReaderPages(): Promise<ReaderPage[]> {
    return db.select().from(readerPages).orderBy(desc(readerPages.scrapedAt));
  }
  async getReaderPage(id: number): Promise<ReaderPage | undefined> {
    const [p] = await db.select().from(readerPages).where(eq(readerPages.id, id));
    return p;
  }
  async createReaderPage(p: InsertReaderPage): Promise<ReaderPage> {
    const [created] = await db.insert(readerPages).values(p).returning();
    return created;
  }
  async deleteReaderPage(id: number): Promise<void> {
    await db.delete(readerPages).where(eq(readerPages.id, id));
  }

  async createProposal(proposal: InsertOpenclawProposal): Promise<OpenclawProposal> {
    const [created] = await db.insert(openclawProposals).values(proposal).returning();
    return created;
  }
  async getProposals(status?: string): Promise<OpenclawProposal[]> {
    if (status) {
      return db.select().from(openclawProposals).where(eq(openclawProposals.status, status)).orderBy(desc(openclawProposals.createdAt));
    }
    return db.select().from(openclawProposals).orderBy(desc(openclawProposals.createdAt));
  }
  async getProposal(id: number): Promise<OpenclawProposal | undefined> {
    const [p] = await db.select().from(openclawProposals).where(eq(openclawProposals.id, id));
    return p;
  }
  async updateProposalStatus(id: number, status: string, resolvedAt: Date): Promise<OpenclawProposal | undefined> {
    const [updated] = await db.update(openclawProposals).set({ status, resolvedAt }).where(eq(openclawProposals.id, id)).returning();
    return updated;
  }

  async getSiteProfiles(): Promise<SiteProfile[]> {
    return db.select().from(siteProfiles).orderBy(siteProfiles.name);
  }
  async getSiteProfile(id: number): Promise<SiteProfile | undefined> {
    const [p] = await db.select().from(siteProfiles).where(eq(siteProfiles.id, id));
    return p;
  }
  async getSiteProfileByName(name: string): Promise<SiteProfile | undefined> {
    const [p] = await db.select().from(siteProfiles).where(eq(siteProfiles.name, name));
    return p;
  }
  async createSiteProfile(p: InsertSiteProfile): Promise<SiteProfile> {
    const [created] = await db.insert(siteProfiles).values(p).returning();
    return created;
  }
  async updateSiteProfile(id: number, data: Partial<InsertSiteProfile>): Promise<SiteProfile | undefined> {
    const [updated] = await db.update(siteProfiles).set(data).where(eq(siteProfiles.id, id)).returning();
    return updated;
  }
  async deleteSiteProfile(id: number): Promise<void> {
    await db.delete(navigationPaths).where(eq(navigationPaths.siteProfileId, id));
    await db.delete(siteProfiles).where(eq(siteProfiles.id, id));
  }

  async getNavigationPaths(siteProfileId?: number): Promise<NavigationPath[]> {
    if (siteProfileId !== undefined) {
      return db.select().from(navigationPaths).where(eq(navigationPaths.siteProfileId, siteProfileId)).orderBy(navigationPaths.name);
    }
    return db.select().from(navigationPaths).orderBy(navigationPaths.name);
  }
  async getNavigationPath(id: number): Promise<NavigationPath | undefined> {
    const [p] = await db.select().from(navigationPaths).where(eq(navigationPaths.id, id));
    return p;
  }
  async createNavigationPath(p: InsertNavigationPath): Promise<NavigationPath> {
    const [created] = await db.insert(navigationPaths).values(p).returning();
    return created;
  }
  async updateNavigationPath(id: number, data: Partial<InsertNavigationPath>): Promise<NavigationPath | undefined> {
    const [updated] = await db.update(navigationPaths).set(data).where(eq(navigationPaths.id, id)).returning();
    return updated;
  }
  async deleteNavigationPath(id: number): Promise<void> {
    await db.delete(navigationPaths).where(eq(navigationPaths.id, id));
  }

  async createAuditLog(entry: InsertAuditLog): Promise<AuditLog> {
    const [created] = await db.insert(auditLog).values(entry).returning();
    return created;
  }
  async getAuditLogs(limit = 100): Promise<AuditLog[]> {
    return db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit);
  }
  async getAuditLogsByActor(actor: string, limit = 100): Promise<AuditLog[]> {
    return db.select().from(auditLog).where(eq(auditLog.actor, actor)).orderBy(desc(auditLog.createdAt)).limit(limit);
  }

  async getActionPermissions(): Promise<ActionPermission[]> {
    return db.select().from(actionPermissions);
  }

  async getActionPermission(navPathId: number, actionName: string): Promise<ActionPermission | undefined> {
    const [result] = await db.select().from(actionPermissions)
      .where(and(eq(actionPermissions.navPathId, navPathId), eq(actionPermissions.actionName, actionName)));
    return result;
  }

  async setActionPermission(navPathId: number, actionName: string, level: string): Promise<ActionPermission> {
    const existing = await this.getActionPermission(navPathId, actionName);
    if (existing) {
      const [updated] = await db.update(actionPermissions)
        .set({ permissionLevel: level })
        .where(eq(actionPermissions.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(actionPermissions)
      .values({ navPathId, actionName, permissionLevel: level })
      .returning();
    return created;
  }

  async deleteActionPermission(id: number): Promise<void> {
    await db.delete(actionPermissions).where(eq(actionPermissions.id, id));
  }

  async getRecipes(): Promise<Recipe[]> {
    return db.select().from(recipes).orderBy(recipes.name);
  }
  async getRecipe(id: number): Promise<Recipe | undefined> {
    const [r] = await db.select().from(recipes).where(eq(recipes.id, id));
    return r;
  }
  async getRecipeByName(name: string): Promise<Recipe | undefined> {
    const [r] = await db.select().from(recipes).where(eq(recipes.name, name));
    return r;
  }
  async createRecipe(r: InsertRecipe): Promise<Recipe> {
    const [created] = await db.insert(recipes).values(r).returning();
    return created;
  }
  async updateRecipe(id: number, data: Partial<InsertRecipe>): Promise<Recipe | undefined> {
    const [updated] = await db.update(recipes).set(data).where(eq(recipes.id, id)).returning();
    return updated;
  }
  async deleteRecipe(id: number): Promise<void> {
    await db.delete(recipes).where(eq(recipes.id, id));
  }
  async updateRecipeLastRun(id: number, lastRun: Date, nextRun: Date | null, output: string): Promise<void> {
    await db.update(recipes).set({
      lastRun,
      nextRun,
      lastOutput: output.slice(0, 10000),
      runCount: sql`${recipes.runCount} + 1`,
    }).where(eq(recipes.id, id));
  }
  async toggleRecipeEnabled(id: number): Promise<Recipe | undefined> {
    const existing = await this.getRecipe(id);
    if (!existing) return undefined;
    const [updated] = await db.update(recipes).set({ enabled: !existing.enabled }).where(eq(recipes.id, id)).returning();
    return updated;
  }

  async getTranscripts(): Promise<Transcript[]> {
    return db.select().from(transcripts).orderBy(desc(transcripts.createdAt));
  }
  async getTranscript(id: number): Promise<Transcript | undefined> {
    const [t] = await db.select().from(transcripts).where(eq(transcripts.id, id));
    return t;
  }
  async createTranscript(t: InsertTranscript): Promise<Transcript> {
    const [created] = await db.insert(transcripts).values(t).returning();
    return created;
  }
  async updateTranscript(id: number, data: Partial<InsertTranscript>): Promise<Transcript | undefined> {
    const [updated] = await db.update(transcripts).set(data).where(eq(transcripts.id, id)).returning();
    return updated;
  }
  async deleteTranscript(id: number): Promise<void> {
    await db.delete(transcripts).where(eq(transcripts.id, id));
  }

  async searchAll(query: string): Promise<Array<{ type: string; id: number; title: string; snippet: string }>> {
    const q = `%${query}%`;
    const results: Array<{ type: string; id: number; title: string; snippet: string }> = [];

    const matchedTasks = await db.select().from(tasks).where(
      or(ilike(tasks.title, q), ilike(tasks.body, q))
    ).limit(10);
    for (const t of matchedTasks) {
      results.push({ type: "task", id: t.id, title: t.title, snippet: t.body.slice(0, 100) });
    }

    const matchedNotes = await db.select().from(notes).where(
      or(ilike(notes.title, q), ilike(notes.body, q))
    ).limit(10);
    for (const n of matchedNotes) {
      results.push({ type: "note", id: n.id, title: n.title, snippet: n.body.slice(0, 100) });
    }

    const matchedPrograms = await db.select().from(programs).where(
      or(ilike(programs.name, q), ilike(programs.instructions, q))
    ).limit(10);
    for (const p of matchedPrograms) {
      results.push({ type: "program", id: p.id, title: p.name, snippet: p.instructions.slice(0, 100) });
    }

    const matchedSkills = await db.select().from(skills).where(
      or(ilike(skills.name, q), ilike(skills.description, q))
    ).limit(10);
    for (const s of matchedSkills) {
      results.push({ type: "skill", id: s.id, title: s.name, snippet: s.description.slice(0, 100) });
    }

    const matchedCaptures = await db.select().from(captures).where(
      ilike(captures.content, q)
    ).limit(10);
    for (const c of matchedCaptures) {
      results.push({ type: "capture", id: c.id, title: c.content.slice(0, 60), snippet: c.content.slice(0, 100) });
    }

    const matchedResults = await db.select().from(agentResults).where(
      or(ilike(agentResults.programName, q), ilike(agentResults.summary, q))
    ).limit(10);
    for (const r of matchedResults) {
      results.push({ type: "result", id: r.id, title: `${r.programName}: ${r.summary.slice(0, 40)}`, snippet: r.summary.slice(0, 100) });
    }

    const matchedPages = await db.select().from(readerPages).where(
      or(ilike(readerPages.title, q), ilike(readerPages.url, q), ilike(readerPages.domain, q))
    ).limit(10);
    for (const p of matchedPages) {
      results.push({ type: "reader_page", id: p.id, title: p.title || p.url, snippet: p.domain || p.url });
    }

    const matchedTranscripts = await db.select().from(transcripts).where(
      or(ilike(transcripts.title, q), ilike(transcripts.rawText, q), ilike(transcripts.platform, q))
    ).limit(10);
    for (const t of matchedTranscripts) {
      results.push({ type: "transcript", id: t.id, title: t.title || `${t.platform} recording`, snippet: t.rawText.slice(0, 100) });
    }

    return results;
  }

  async getRadarSeenHashes(since: Date): Promise<string[]> {
    const rows = await db.select({ contentHash: radarSeenItems.contentHash })
      .from(radarSeenItems)
      .where(gte(radarSeenItems.createdAt, since));
    return rows.map(r => r.contentHash);
  }

  async createRadarSeenItems(items: InsertRadarSeenItem[]): Promise<void> {
    if (items.length === 0) return;
    await db.insert(radarSeenItems).values(items);
  }

  async cleanOldRadarSeenItems(before: Date): Promise<void> {
    await db.delete(radarSeenItems).where(lte(radarSeenItems.createdAt, before));
  }

  async getRadarEngagement(since: Date): Promise<RadarEngagement[]> {
    return db.select().from(radarEngagement)
      .where(gte(radarEngagement.createdAt, since))
      .orderBy(desc(radarEngagement.createdAt));
  }

  async createRadarEngagement(e: InsertRadarEngagement): Promise<RadarEngagement> {
    const [created] = await db.insert(radarEngagement).values(e).returning();
    return created;
  }

  async updateProgramConfig(id: number, config: Record<string, string>): Promise<Program | undefined> {
    const [updated] = await db.update(programs).set({ config }).where(eq(programs.id, id)).returning();
    return updated;
  }

  async getMealPlans(): Promise<MealPlan[]> {
    return db.select().from(mealPlans).orderBy(desc(mealPlans.createdAt));
  }
  async getMealPlan(id: number): Promise<MealPlan | undefined> {
    const [p] = await db.select().from(mealPlans).where(eq(mealPlans.id, id));
    return p;
  }
  async createMealPlan(p: InsertMealPlan): Promise<MealPlan> {
    const [created] = await db.insert(mealPlans).values(p).returning();
    return created;
  }
  async updateMealPlan(id: number, data: Partial<InsertMealPlan>): Promise<MealPlan | undefined> {
    const [updated] = await db.update(mealPlans).set(data).where(eq(mealPlans.id, id)).returning();
    return updated;
  }
  async deleteMealPlan(id: number): Promise<void> {
    await db.delete(mealPlans).where(eq(mealPlans.id, id));
  }
  async getActiveMealPlan(): Promise<MealPlan | undefined> {
    const [p] = await db.select().from(mealPlans).where(eq(mealPlans.status, "active")).orderBy(desc(mealPlans.createdAt)).limit(1);
    return p;
  }

  async getShoppingLists(): Promise<ShoppingList[]> {
    return db.select().from(shoppingLists).orderBy(desc(shoppingLists.createdAt));
  }
  async getShoppingList(id: number): Promise<ShoppingList | undefined> {
    const [s] = await db.select().from(shoppingLists).where(eq(shoppingLists.id, id));
    return s;
  }
  async createShoppingList(s: InsertShoppingList): Promise<ShoppingList> {
    const [created] = await db.insert(shoppingLists).values(s).returning();
    return created;
  }
  async updateShoppingList(id: number, data: Partial<InsertShoppingList>): Promise<ShoppingList | undefined> {
    const [updated] = await db.update(shoppingLists).set(data).where(eq(shoppingLists.id, id)).returning();
    return updated;
  }
  async deleteShoppingList(id: number): Promise<void> {
    await db.delete(shoppingLists).where(eq(shoppingLists.id, id));
  }

  async getPantryItems(status?: string): Promise<PantryItem[]> {
    if (status) {
      return db.select().from(pantryItems).where(eq(pantryItems.status, status)).orderBy(pantryItems.name);
    }
    return db.select().from(pantryItems).orderBy(pantryItems.name);
  }
  async getPantryItem(id: number): Promise<PantryItem | undefined> {
    const [p] = await db.select().from(pantryItems).where(eq(pantryItems.id, id));
    return p;
  }
  async getPantryItemByName(name: string): Promise<PantryItem | undefined> {
    const [p] = await db.select().from(pantryItems).where(eq(pantryItems.name, name));
    return p;
  }
  async createPantryItem(p: InsertPantryItem): Promise<PantryItem> {
    const [created] = await db.insert(pantryItems).values(p).returning();
    return created;
  }
  async updatePantryItem(id: number, data: Partial<InsertPantryItem>): Promise<PantryItem | undefined> {
    const [updated] = await db.update(pantryItems).set(data).where(eq(pantryItems.id, id)).returning();
    return updated;
  }
  async deletePantryItem(id: number): Promise<void> {
    await db.delete(pantryItems).where(eq(pantryItems.id, id));
  }

  async getKiddoFoodLogs(): Promise<KiddoFoodLog[]> {
    return db.select().from(kiddoFoodLog).orderBy(desc(kiddoFoodLog.logDate));
  }
  async createKiddoFoodLog(l: InsertKiddoFoodLog): Promise<KiddoFoodLog> {
    const [created] = await db.insert(kiddoFoodLog).values(l).returning();
    return created;
  }

  async getNightlyRecommendations(limit = 20): Promise<NightlyRecommendation[]> {
    return db.select().from(nightlyRecommendations).orderBy(desc(nightlyRecommendations.createdAt)).limit(limit);
  }
  async getNightlyRecommendation(id: number): Promise<NightlyRecommendation | undefined> {
    const [r] = await db.select().from(nightlyRecommendations).where(eq(nightlyRecommendations.id, id));
    return r;
  }
  async getNightlyRecommendationByDate(date: string): Promise<NightlyRecommendation | undefined> {
    const [r] = await db.select().from(nightlyRecommendations).where(eq(nightlyRecommendations.recDate, date)).orderBy(desc(nightlyRecommendations.createdAt)).limit(1);
    return r;
  }
  async createNightlyRecommendation(r: InsertNightlyRecommendation): Promise<NightlyRecommendation> {
    const [created] = await db.insert(nightlyRecommendations).values(r).returning();
    return created;
  }
  async updateNightlyRecommendationStatus(id: number, status: string): Promise<NightlyRecommendation | undefined> {
    const [updated] = await db.update(nightlyRecommendations).set({ status }).where(eq(nightlyRecommendations.id, id)).returning();
    return updated;
  }
  async createMemory(m: InsertAgentMemory): Promise<AgentMemory> {
    const [created] = await db.insert(agentMemories).values(m).returning();
    return created;
  }

  async getMemoriesForProgram(programName: string | null, options: { tags?: string[]; type?: string; limit?: number; minRelevance?: number } = {}): Promise<AgentMemory[]> {
    const conditions = [];
    if (programName) {
      conditions.push(or(eq(agentMemories.programName, programName), sql`${agentMemories.programName} IS NULL`));
    } else {
      conditions.push(sql`${agentMemories.programName} IS NULL`);
    }
    if (options.type) {
      conditions.push(eq(agentMemories.memoryType, options.type));
    }
    if (options.minRelevance !== undefined) {
      conditions.push(gte(agentMemories.relevanceScore, options.minRelevance));
    }
    if (options.tags && options.tags.length > 0) {
      conditions.push(sql`${agentMemories.tags} && ${options.tags}`);
    }
    const limit = options.limit || 50;
    return db.select().from(agentMemories)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(agentMemories.relevanceScore), desc(agentMemories.lastAccessed))
      .limit(limit);
  }

  async updateMemoryRelevance(id: number, relevanceScore: number): Promise<void> {
    await db.update(agentMemories).set({ relevanceScore }).where(eq(agentMemories.id, id));
  }

  async updateMemoryAccess(id: number): Promise<void> {
    await db.update(agentMemories).set({
      accessCount: sql`${agentMemories.accessCount} + 1`,
      lastAccessed: new Date(),
    }).where(eq(agentMemories.id, id));
  }

  async deleteMemory(id: number): Promise<void> {
    await db.delete(agentMemories).where(eq(agentMemories.id, id));
  }

  async searchMemories(query: string, limit = 20, programName?: string): Promise<AgentMemory[]> {
    const q = `%${query}%`;
    const contentMatch = or(ilike(agentMemories.content, q), sql`EXISTS (SELECT 1 FROM unnest(${agentMemories.tags}) AS t WHERE t ILIKE ${q})`);
    const scopeFilter = programName
      ? and(contentMatch, or(eq(agentMemories.programName, programName), sql`${agentMemories.programName} IS NULL`))
      : contentMatch;
    return db.select().from(agentMemories)
      .where(scopeFilter)
      .orderBy(desc(agentMemories.relevanceScore), desc(agentMemories.lastAccessed))
      .limit(limit);
  }

  async getAllMemories(limit = 100): Promise<AgentMemory[]> {
    return db.select().from(agentMemories)
      .orderBy(desc(agentMemories.createdAt))
      .limit(limit);
  }

  async consolidateOldMemories(beforeDate: Date, decayAmount = 10): Promise<number> {
    const result = await db.update(agentMemories)
      .set({ relevanceScore: sql`GREATEST(0, ${agentMemories.relevanceScore} - ${decayAmount})` })
      .where(and(lte(agentMemories.lastAccessed, beforeDate), gte(agentMemories.relevanceScore, 1)))
      .returning();
    return result.length;
  }

  async updateMemoryQdrantId(id: number, qdrantId: string): Promise<void> {
    await db.update(agentMemories).set({ qdrantId }).where(eq(agentMemories.id, id));
  }

  async searchMemoriesBySubject(subject: string, programName: string | null): Promise<AgentMemory[]> {
    const conditions = [eq(agentMemories.subject, subject)];
    if (programName) {
      conditions.push(or(eq(agentMemories.programName, programName), sql`${agentMemories.programName} IS NULL`)!);
    }
    conditions.push(or(sql`${agentMemories.validUntil} IS NULL`, gte(agentMemories.validUntil, new Date()))!);
    return db.select().from(agentMemories)
      .where(and(...conditions))
      .orderBy(desc(agentMemories.createdAt));
  }

  async expireMemory(id: number, validUntil: Date): Promise<void> {
    await db.update(agentMemories).set({ validUntil }).where(eq(agentMemories.id, id));
  }

  async getMemoriesByIds(ids: number[]): Promise<AgentMemory[]> {
    if (ids.length === 0) return [];
    return db.select().from(agentMemories)
      .where(sql`${agentMemories.id} = ANY(${ids})`);
  }

  async getEvolutionVersions(limit = 20): Promise<EvolutionVersion[]> {
    return db.select().from(evolutionVersions)
      .orderBy(desc(evolutionVersions.version))
      .limit(limit);
  }

  async getEvolutionVersion(id: number): Promise<EvolutionVersion | undefined> {
    const [v] = await db.select().from(evolutionVersions).where(eq(evolutionVersions.id, id));
    return v;
  }

  async getLatestEvolutionVersion(): Promise<EvolutionVersion | undefined> {
    const [v] = await db.select().from(evolutionVersions)
      .where(eq(evolutionVersions.status, "active"))
      .orderBy(desc(evolutionVersions.version))
      .limit(1);
    return v;
  }

  async createEvolutionVersion(v: InsertEvolutionVersion): Promise<EvolutionVersion> {
    const [created] = await db.insert(evolutionVersions).values(v).returning();
    return created;
  }

  async updateEvolutionVersionStatus(id: number, status: string): Promise<EvolutionVersion | undefined> {
    const setData: Record<string, unknown> = { status };
    if (status === "rolled_back") {
      setData.rolledBackAt = new Date();
    }
    const [updated] = await db.update(evolutionVersions).set(setData).where(eq(evolutionVersions.id, id)).returning();
    return updated;
  }

  async getGoldenSuite(): Promise<GoldenSuiteEntry[]> {
    return db.select().from(goldenSuite).orderBy(desc(goldenSuite.createdAt));
  }

  async createGoldenSuiteEntry(e: InsertGoldenSuite): Promise<GoldenSuiteEntry> {
    const [created] = await db.insert(goldenSuite).values(e).returning();
    return created;
  }

  async deleteGoldenSuiteEntry(id: number): Promise<void> {
    await db.delete(goldenSuite).where(eq(goldenSuite.id, id));
  }

  async getEvolutionObservations(limit = 50): Promise<EvolutionObservation[]> {
    return db.select().from(evolutionObservations)
      .orderBy(desc(evolutionObservations.createdAt))
      .limit(limit);
  }

  async getUnconsolidatedObservations(limit = 50): Promise<EvolutionObservation[]> {
    return db.select().from(evolutionObservations)
      .where(eq(evolutionObservations.consolidated, false))
      .orderBy(asc(evolutionObservations.createdAt))
      .limit(limit);
  }

  async createEvolutionObservation(o: InsertEvolutionObservation): Promise<EvolutionObservation> {
    const [created] = await db.insert(evolutionObservations).values(o).returning();
    return created;
  }

  async markObservationConsolidated(id: number): Promise<void> {
    await db.update(evolutionObservations).set({ consolidated: true }).where(eq(evolutionObservations.id, id));
  }

  async getJudgeCostsForDate(date: string): Promise<JudgeCost[]> {
    return db.select().from(judgeCostTracking)
      .where(eq(judgeCostTracking.date, date));
  }

  async createJudgeCost(c: InsertJudgeCost): Promise<JudgeCost> {
    const [created] = await db.insert(judgeCostTracking).values(c).returning();
    return created;
  }

  async getJudgeCostSummary(): Promise<JudgeCost[]> {
    return db.select().from(judgeCostTracking)
      .orderBy(desc(judgeCostTracking.createdAt))
      .limit(100);
  }

  async getGalaxyKbEntries(category?: string): Promise<GalaxyKbEntry[]> {
    if (category) {
      return db.select().from(galaxyKb).where(eq(galaxyKb.category, category)).orderBy(desc(galaxyKb.createdAt));
    }
    return db.select().from(galaxyKb).orderBy(desc(galaxyKb.createdAt));
  }

  async getGalaxyKbEntry(id: number): Promise<GalaxyKbEntry | undefined> {
    const [e] = await db.select().from(galaxyKb).where(eq(galaxyKb.id, id));
    return e;
  }

  async getGalaxyKbByUrl(url: string): Promise<GalaxyKbEntry | undefined> {
    const [e] = await db.select().from(galaxyKb).where(eq(galaxyKb.url, url));
    return e;
  }

  async createGalaxyKbEntry(e: InsertGalaxyKb): Promise<GalaxyKbEntry> {
    const [created] = await db.insert(galaxyKb).values(e).returning();
    return created;
  }

  async updateGalaxyKbEntry(id: number, data: Partial<InsertGalaxyKb>): Promise<GalaxyKbEntry | undefined> {
    const [updated] = await db.update(galaxyKb).set({ ...data, updatedAt: new Date() }).where(eq(galaxyKb.id, id)).returning();
    return updated;
  }

  async deleteGalaxyKbEntry(id: number): Promise<void> {
    await db.delete(galaxyKb).where(eq(galaxyKb.id, id));
  }

  async searchGalaxyKb(query: string, limit = 20): Promise<GalaxyKbEntry[]> {
    return db.select().from(galaxyKb).where(
      or(
        ilike(galaxyKb.title, `%${query}%`),
        ilike(galaxyKb.summary, `%${query}%`),
        ilike(galaxyKb.category, `%${query}%`),
        ilike(galaxyKb.fullText, `%${query}%`)
      )
    ).orderBy(desc(galaxyKb.createdAt)).limit(limit);
  }

  async getLinkedMemories(kbId: number): Promise<AgentMemory[]> {
    const memories = await db.select().from(agentMemories).where(eq(agentMemories.sourceKbId, kbId)).orderBy(desc(agentMemories.createdAt));
    if (memories.length > 0) {
      this.incrementGalaxyKbAccess(kbId).catch(() => {});
    }
    return memories;
  }

  async verifyGalaxyKbEntry(id: number, verifiedBy: string): Promise<GalaxyKbEntry | undefined> {
    const [updated] = await db.update(galaxyKb).set({
      verified: true,
      verifiedAt: new Date(),
      verifiedBy,
      flagged: false,
      flagReason: null,
      updatedAt: new Date(),
    }).where(eq(galaxyKb.id, id)).returning();
    if (updated) {
      await db.update(agentMemories).set({ relevanceScore: 95 }).where(
        and(eq(agentMemories.sourceKbId, id), sql`${agentMemories.relevanceScore} < 95`)
      );
    }
    return updated;
  }

  async flagGalaxyKbEntry(id: number, reason: string): Promise<GalaxyKbEntry | undefined> {
    const [updated] = await db.update(galaxyKb).set({
      flagged: true,
      flagReason: reason,
      updatedAt: new Date(),
    }).where(eq(galaxyKb.id, id)).returning();
    if (updated) {
      await db.update(agentMemories).set({ validUntil: new Date() }).where(
        eq(agentMemories.sourceKbId, id)
      );
    }
    return updated;
  }

  async incrementGalaxyKbAccess(id: number): Promise<void> {
    await db.update(galaxyKb).set({
      agentAccessCount: sql`${galaxyKb.agentAccessCount} + 1`,
    }).where(eq(galaxyKb.id, id));
  }

  async getGalaxyKbStats(): Promise<{ total: number; verified: number; flagged: number; categories: string[] }> {
    const all = await db.select().from(galaxyKb);
    const categories = [...new Set(all.map(e => e.category))].sort();
    return {
      total: all.length,
      verified: all.filter(e => e.verified).length,
      flagged: all.filter(e => e.flagged).length,
      categories,
    };
  }
}

export const storage = new DatabaseStorage();
