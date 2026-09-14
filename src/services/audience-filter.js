import { z } from 'zod';
import { ConflictError } from '../utils/errors.js';

const fields = {
  relationship: { path: 'crmV1Relationship', values: ['unclassified', 'prospect', 'customer'] },
  tier: { path: 'crmV1Tier', values: ['standard', 'premium', 'vip'] },
  city: { path: 'city' }, owner: { path: 'assignedTo' }, service: { path: 'tags', array: true },
  lastInteraction: { path: 'crmV1LastMeaningfulAtMs', date: true },
  lastMarketing: { path: 'crmV1LastMarketingAtMs', date: true },
  needsReview: { path: 'crmV1NeedsReview', boolean: true }
};
const nodeSchema = z.lazy(() => z.union([
  z.object({ op: z.enum(['and', 'or']), rules: z.array(nodeSchema).min(1).max(10) }).strict(),
  z.object({ field: z.enum(Object.keys(fields)), op: z.enum(['eq', 'in', 'contains', 'olderDays', 'withinDays', 'unknown']), value: z.unknown().optional() }).strict()
]));
export const filterSchema = z.object({ version: z.literal(1), rule: nodeSchema }).strict();

export function compileAudienceFilter(raw, nowMs = Date.now()) {
  const parsed = filterSchema.parse(raw);
  let leaves = 0;
  function visit(node, depth = 0) {
    if (depth > 3) throw new ConflictError('Filters support at most three nested groups');
    if (node.rules) return { [node.op]: node.rules.map(child => visit(child, depth + 1)) };
    if (++leaves > 12) throw new ConflictError('Use at most 12 filter conditions');
    const cfg = fields[node.field];
    if (cfg.date) {
      if (node.op === 'unknown') return { field: cfg.path, op: '==', value: -1 };
      if (!['olderDays', 'withinDays'].includes(node.op) || !Number.isInteger(node.value) || node.value < 1 || node.value > 3650) throw new ConflictError('Choose 1–3650 rolling days for a date filter');
      return { and: [{ field: cfg.path, op: '>=', value: node.op === 'olderDays' ? 0 : nowMs - node.value * 86400000 }, { field: cfg.path, op: '<=', value: node.op === 'olderDays' ? nowMs - node.value * 86400000 : nowMs }] };
    }
    if (cfg.array) {
      if (node.op !== 'contains' || typeof node.value !== 'string' || !node.value.trim() || node.value.length > 60) throw new ConflictError('Service filters require one tag');
      return { field: cfg.path, op: 'array-contains', value: node.value };
    }
    const values = node.op === 'in' ? node.value : [node.value];
    if (!['eq', 'in'].includes(node.op) || !Array.isArray(values) || !values.length || values.length > 5) throw new ConflictError('Unsupported filter operation');
    for (const value of values) {
      if (cfg.boolean ? typeof value !== 'boolean' : typeof value !== 'string' || value.length > 120) throw new ConflictError('Invalid filter value');
      if (cfg.values && !cfg.values.includes(value)) throw new ConflictError('Unknown classification value');
    }
    return { field: cfg.path, op: node.op === 'eq' ? '==' : 'in', value: node.op === 'eq' ? node.value : values };
  }
  const where = visit(parsed.rule);
  function paths(node) { return node.and || node.or ? (node.and || node.or).flatMap(paths) : [node.field]; }
  if (new Set(paths(where)).size > 3) throw new ConflictError('Use at most three different fields in one group; save a narrower group first');
  function disjunctions(node) { return node.or ? node.or.reduce((n, child) => n + disjunctions(child), 0) : node.and ? node.and.reduce((n, child) => n * disjunctions(child), 1) : node.op === 'in' ? node.value.length : 1; }
  if (disjunctions(where) > 10) throw new ConflictError('Filter is too broad; simplify OR / multiple-choice conditions');
  function arrayCount(node) { return node.and ? node.and.reduce((n, c) => n + arrayCount(c), 0) : node.or ? Math.max(...node.or.map(arrayCount)) : node.op === 'array-contains' ? 1 : 0; }
  if (arrayCount(where) > 1) throw new ConflictError('Use only one service tag per AND group');
  return where;
}

export function matchesWhere(row, node) {
  if (node.and) return node.and.every(child => matchesWhere(row, child));
  if (node.or) return node.or.some(child => matchesWhere(row, child));
  const value = node.field === '__name__' ? row.id : node.field.split('.').reduce((v, key) => v?.[key], row);
  if (node.op === '==') return value === node.value;
  if (node.op === 'in') return node.value.includes(value);
  if (node.op === 'array-contains') return Array.isArray(value) && value.includes(node.value);
  if (node.op === '>=') return value >= node.value;
  if (node.op === '<=') return value <= node.value;
  return false;
}
