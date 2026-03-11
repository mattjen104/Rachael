import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const orgFiles = pgTable("org_files", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull().unique(),
  content: text("content").notNull().default(""),
});

export const insertOrgFileSchema = createInsertSchema(orgFiles).omit({ id: true });
export type InsertOrgFile = z.infer<typeof insertOrgFileSchema>;
export type OrgFile = typeof orgFiles.$inferSelect;

export const clipboardItems = pgTable("clipboard_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  content: text("content").notNull(),
  type: text("type").notNull().default("text"),
  capturedAt: timestamp("captured_at").notNull().defaultNow(),
  archived: boolean("archived").notNull().default(false),
  detectedType: text("detected_type"),
  urlTitle: text("url_title"),
  urlDescription: text("url_description"),
  urlImage: text("url_image"),
  urlDomain: text("url_domain"),
  pinned: boolean("pinned").notNull().default(false),
});

export const insertClipboardItemSchema = createInsertSchema(clipboardItems).omit({ id: true, capturedAt: true, archived: true });
export type InsertClipboardItem = z.infer<typeof insertClipboardItemSchema>;
export type ClipboardItem = typeof clipboardItems.$inferSelect;

export const agendaItems = pgTable("agenda_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  text: text("text").notNull(),
  status: text("status").notNull().default("TODO"),
  scheduledDate: text("scheduled_date").notNull(),
  orgFileId: integer("org_file_id"),
  carriedOver: boolean("carried_over").notNull().default(false),
});

export const insertAgendaItemSchema = createInsertSchema(agendaItems).omit({ id: true, carriedOver: true });
export type InsertAgendaItem = z.infer<typeof insertAgendaItemSchema>;
export type AgendaItem = typeof agendaItems.$inferSelect;

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

export const insertOpenclawProposalSchema = createInsertSchema(openclawProposals).omit({ id: true, status: true, createdAt: true, resolvedAt: true });
export type InsertOpenclawProposal = z.infer<typeof insertOpenclawProposalSchema>;
export type OpenclawProposal = typeof openclawProposals.$inferSelect;

export const openclawVersions = pgTable("openclaw_versions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgContent: text("org_content").notNull(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertOpenclawVersionSchema = createInsertSchema(openclawVersions).omit({ id: true, createdAt: true });
export type InsertOpenclawVersion = z.infer<typeof insertOpenclawVersionSchema>;
export type OpenclawVersion = typeof openclawVersions.$inferSelect;
