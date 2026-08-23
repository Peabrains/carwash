import { createHash, randomUUID } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type DocumentReference } from "firebase-admin/firestore";
import type { Lock, QueueEntry, StateAdapter } from "chat";

function database() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is required for durable bot state");
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(raw)) });
  const firestore = getFirestore();
  // Chat SDK entries can contain optional fields (for example author.isSystem)
  // that are intentionally undefined. Firestore rejects undefined nested values
  // unless this compatibility option is enabled.
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}

function keyId(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

function live(data: FirebaseFirestore.DocumentData | undefined) {
  return Boolean(data) && (!data?.expires_at || Number(data.expires_at) > Date.now());
}

export class FirestoreStateAdapter implements StateAdapter {
  private db = database();
  private connected = false;
  private ref(kind: string, key: string): DocumentReference {
    return this.db.collection(`chat_${kind}`).doc(keyId(key));
  }

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  private ready() { if (!this.connected) throw new Error("FirestoreStateAdapter is not connected"); }

  async subscribe(threadId: string) {
    this.ready();
    await this.ref("subscriptions", threadId).set({ thread_id: threadId, subscribed_at: Date.now() });
  }
  async unsubscribe(threadId: string) { this.ready(); await this.ref("subscriptions", threadId).delete(); }
  async isSubscribed(threadId: string) { this.ready(); return (await this.ref("subscriptions", threadId).get()).exists; }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ready();
    const ref = this.ref("locks", threadId);
    return this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (live(snapshot.data())) return null;
      const lock = { threadId, token: randomUUID(), expiresAt: Date.now() + ttlMs };
      transaction.set(ref, { thread_id: threadId, token: lock.token, expires_at: lock.expiresAt });
      return lock;
    });
  }
  async forceReleaseLock(threadId: string) { this.ready(); await this.ref("locks", threadId).delete(); }
  async releaseLock(lock: Lock) {
    this.ready();
    const ref = this.ref("locks", lock.threadId);
    await this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (snapshot.data()?.token === lock.token) transaction.delete(ref);
    });
  }
  async extendLock(lock: Lock, ttlMs: number) {
    this.ready();
    const ref = this.ref("locks", lock.threadId);
    return this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!live(snapshot.data()) || snapshot.data()?.token !== lock.token) return false;
      lock.expiresAt = Date.now() + ttlMs;
      transaction.update(ref, { expires_at: lock.expiresAt });
      return true;
    });
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ready();
    const ref = this.ref("cache", key);
    const snapshot = await ref.get();
    if (!snapshot.exists) return null;
    if (!live(snapshot.data())) { await ref.delete(); return null; }
    return snapshot.data()?.value as T;
  }
  async set<T = unknown>(key: string, value: T, ttlMs?: number) {
    this.ready();
    await this.ref("cache", key).set({ key, value, expires_at: ttlMs ? Date.now() + ttlMs : null });
  }
  async setIfNotExists(key: string, value: unknown, ttlMs?: number) {
    this.ready();
    const ref = this.ref("cache", key);
    return this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (live(snapshot.data())) return false;
      transaction.set(ref, { key, value, expires_at: ttlMs ? Date.now() + ttlMs : null });
      return true;
    });
  }
  async delete(key: string) { this.ready(); await this.ref("cache", key).delete(); }

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }) {
    this.ready();
    const ref = this.ref("lists", key);
    await this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const current = live(snapshot.data()) && Array.isArray(snapshot.data()?.values) ? snapshot.data()!.values : [];
      const values = [...current, value];
      if (options?.maxLength && values.length > options.maxLength) values.splice(0, values.length - options.maxLength);
      transaction.set(ref, { key, values, expires_at: options?.ttlMs ? Date.now() + options.ttlMs : null });
    });
  }
  async getList<T = unknown>(key: string): Promise<T[]> {
    this.ready();
    const ref = this.ref("lists", key);
    const snapshot = await ref.get();
    if (!snapshot.exists) return [];
    if (!live(snapshot.data())) { await ref.delete(); return []; }
    return Array.isArray(snapshot.data()?.values) ? snapshot.data()!.values as T[] : [];
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number) {
    this.ready();
    const ref = this.ref("queues", threadId);
    return this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const entries = Array.isArray(snapshot.data()?.entries) ? [...snapshot.data()!.entries, entry] : [entry];
      if (entries.length > maxSize) entries.splice(0, entries.length - maxSize);
      transaction.set(ref, { thread_id: threadId, entries });
      return entries.length;
    });
  }
  async dequeue(threadId: string): Promise<QueueEntry | null> {
    this.ready();
    const ref = this.ref("queues", threadId);
    return this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const entries = Array.isArray(snapshot.data()?.entries) ? [...snapshot.data()!.entries] : [];
      let entry: QueueEntry | undefined;
      do { entry = entries.shift(); } while (entry && entry.expiresAt <= Date.now());
      if (entries.length) transaction.set(ref, { thread_id: threadId, entries }); else transaction.delete(ref);
      return entry ?? null;
    });
  }
  async queueDepth(threadId: string) {
    this.ready();
    const snapshot = await this.ref("queues", threadId).get();
    return Array.isArray(snapshot.data()?.entries) ? snapshot.data()!.entries.filter((entry: QueueEntry) => entry.expiresAt > Date.now()).length : 0;
  }
}

export function createFirestoreState() { return new FirestoreStateAdapter(); }
