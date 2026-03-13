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
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, or, lte, gte, ilike, sql } from "drizzle-orm";

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

  searchAll(query: string): Promise<Array<{ type: string; id: number; title: string; snippet: string }>>;
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

    return results;
  }
}

export const storage = new DatabaseStorage();
