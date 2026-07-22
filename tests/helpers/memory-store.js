import { encodeCursor } from "../../src/utils/pagination.js";

export class MemoryStore {
  constructor(seed = {}) {
    this.collections = new Map();
    for (const [name, values] of Object.entries(seed)) {
      this.collections.set(name, new Map(Object.entries(values).map(([id, value]) => [id, clone(value)])));
    }
  }

  bucket(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }

  async get(collection, id) {
    const value = this.bucket(collection).get(id);
    return value ? { id, ...clone(value) } : null;
  }

  async getMany(collection, ids = []) {
    return Promise.all([...new Set(ids.filter(Boolean))].map((id) => this.get(collection, id)))
      .then((items) => items.filter(Boolean));
  }

  async set(collection, id, data, options = { merge: false }) {
    const current = this.bucket(collection).get(id) || {};
    this.bucket(collection).set(id, clone(options.merge ? { ...current, ...data } : data));
    return { id, ...clone(data) };
  }

  async create(collection, id, data) {
    if (this.bucket(collection).has(id)) throw new Error("ALREADY_EXISTS");
    this.bucket(collection).set(id, clone(data));
    return { id, ...clone(data) };
  }

  async update(collection, id, data) {
    if (!this.bucket(collection).has(id)) throw new Error(`NOT_FOUND:${collection}/${id}`);
    this.bucket(collection).set(id, clone({ ...this.bucket(collection).get(id), ...data }));
    return { id, ...clone(data) };
  }

  async find(collection, { filters = [], orderBy, limit = 25, cursor, search, searchFields = [] } = {}) {
    let values = [...this.bucket(collection)].map(([id, value]) => ({ id, ...clone(value) }));
    values = values.filter((item) => filters.every(([field, op, expected]) => compare(item[field], op, expected)));
    if (orderBy?.[0]) {
      const [field, direction] = orderBy;
      values.sort((a, b) => compareSort(a[field], b[field]) * (direction === "desc" ? -1 : 1));
    }
    if (cursor) {
      const index = values.findIndex((item) => item.id === cursor);
      if (index >= 0) values = values.slice(index + 1);
    }
    if (search) {
      values = values.filter((item) => searchFields.some((field) => String(item[field] || "").toLowerCase().includes(search.toLowerCase())));
    }
    const hasMore = values.length > limit;
    const items = values.slice(0, limit);
    return { items, pagination: { hasMore, nextCursor: hasMore ? encodeCursor(items.at(-1)?.id) : null } };
  }

  async runTransaction(callback) {
    const snapshot = new Map([...this.collections].map(([name, bucket]) => [name, new Map([...bucket].map(([id, value]) => [id, clone(value)]))]));
    const txStore = new MemoryStore();
    txStore.collections = snapshot;
    const result = await callback({
      get: txStore.get.bind(txStore),
      set: txStore.set.bind(txStore),
      create: txStore.create.bind(txStore),
      update: txStore.update.bind(txStore)
    });
    this.collections = txStore.collections;
    return result;
  }

  async batchUpdate(collection, items) {
    for (const item of items) await this.set(collection, item.id, item.data, { merge: true });
    return items.length;
  }
}

function compare(actual, op, expected) {
  const a = comparable(actual);
  const e = comparable(expected);
  if (op === "==") return a === e;
  if (op === "!=") return a !== e;
  if (op === ">") return a > e;
  if (op === ">=") return a >= e;
  if (op === "<") return a < e;
  if (op === "<=") return a <= e;
  if (op === "in") return expected.includes(actual);
  if (op === "not-in") return !expected.includes(actual);
  if (op === "array-contains") return Array.isArray(actual) && actual.includes(expected);
  return false;
}

function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function compareSort(a, b) {
  const left = comparable(a) ?? 0;
  const right = comparable(b) ?? 0;
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone(value) {
  return structuredClone(value);
}
