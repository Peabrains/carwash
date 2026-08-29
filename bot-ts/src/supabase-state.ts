import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Lock, QueueEntry, StateAdapter } from "chat";

type Row = { key: string; kind: string; value: unknown; expires_at: number | null };

function db(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for bot state");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function id(value: string) { return createHash("sha256").update(value).digest("hex"); }
function fresh(row?: Row | null) { return row !== null && row !== undefined && (!row.expires_at || row.expires_at > Date.now()); }

export class SupabaseStateAdapter implements StateAdapter {
  private client = db();
  private connected = false;
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  private ready() { if (!this.connected) throw new Error("SupabaseStateAdapter is not connected"); }
  private async read(kind: string, key: string) { const { data, error } = await this.client.from("chat_state").select("*").eq("key", id(`${kind}:${key}`)).maybeSingle(); if (error) throw error; if (!data) return null; const row = data as Row; return fresh(row) ? row : null; }
  private async write(kind: string, key: string, value: unknown, ttlMs?: number) { const { error } = await this.client.from("chat_state").upsert({ key: id(`${kind}:${key}`), kind, value, expires_at: ttlMs ? Date.now() + ttlMs : null }, { onConflict: "key" }); if (error) throw error; }
  async subscribe(threadId: string) { this.ready(); await this.write("subscription", threadId, true); }
  async unsubscribe(threadId: string) { this.ready(); await this.client.from("chat_state").delete().eq("key", id(`subscription:${threadId}`)); }
  async isSubscribed(threadId: string) { this.ready(); return Boolean(await this.read("subscription", threadId)); }
  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> { this.ready(); const current = await this.read("lock", threadId); if (current) return null; const lock = { threadId, token: randomUUID(), expiresAt: Date.now() + ttlMs }; await this.write("lock", threadId, lock, ttlMs); return lock; }
  async forceReleaseLock(threadId: string) { this.ready(); await this.client.from("chat_state").delete().eq("key", id(`lock:${threadId}`)); }
  async releaseLock(lock: Lock) { this.ready(); const current = await this.read("lock", lock.threadId); if ((current?.value as Lock | undefined)?.token === lock.token) await this.forceReleaseLock(lock.threadId); }
  async extendLock(lock: Lock, ttlMs: number) { this.ready(); const current = await this.read("lock", lock.threadId); if ((current?.value as Lock | undefined)?.token !== lock.token) return false; lock.expiresAt = Date.now() + ttlMs; await this.write("lock", lock.threadId, lock, ttlMs); return true; }
  async get<T = unknown>(key: string) { this.ready(); const row = await this.read("cache", key); return row ? row.value as T : null; }
  async set<T = unknown>(key: string, value: T, ttlMs?: number) { this.ready(); await this.write("cache", key, value, ttlMs); }
  async setIfNotExists(key: string, value: unknown, ttlMs?: number) { this.ready(); if (await this.read("cache", key)) return false; await this.write("cache", key, value, ttlMs); return true; }
  async delete(key: string) { this.ready(); await this.client.from("chat_state").delete().eq("key", id(`cache:${key}`)); }
  async getList<T = unknown>(key: string) { this.ready(); const row = await this.read("list", key); return row && Array.isArray(row.value) ? row.value as T[] : []; }
  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }) { const values = await this.getList(key); values.push(value); if (options?.maxLength) values.splice(0, Math.max(0, values.length - options.maxLength)); await this.write("list", key, values, options?.ttlMs); }
  async enqueue(threadId: string, entry: QueueEntry, maxSize: number) { const values = await this.getList<QueueEntry>(`queue:${threadId}`); values.push(entry); values.splice(0, Math.max(0, values.length - maxSize)); await this.write("list", `queue:${threadId}`, values); return values.length; }
  async dequeue(threadId: string) { const values = await this.getList<QueueEntry>(`queue:${threadId}`); let entry: QueueEntry | undefined; do { entry = values.shift(); } while (entry && entry.expiresAt <= Date.now()); await this.write("list", `queue:${threadId}`, values); return entry ?? null; }
  async queueDepth(threadId: string) { return (await this.getList<QueueEntry>(`queue:${threadId}`)).filter(item => item.expiresAt > Date.now()).length; }
}

export function createSupabaseState() { return new SupabaseStateAdapter(); }
