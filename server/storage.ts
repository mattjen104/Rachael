import {
  type OrgFile, type InsertOrgFile, orgFiles,
  type ClipboardItem, type InsertClipboardItem, clipboardItems,
  type AgendaItem, type InsertAgendaItem, agendaItems,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, lte, and, not } from "drizzle-orm";

export interface IStorage {
  getOrgFiles(): Promise<OrgFile[]>;
  getOrgFile(id: number): Promise<OrgFile | undefined>;
  getOrgFileByName(name: string): Promise<OrgFile | undefined>;
  createOrgFile(file: InsertOrgFile): Promise<OrgFile>;
  updateOrgFileContent(id: number, content: string): Promise<OrgFile | undefined>;

  getClipboardItems(): Promise<ClipboardItem[]>;
  getClipboardItem(id: number): Promise<ClipboardItem | undefined>;
  createClipboardItem(item: InsertClipboardItem): Promise<ClipboardItem>;
  updateClipboardItem(id: number, data: Partial<InsertClipboardItem>): Promise<ClipboardItem | undefined>;
  deleteClipboardItem(id: number): Promise<void>;
  archiveClipboardItem(id: number): Promise<void>;
  togglePinClipboardItem(id: number): Promise<ClipboardItem | undefined>;
  getArchivedClipboardItems(): Promise<ClipboardItem[]>;
  unarchiveClipboardItem(id: number): Promise<void>;

  getAgendaItems(): Promise<AgendaItem[]>;
  getAgendaItemsByDate(date: string): Promise<AgendaItem[]>;
  createAgendaItem(item: InsertAgendaItem): Promise<AgendaItem>;
  updateAgendaItemStatus(id: number, status: string): Promise<AgendaItem | undefined>;
  carryOverIncompleteTasks(today: string): Promise<AgendaItem[]>;
}

export class DatabaseStorage implements IStorage {
  async getOrgFiles(): Promise<OrgFile[]> {
    return db.select().from(orgFiles);
  }

  async getOrgFile(id: number): Promise<OrgFile | undefined> {
    const [file] = await db.select().from(orgFiles).where(eq(orgFiles.id, id));
    return file;
  }

  async getOrgFileByName(name: string): Promise<OrgFile | undefined> {
    const [file] = await db.select().from(orgFiles).where(eq(orgFiles.name, name));
    return file;
  }

  async createOrgFile(file: InsertOrgFile): Promise<OrgFile> {
    const [created] = await db.insert(orgFiles).values(file).returning();
    return created;
  }

  async updateOrgFileContent(id: number, content: string): Promise<OrgFile | undefined> {
    const [updated] = await db.update(orgFiles).set({ content }).where(eq(orgFiles.id, id)).returning();
    return updated;
  }

  async getClipboardItems(): Promise<ClipboardItem[]> {
    return db.select().from(clipboardItems).where(eq(clipboardItems.archived, false)).orderBy(desc(clipboardItems.pinned), desc(clipboardItems.capturedAt));
  }

  async getClipboardItem(id: number): Promise<ClipboardItem | undefined> {
    const [item] = await db.select().from(clipboardItems).where(eq(clipboardItems.id, id));
    return item;
  }

  async createClipboardItem(item: InsertClipboardItem): Promise<ClipboardItem> {
    const [created] = await db.insert(clipboardItems).values(item).returning();
    return created;
  }

  async updateClipboardItem(id: number, data: Partial<InsertClipboardItem>): Promise<ClipboardItem | undefined> {
    const [updated] = await db.update(clipboardItems).set(data).where(eq(clipboardItems.id, id)).returning();
    return updated;
  }

  async deleteClipboardItem(id: number): Promise<void> {
    await db.delete(clipboardItems).where(eq(clipboardItems.id, id));
  }

  async archiveClipboardItem(id: number): Promise<void> {
    await db.update(clipboardItems).set({ archived: true }).where(eq(clipboardItems.id, id));
  }

  async togglePinClipboardItem(id: number): Promise<ClipboardItem | undefined> {
    const item = await this.getClipboardItem(id);
    if (!item) return undefined;
    const [updated] = await db.update(clipboardItems).set({ pinned: !item.pinned }).where(eq(clipboardItems.id, id)).returning();
    return updated;
  }

  async getArchivedClipboardItems(): Promise<ClipboardItem[]> {
    return db.select().from(clipboardItems).where(eq(clipboardItems.archived, true)).orderBy(desc(clipboardItems.capturedAt));
  }

  async unarchiveClipboardItem(id: number): Promise<void> {
    await db.update(clipboardItems).set({ archived: false }).where(eq(clipboardItems.id, id));
  }

  async getAgendaItems(): Promise<AgendaItem[]> {
    return db.select().from(agendaItems).orderBy(agendaItems.scheduledDate);
  }

  async getAgendaItemsByDate(date: string): Promise<AgendaItem[]> {
    return db.select().from(agendaItems).where(eq(agendaItems.scheduledDate, date));
  }

  async createAgendaItem(item: InsertAgendaItem): Promise<AgendaItem> {
    const [created] = await db.insert(agendaItems).values(item).returning();
    return created;
  }

  async updateAgendaItemStatus(id: number, status: string): Promise<AgendaItem | undefined> {
    const [updated] = await db.update(agendaItems).set({ status }).where(eq(agendaItems.id, id)).returning();
    return updated;
  }

  async carryOverIncompleteTasks(today: string): Promise<AgendaItem[]> {
    const incomplete = await db
      .select()
      .from(agendaItems)
      .where(
        and(
          eq(agendaItems.status, "TODO"),
          not(eq(agendaItems.scheduledDate, today))
        )
      );

    const carried: AgendaItem[] = [];
    for (const task of incomplete) {
      const [updated] = await db
        .update(agendaItems)
        .set({ scheduledDate: today, carriedOver: true })
        .where(eq(agendaItems.id, task.id))
        .returning();
      carried.push(updated);
    }
    return carried;
  }
}

export const storage = new DatabaseStorage();
