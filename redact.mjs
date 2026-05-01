#!/usr/bin/env node
// Reads ../launch_dashboard/cohort_data.json, produces ./cohort_data.json
// with names → initials and amounts → ±30% deterministic noise.
// Recomputes day/cohort aggregates from the redacted transactions so totals stay self-consistent.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SRC = new URL('../launch_dashboard/cohort_data.json', import.meta.url);
const OUT = new URL('./cohort_data.json', import.meta.url);
const SALT = 'tis-redacted-v1';
const NOISE = 0.30;

function seededUnit(...keys) {
  const h = createHash('sha256').update(SALT + '|' + keys.join('|')).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

function jitter(value, ...keys) {
  if (!value) return value;
  const u = seededUnit(...keys);
  const factor = 1 + (u * 2 - 1) * NOISE;
  return Math.round(value * factor * 100) / 100;
}

function initials(name) {
  if (!name) return '—';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0][0].toUpperCase() + '.';
  return parts[0][0].toUpperCase() + '.' + parts[parts.length - 1][0].toUpperCase() + '.';
}

function redactOrder(order, cohortKey, dayDate, idx) {
  const seedKeys = [cohortKey, dayDate, idx, order.product || ''];
  const initial = jitter(order.initial_amount || 0, ...seedKeys, 'initial');
  const rebill = jitter(order.rebill_amount || 0, ...seedKeys, 'rebill');
  const upgrade = jitter(order.upgrade_amount || 0, ...seedKeys, 'upgrade');
  const refund = jitter(order.refund_amount || 0, ...seedKeys, 'refund');

  const total = Math.round((initial + rebill + upgrade) * 100) / 100;
  // commission ~ 5% of initial, jittered slightly
  const commission = Math.round(initial * 0.05 * (1 + (seededUnit(...seedKeys, 'comm') - 0.5) * 0.2) * 100) / 100;
  const net = Math.round((total - commission - refund) * 100) / 100;

  return {
    ...order,
    name: initials(order.name),
    initial_amount: initial,
    rebill_amount: rebill,
    upgrade_amount: upgrade,
    total_amount: total,
    commission_amount: commission,
    refund_amount: refund,
    net_amount: net,
  };
}

function redactDay(day, cohortKey) {
  const orders = (day.orders || []).map((o, i) => redactOrder(o, cohortKey, day.date, i));
  const revenue = Math.round(orders.reduce((s, o) => s + (o.total_amount || 0), 0) * 100) / 100;
  const net_revenue = Math.round(orders.reduce((s, o) => s + (o.net_amount || 0), 0) * 100) / 100;
  return {
    ...day,
    orders,
    transactions: orders.length,
    revenue,
    net_revenue,
  };
}

function redactBucket(bucket, cohortKey, label) {
  const orders = (bucket.orders || []).map((o, i) => redactOrder(o, cohortKey, label + '-' + (o.date || ''), i));
  const revenue = Math.round(orders.reduce((s, o) => s + (o.total_amount || 0), 0) * 100) / 100;
  const net_revenue = Math.round(orders.reduce((s, o) => s + (o.net_amount || 0), 0) * 100) / 100;
  return {
    ...bucket,
    orders,
    transactions: orders.length,
    revenue,
    net_revenue,
  };
}

function redactCohort(cohort, cohortKey) {
  const daily_data = (cohort.daily_data || []).map((d) => redactDay(d, cohortKey));
  const early_sales = cohort.early_sales ? redactBucket(cohort.early_sales, cohortKey, 'early') : undefined;
  const late_sales = cohort.late_sales ? redactBucket(cohort.late_sales, cohortKey, 'late') : undefined;

  let cumTxn = 0, cumRev = 0, cumNet = 0;
  for (const d of daily_data) {
    cumTxn += d.transactions;
    cumRev += d.revenue;
    cumNet += d.net_revenue;
    d.cumulative_transactions = cumTxn;
    d.cumulative_revenue = Math.round(cumRev * 100) / 100;
  }

  const allOrders = [
    ...(early_sales?.orders || []),
    ...daily_data.flatMap((d) => d.orders),
    ...(late_sales?.orders || []),
  ];
  const totalRev = Math.round(allOrders.reduce((s, o) => s + (o.total_amount || 0), 0) * 100) / 100;
  const totalNet = Math.round(allOrders.reduce((s, o) => s + (o.net_amount || 0), 0) * 100) / 100;
  const totalCommission = Math.round(allOrders.reduce((s, o) => s + (o.commission_amount || 0), 0) * 100) / 100;
  const totalRefund = Math.round(allOrders.reduce((s, o) => s + (o.refund_amount || 0), 0) * 100) / 100;
  const totalTxn = allOrders.length;

  const totals = {
    transactions: totalTxn,
    revenue: totalRev,
    net_revenue: totalNet,
    commission: totalCommission,
    refunds: totalRefund,
    window_transactions: cumTxn,
    window_revenue: Math.round(cumRev * 100) / 100,
    window_net_revenue: Math.round(cumNet * 100) / 100,
  };

  return {
    ...cohort,
    daily_data,
    early_sales,
    late_sales,
    totals,
  };
}

const src = JSON.parse(readFileSync(SRC, 'utf8'));
const redacted = {
  generated_at: new Date().toISOString(),
  redacted: true,
  cohorts: {},
};
for (const [key, cohort] of Object.entries(src.cohorts)) {
  redacted.cohorts[key] = redactCohort(cohort, key);
}
writeFileSync(OUT, JSON.stringify(redacted, null, 2));

const sizes = Object.entries(redacted.cohorts).map(([k, c]) => `  ${k}: ${c.totals.transactions} txns / $${c.totals.revenue.toLocaleString()} rev`);
console.log('Redacted cohort_data.json written. Summary:');
console.log(sizes.join('\n'));
