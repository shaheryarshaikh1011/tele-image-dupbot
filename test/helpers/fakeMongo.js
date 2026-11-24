/**
 * Minimal in-memory stand-in for the subset of the MongoDB driver API this app uses.
 * Supports: equality (null matches missing), dot paths, $ne $in $nin $lt $lte $gt $gte $exists,
 * top-level $or; updates with $set $setOnInsert $inc $push; unique indexes; sort/limit.
 * Operations are synchronous internally, so findOneAndUpdate is atomic like the real thing.
 */

const clone = (v) => structuredClone(v);

function getPath(doc, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), doc);
}

function setPath(doc, path, value) {
  const keys = path.split('.');
  let cur = doc;
  for (const key of keys.slice(0, -1)) {
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  cur[keys.at(-1)] = value;
}

const cmpVal = (v) => (v instanceof Date ? v.getTime() : v);

function equals(a, b) {
  if (a == null && b == null) return true;
  if (a instanceof Date || b instanceof Date) return cmpVal(a) === cmpVal(b);
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function matchCondition(value, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond) && Object.keys(cond).some((k) => k.startsWith('$'))) {
    return Object.entries(cond).every(([op, arg]) => {
      switch (op) {
        case '$ne':
          return !equals(value, arg);
        case '$in':
          return arg.some((a) => equals(value, a));
        case '$nin':
          return !arg.some((a) => equals(value, a));
        case '$lt':
          return value != null && cmpVal(value) < cmpVal(arg);
        case '$lte':
          return value != null && cmpVal(value) <= cmpVal(arg);
        case '$gt':
          return value != null && cmpVal(value) > cmpVal(arg);
        case '$gte':
          return value != null && cmpVal(value) >= cmpVal(arg);
        case '$exists':
          return arg ? value !== undefined : value === undefined;
        default:
          throw new Error(`fakeMongo: unsupported operator ${op}`);
      }
    });
  }
  return equals(value, cond);
}

export function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((sub) => matches(doc, sub));
    if (key === '$and') return cond.every((sub) => matches(doc, sub));
    return matchCondition(getPath(doc, key), cond);
  });
}

function sortDocs(docs, sort) {
  if (!sort) return docs;
  const entries = Object.entries(sort);
  return [...docs].sort((a, b) => {
    for (const [key, dir] of entries) {
      const av = cmpVal(getPath(a, key));
      const bv = cmpVal(getPath(b, key));
      if (av === bv) continue;
      if (av == null) return -dir;
      if (bv == null) return dir;
      return av < bv ? -dir : dir;
    }
    return 0;
  });
}

function assertNoConflicts(update) {
  const seen = new Set();
  for (const fields of Object.values(update)) {
    for (const path of Object.keys(fields)) {
      for (const other of seen) {
        if (other === path || other.startsWith(`${path}.`) || path.startsWith(`${other}.`)) {
          throw Object.assign(new Error(`Updating the path '${path}' would create a conflict at '${other}'`), { code: 40 });
        }
      }
      seen.add(path);
    }
  }
}

function applyUpdate(doc, update, { inserting = false } = {}) {
  assertNoConflicts(update);
  for (const [op, fields] of Object.entries(update)) {
    if (op === '$set') for (const [k, v] of Object.entries(fields)) setPath(doc, k, clone(v));
    else if (op === '$setOnInsert') {
      if (inserting) for (const [k, v] of Object.entries(fields)) setPath(doc, k, clone(v));
    } else if (op === '$inc') for (const [k, v] of Object.entries(fields)) setPath(doc, k, (getPath(doc, k) ?? 0) + v);
    else if (op === '$push') for (const [k, v] of Object.entries(fields)) setPath(doc, k, [...(getPath(doc, k) ?? []), clone(v)]);
    else throw new Error(`fakeMongo: unsupported update operator ${op}`);
  }
}

let idCounter = 0;

