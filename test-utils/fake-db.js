'use strict';

/**
 * 内存版云数据库，实现 wx-server-sdk 里我们实际用到的那部分 API。
 *
 * 存在意义：本机没有云环境时，也能对云函数的**业务逻辑**（越权校验、
 * 归属校验、写入、聚合、幂等）跑自动化测试。它不替代真机验收，
 * 但能挡住绝大多数逻辑错误。
 *
 * 刻意不实现 aggregate / 正则 / 地理查询 —— 云函数里也不用这些，
 * 复杂计算一律在 core.js 里用 JS 做（顺带保证了可测性）。
 */

let idSeq = 0;
function nextId(name) {
  idSeq += 1;
  return `${name}_${String(idSeq).padStart(6, '0')}`;
}

function resetIdSeq() {
  idSeq = 0;
}

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  Object.keys(value).forEach((k) => {
    out[k] = clone(value[k]);
  });
  return out;
}

function isCommand(v) {
  return Boolean(v && typeof v === 'object' && v.__op);
}

function toTime(v) {
  return v instanceof Date ? v.getTime() : v;
}

function valueEquals(a, b) {
  if (a instanceof Date || b instanceof Date) return toTime(a) === toTime(b);
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

function compare(a, b) {
  const x = toTime(a);
  const y = toTime(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

function matchField(docValue, condition) {
  if (isCommand(condition)) {
    const v = condition.value;
    switch (condition.__op) {
      case 'eq':
        return valueEquals(docValue, v);
      case 'neq':
        return !valueEquals(docValue, v);
      case 'gt':
        return compare(docValue, v) > 0;
      case 'gte':
        return compare(docValue, v) >= 0;
      case 'lt':
        return compare(docValue, v) < 0;
      case 'lte':
        return compare(docValue, v) <= 0;
      case 'in':
        return (v || []).some((item) => valueEquals(docValue, item));
      case 'nin':
        return !(v || []).some((item) => valueEquals(docValue, item));
      case 'exists':
        return v ? docValue !== undefined : docValue === undefined;
      default:
        throw new Error(`fake-db 未实现的查询指令: ${condition.__op}`);
    }
  }
  return valueEquals(docValue, condition);
}

function matchDoc(doc, condition) {
  return Object.keys(condition || {}).every((key) => matchField(doc[key], condition[key]));
}

function applyUpdate(doc, data) {
  Object.keys(data || {}).forEach((key) => {
    const value = data[key];
    if (isCommand(value)) {
      if (value.__op === 'inc') {
        doc[key] = (Number(doc[key]) || 0) + Number(value.value);
        return;
      }
      if (value.__op === 'set') {
        doc[key] = clone(value.value);
        return;
      }
      if (value.__op === 'remove') {
        delete doc[key];
        return;
      }
      throw new Error(`fake-db 未实现的更新指令: ${value.__op}`);
    }
    doc[key] = clone(value);
  });
}

function createFakeDb(seed = {}) {
  const store = {};
  Object.keys(seed).forEach((name) => {
    store[name] = (seed[name] || []).map((doc) => {
      const copy = clone(doc);
      if (!copy._id) copy._id = nextId(name);
      return copy;
    });
  });

  function collection(name) {
    if (!store[name]) store[name] = [];
    return buildCollection(store[name], name);
  }

  const command = {
    eq: (value) => ({ __op: 'eq', value }),
    neq: (value) => ({ __op: 'neq', value }),
    gt: (value) => ({ __op: 'gt', value }),
    gte: (value) => ({ __op: 'gte', value }),
    lt: (value) => ({ __op: 'lt', value }),
    lte: (value) => ({ __op: 'lte', value }),
    in: (value) => ({ __op: 'in', value }),
    nin: (value) => ({ __op: 'nin', value }),
    exists: (value) => ({ __op: 'exists', value }),
    inc: (value) => ({ __op: 'inc', value }),
    set: (value) => ({ __op: 'set', value }),
    remove: () => ({ __op: 'remove' })
  };

  return {
    collection,
    command,
    serverDate: () => new Date(),
    /** 测试辅助：直接读取当前数据快照 */
    _dump: (name) => clone(name ? store[name] || [] : store),
    /** 测试辅助：直接插入种子数据 */
    _seed: (name, docs) => {
      if (!store[name]) store[name] = [];
      (docs || []).forEach((doc) => {
        const copy = clone(doc);
        if (!copy._id) copy._id = nextId(name);
        store[name].push(copy);
      });
    }
  };
}

function buildCollection(docs, name, condition = {}, order = [], offset = 0, cap = null) {
  const filtered = () => docs.filter((d) => matchDoc(d, condition));

  function sorted(list) {
    if (!order.length) return list.slice();
    const out = list.slice();
    out.sort((a, b) => {
      for (let i = 0; i < order.length; i += 1) {
        const { field, dir } = order[i];
        const c = compare(a[field], b[field]);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
    return out;
  }

  return {
    where(next = {}) {
      return buildCollection(docs, name, Object.assign({}, condition, next), order, offset, cap);
    },
    orderBy(field, dir = 'asc') {
      return buildCollection(docs, name, condition, order.concat([{ field, dir }]), offset, cap);
    },
    skip(n) {
      return buildCollection(docs, name, condition, order, n, cap);
    },
    limit(n) {
      return buildCollection(docs, name, condition, order, offset, n);
    },
    async get() {
      let list = sorted(filtered());
      if (offset) list = list.slice(offset);
      if (cap !== null && cap !== undefined) list = list.slice(0, cap);
      return { data: clone(list) };
    },
    async count() {
      return { total: filtered().length };
    },
    async add({ data }) {
      const doc = clone(data) || {};
      if (!doc._id) doc._id = nextId(name);
      docs.push(doc);
      return { _id: doc._id };
    },
    async update({ data }) {
      const list = filtered();
      list.forEach((doc) => applyUpdate(doc, data));
      return { stats: { updated: list.length } };
    },
    async remove() {
      const list = filtered();
      list.forEach((doc) => {
        const idx = docs.indexOf(doc);
        if (idx >= 0) docs.splice(idx, 1);
      });
      return { stats: { removed: list.length } };
    },
    doc(id) {
      return {
        async get() {
          const doc = docs.find((d) => d._id === id);
          if (!doc) {
            const err = new Error('document.get:fail document does not exist');
            err.errCode = -502004;
            throw err;
          }
          return { data: clone(doc) };
        },
        async set({ data }) {
          const doc = docs.find((d) => d._id === id);
          if (doc) {
            Object.keys(doc).forEach((k) => {
              if (k !== '_id') delete doc[k];
            });
            Object.assign(doc, clone(data), { _id: id });
          } else {
            docs.push(Object.assign(clone(data) || {}, { _id: id }));
          }
          return { stats: { updated: 1 } };
        },
        async update({ data }) {
          const doc = docs.find((d) => d._id === id);
          if (!doc) return { stats: { updated: 0 } };
          applyUpdate(doc, data);
          return { stats: { updated: 1 } };
        },
        async remove() {
          const idx = docs.findIndex((d) => d._id === id);
          if (idx < 0) return { stats: { removed: 0 } };
          docs.splice(idx, 1);
          return { stats: { removed: 1 } };
        }
      };
    }
  };
}

module.exports = { createFakeDb, resetIdSeq, clone };
