import { encodeCursor } from "../../src/utils/pagination.js";
import { matchesWhere } from '../../src/services/audience-filter.js';

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
    values = values.filter((item) => filters.every(([field, op, expected]) => compare(fieldValue(item, field), op, expected)));
    if (orderBy?.[0]) {
      const [field, direction] = orderBy;
      values.sort((a, b) => compareSort(fieldValue(a, field), fieldValue(b, field)) * (direction === "desc" ? -1 : 1));
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

  async count(collection, { filters = [] } = {}) {
    return [...this.bucket(collection).values()]
      .filter((item) => filters.every(([field, op, expected]) => compare(fieldValue(item, field), op, expected)))
      .length;
  }

  async findWhere(collection, { where, limit = 50, cursor, orderBy } = {}) {
    const orderFields = [...new Set(rangeFields(where))].sort();
    let values = [...this.bucket(collection)].map(([id, value]) => ({ id, ...clone(value) })).filter(row => matchesWhere(row, where)).sort((a, b) => {
      if (!orderFields.length && orderBy) { const result = compareSort(fieldValue(a, orderBy[0]), fieldValue(b, orderBy[0])); if (result) return result * (orderBy[1] === 'desc' ? -1 : 1); }
      for (const field of orderFields) { const result = compareSort(fieldValue(a, field), fieldValue(b, field)); if (result) return result; }
      return a.id.localeCompare(b.id) * (!orderFields.length && orderBy?.[1] === 'desc' ? -1 : 1);
    });
    if (cursor) { const at = values.findIndex(v => v.id === cursor); if (at >= 0) values = values.slice(at + 1); }
    const items = values.slice(0, limit);
    return { items, pagination: { hasMore: values.length > limit, nextCursor: values.length > limit ? encodeCursor(items.at(-1).id) : null } };
  }
  async countWhere(collection, where) {
    return [...this.bucket(collection)].filter(([id, value]) => matchesWhere({ id, ...value }, where)).length;
  }

  async runTransaction(callback) {
    const before = this.transactionTail || Promise.resolve();
    let release;
    this.transactionTail = new Promise(resolve => { release = resolve; });
    await before;
    try {
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
    } finally { release(); }
  }

  async batchUpdate(collection, items) {
    for (const item of items) await this.set(collection, item.id, item.data, { merge: true });
    return items.length;
  }

  async batchDelete(collection, ids) {
    for (const id of ids) this.bucket(collection).delete(id);
    return ids.length;
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

function fieldValue(item, field) { return field === '__name__' ? item.id : field.split('.').reduce((v, key) => v?.[key], item); }

function rangeFields(node) { return node.and || node.or ? (node.and || node.or).flatMap(rangeFields) : ['>', '>=', '<', '<='].includes(node.op) ? [node.field] : []; }