class FakeCursor {
  constructor(docs) {
    this.docs = docs;
    this._sort = null;
    this._limit = 0;
  }
  sort(s) {
    this._sort = s;
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  async toArray() {
    let out = sortDocs(this.docs, this._sort);
    if (this._limit) out = out.slice(0, this._limit);
    return out.map(clone);
  }
}

export class FakeCollection {
  constructor(name) {
    this.name = name;
    this.docs = [];
    this.uniqueIndexes = [];
  }

  async createIndex(keys, opts = {}) {
    if (opts.unique) this.uniqueIndexes.push(Object.keys(keys));
    return 'ok';
  }

  _checkUnique(candidate, ignore) {
    const dupId = this.docs.find((d) => d !== ignore && equals(d._id, candidate._id));
    if (dupId) throw Object.assign(new Error('E11000 duplicate key error (_id)'), { code: 11000 });
    for (const keys of this.uniqueIndexes) {
      const clash = this.docs.find((d) => d !== ignore && keys.every((k) => equals(getPath(d, k), getPath(candidate, k))));
      if (clash) throw Object.assign(new Error(`E11000 duplicate key error (${keys.join(',')})`), { code: 11000 });
    }
  }

  _find(filter, sort) {
    return sortDocs(this.docs.filter((d) => matches(d, filter)), sort);
  }

  async insertOne(doc) {
    const copy = clone(doc);
    if (copy._id === undefined) copy._id = `oid_${++idCounter}`;
    this._checkUnique(copy);
    this.docs.push(copy);
    return { acknowledged: true, insertedId: copy._id };
  }

  async findOne(filter = {}, opts = {}) {
    const doc = this._find(filter, opts.sort)[0];
    return doc ? clone(doc) : null;
  }

  find(filter = {}) {
    return new FakeCursor(this.docs.filter((d) => matches(d, filter)));
  }

  async countDocuments(filter = {}) {
    return this.docs.filter((d) => matches(d, filter)).length;
  }

  _upsertDoc(filter, update) {
    const doc = {};
    for (const [k, v] of Object.entries(filter)) {
      if (!k.startsWith('$') && (v === null || typeof v !== 'object' || v instanceof Date)) setPath(doc, k, clone(v));
    }
    applyUpdate(doc, update, { inserting: true });
    if (doc._id === undefined) doc._id = `oid_${++idCounter}`;
    this._checkUnique(doc);
    this.docs.push(doc);
    return doc;
  }

  _updateInPlace(doc, update) {
    const next = clone(doc);
    applyUpdate(next, update);
    this._checkUnique(next, doc);
    const changed = JSON.stringify(next) !== JSON.stringify(doc);
    Object.keys(doc).forEach((k) => delete doc[k]);
    Object.assign(doc, next);
    return changed;
  }

  async updateOne(filter, update, opts = {}) {
    const doc = this._find(filter)[0];
    if (!doc) {
      if (opts.upsert) {
        const created = this._upsertDoc(filter, update);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: created._id };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }
    const changed = this._updateInPlace(doc, update);
    return { matchedCount: 1, modifiedCount: changed ? 1 : 0, upsertedCount: 0 };
  }

  async updateMany(filter, update) {
    const docs = this._find(filter);
    let modified = 0;
    for (const doc of docs) if (this._updateInPlace(doc, update)) modified += 1;
    return { matchedCount: docs.length, modifiedCount: modified };
  }

  async findOneAndUpdate(filter, update, opts = {}) {
    const doc = this._find(filter, opts.sort)[0];
    if (!doc) {
      if (!opts.upsert) return null;
      const created = this._upsertDoc(filter, update);
      return opts.returnDocument === 'after' ? clone(created) : null;
    }
    const before = clone(doc);
    this._updateInPlace(doc, update);
    return opts.returnDocument === 'after' ? clone(doc) : before;
  }

  async deleteOne(filter) {
    const idx = this.docs.findIndex((d) => matches(d, filter));
    if (idx >= 0) this.docs.splice(idx, 1);
    return { deletedCount: idx >= 0 ? 1 : 0 };
  }
}

export class FakeDb {
  constructor() {
    this.collections = new Map();
  }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection(name));
    return this.collections.get(name);
  }
}
