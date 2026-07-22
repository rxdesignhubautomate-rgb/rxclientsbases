import { encodeCursor } from "../utils/pagination.js";

export class FirestoreStore {
  constructor(db) {
    this.db = db;
  }

  async get(collection, id) {
    const snap = await this.db.collection(collection).doc(id).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  async getMany(collection, ids = []) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (!uniqueIds.length) return [];
    const snapshots = await this.db.getAll(...uniqueIds.map((id) => this.db.collection(collection).doc(id)));
    return snapshots.filter((snap) => snap.exists).map((snap) => ({ id: snap.id, ...snap.data() }));
  }

  async set(collection, id, data, options = { merge: false }) {
    await this.db.collection(collection).doc(id).set(data, options);
    return { id, ...data };
  }

  async create(collection, id, data) {
    await this.db.collection(collection).doc(id).create(data);
    return { id, ...data };
  }

  async update(collection, id, data) {
    await this.db.collection(collection).doc(id).update(data);
    return { id, ...data };
  }

  async find(collection, { filters = [], orderBy, limit = 25, cursor, search, searchFields = [] } = {}) {
    let query = this.db.collection(collection);
    for (const [field, operator, value] of filters) query = query.where(field, operator, value);
    if (orderBy?.[0]) query = query.orderBy(orderBy[0], orderBy[1] || "desc");
    if (cursor) {
      const cursorDoc = await this.db.collection(collection).doc(cursor).get();
      if (cursorDoc.exists) query = query.startAfter(cursorDoc);
    }
    const fetchLimit = search ? Math.min(limit * 5 + 1, 500) : limit + 1;
    const snap = await query.limit(fetchLimit).get();
    let items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    if (search) {
      const needle = search.toLowerCase();
      items = items.filter((item) =>
        searchFields.some((field) => String(item[field] || "").toLowerCase().includes(needle))
      );
    }
    const hasMore = items.length > limit;
    items = items.slice(0, limit);
    return {
      items,
      pagination: { nextCursor: hasMore ? encodeCursor(items.at(-1)?.id) : null, hasMore }
    };
  }

  async runTransaction(callback) {
    return this.db.runTransaction(async (nativeTx) => {
      const tx = {
        get: async (collection, id) => {
          const snap = await nativeTx.get(this.db.collection(collection).doc(id));
          return snap.exists ? { id: snap.id, ...snap.data() } : null;
        },
        set: (collection, id, data, options = { merge: false }) =>
          nativeTx.set(this.db.collection(collection).doc(id), data, options),
        create: (collection, id, data) => nativeTx.create(this.db.collection(collection).doc(id), data),
        update: (collection, id, data) => nativeTx.update(this.db.collection(collection).doc(id), data)
      };
      return callback(tx);
    });
  }

  async batchUpdate(collection, items, chunkSize = 400) {
    let changed = 0;
    for (let index = 0; index < items.length; index += chunkSize) {
      const batch = this.db.batch();
      for (const item of items.slice(index, index + chunkSize)) {
        batch.set(this.db.collection(collection).doc(item.id), item.data, { merge: true });
        changed += 1;
      }
      await batch.commit();
    }
    return changed;
  }
}
