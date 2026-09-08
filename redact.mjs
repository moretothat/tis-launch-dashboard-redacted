#!/usr/bin/env node
// Reads ../launch_dashboard/cohort_data.json (real data — dates/structure only)
// and produces ./cohort_data.json: a fully synthetic dataset for a public demo.
// Every customer name, email, and dollar amount is fabricated. Day-to-day
// amounts are reshuffled (not just scaled) so the trajectory doesn't mirror
// the real launch, then each cohort is rescaled so the six cohorts sum to
// TARGET_TOTAL exactly.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SRC = new URL('../launch_dashboard/cohort_data.json', import.meta.url);
const OUT = new URL('./cohort_data.json', import.meta.url);
const SALT = 'tis-fake-demo-v1';
const ORDER_NOISE = 0.35;
const DAY_TRAJECTORY_NOISE = 0.6; // reshapes day-to-day shape before rescaling
const TARGET_TOTAL = 500_000;
// Mild cohort-to-cohort growth story, jittered per-cohort below, then
// renormalized so the six shares always sum to exactly 1.
const COHORT_WEIGHTS = [0.12, 0.14, 0.16, 0.17, 0.19, 0.22];

function seededUnit(...keys) {
  const h = createHash('sha256').update(SALT + '|' + keys.join('|')).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

function pick(arr, ...keys) {
  const u = seededUnit(...keys);
  return arr[Math.floor(u * arr.length) % arr.length];
}

function jitter(value, amount, ...keys) {
  if (!value) return value;
  const u = seededUnit(...keys);
  const factor = 1 + (u * 2 - 1) * amount;
  return Math.round(value * factor * 100) / 100;
}

const FIRST_NAMES = [
  'Alex','Jordan','Morgan','Taylor','Casey','Riley','Jamie','Avery','Quinn','Reese',
  'Sam','Drew','Skyler','Rowan','Emerson','Hayden','Peyton','Charlie','Dakota','Kendall',
  'Maya','Elena','Priya','Noor','Grace','Chloe','Sofia','Naomi','Leah','Ivy',
  'Marcus','Elias','Owen','Miles','Julian','Theo','Ezra','Caleb','Gabriel','Nathaniel',
  'Aisha','Yuki','Camila','Fatima','Renata','Simone','Amara','Delphine','Freya','Wren',
];
const LAST_NAMES = [
  'Bennett','Carter','Delgado','Ellison','Foster','Grant','Hayes','Ibarra','Jensen','Kearns',
  'Lindqvist','Marsh','Nakamura','Osei','Pereira','Quintero','Reyes','Sinclair','Tran','Uzoma',
  'Vance','Whitfield','Xiong','Yamamoto','Zeller','Abernathy','Blackwood','Chastain','Devereux','Emerick',
  'Farrow','Gable','Holloway','Iverson','Jarrett','Kessler','Lund','Monroe','Novak','Ortega',
];
const EMAIL_DOMAINS = ['gmail.com','yahoo.com','outlook.com','icloud.com','hotmail.com','proton.me'];

function fakeIdentity(...keys) {
  const first = pick(FIRST_NAMES, ...keys, 'first');
  const last = pick(LAST_NAMES, ...keys, 'last');
  const name = `${first} ${last}`;
  const domain = pick(EMAIL_DOMAINS, ...keys, 'domain');
  const useDigits = seededUnit(...keys, 'digitflag') < 0.3;
  const digits = useDigits ? String(Math.floor(seededUnit(...keys, 'digits') * 89) + 10) : '';
  const email = `${first.toLowerCase()}.${last.toLowerCase()}${digits}@${domain}`;
  return { name, email };
}

const EMAIL_SUBJECTS = [
  'Doors are open',
  'The story you keep almost telling',
  '24 hours until we close',
  'What happens after you enroll',
  'A note before the cart closes',
  'Last call: enrollment ends tonight',
  'Why most stories fall flat (and how to fix it)',
  'Inside look: what you get on day one',
  "It's closing — here's what to know",
  'One question to ask before you write another word',
];

function fakeBroadcast(cohortKey, dayLabel, idx) {
  const keys = [cohortKey, dayLabel, idx, 'broadcast'];
  const subject = pick(EMAIL_SUBJECTS, ...keys, 'subject');
  const recipients = Math.round(1800 + seededUnit(...keys, 'recip') * 5200);
  const open_rate = Math.round((0.28 + seededUnit(...keys, 'open') * 0.34) * 1000) / 1000;
  const click_rate = Math.round((open_rate * (0.08 + seededUnit(...keys, 'click') * 0.14)) * 1000) / 1000;
  return { day: dayLabel, subject, recipients, open_rate, click_rate };
}

function redactOrder(order, cohortKey, dayDate, idx) {
  const seedKeys = [cohortKey, dayDate, idx, order.product || ''];
  const { name, email } = fakeIdentity(...seedKeys, 'identity');
  const initial = jitter(order.initial_amount || 0, ORDER_NOISE, ...seedKeys, 'initial');
  const rebill = jitter(order.rebill_amount || 0, ORDER_NOISE, ...seedKeys, 'rebill');
  const upgrade = jitter(order.upgrade_amount || 0, ORDER_NOISE, ...seedKeys, 'upgrade');
  const refund = jitter(order.refund_amount || 0, ORDER_NOISE, ...seedKeys, 'refund');

  const total = Math.round((initial + rebill + upgrade) * 100) / 100;
  // commission ~ 5% of initial, jittered slightly
  const commission = Math.round(initial * 0.05 * (1 + (seededUnit(...seedKeys, 'comm') - 0.5) * 0.2) * 100) / 100;
  const net = Math.round((total - commission - refund) * 100) / 100;

  return {
    ...order,
    name,
    email,
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
  // Reshape the day's overall weight before jittering individual orders,
  // so the cumulative curve doesn't just trace the real launch's shape.
  const dayFactor = 1 + (seededUnit(cohortKey, day.date, 'daytrajectory') * 2 - 1) * DAY_TRAJECTORY_NOISE;
  const scaledOrders = (day.orders || []).map((o) => ({
    ...o,
    initial_amount: Math.round((o.initial_amount || 0) * dayFactor * 100) / 100,
    rebill_amount: Math.round((o.rebill_amount || 0) * dayFactor * 100) / 100,
    upgrade_amount: Math.round((o.upgrade_amount || 0) * dayFactor * 100) / 100,
  }));
  const orders = scaledOrders.map((o, i) => redactOrder(o, cohortKey, day.date, i));
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

function scaleOrder(order, factor) {
  const initial = Math.round((order.initial_amount || 0) * factor * 100) / 100;
  const rebill = Math.round((order.rebill_amount || 0) * factor * 100) / 100;
  const upgrade = Math.round((order.upgrade_amount || 0) * factor * 100) / 100;
  const refund = Math.round((order.refund_amount || 0) * factor * 100) / 100;
  const commission = Math.round((order.commission_amount || 0) * factor * 100) / 100;
  const total = Math.round((initial + rebill + upgrade) * 100) / 100;
  const net = Math.round((total - commission - refund) * 100) / 100;
  return { ...order, initial_amount: initial, rebill_amount: rebill, upgrade_amount: upgrade, refund_amount: refund, commission_amount: commission, total_amount: total, net_amount: net };
}

function rebuildCohortAggregates(cohort) {
  const recomputeBucket = (b) => {
    if (!b) return b;
    const orders = b.orders || [];
    return { ...b, orders, transactions: orders.length,
      revenue: Math.round(orders.reduce((s, o) => s + (o.total_amount || 0), 0) * 100) / 100,
      net_revenue: Math.round(orders.reduce((s, o) => s + (o.net_amount || 0), 0) * 100) / 100 };
  };
  const daily_data = (cohort.daily_data || []).map((d) => {
    const orders = d.orders || [];
    return { ...d, orders, transactions: orders.length,
      revenue: Math.round(orders.reduce((s, o) => s + (o.total_amount || 0), 0) * 100) / 100,
      net_revenue: Math.round(orders.reduce((s, o) => s + (o.net_amount || 0), 0) * 100) / 100 };
  });
  let cumTxn = 0, cumRev = 0, cumNet = 0;
  for (const d of daily_data) {
    cumTxn += d.transactions;
    cumRev += d.revenue;
    cumNet += d.net_revenue;
    d.cumulative_transactions = cumTxn;
    d.cumulative_revenue = Math.round(cumRev * 100) / 100;
  }
  const early_sales = recomputeBucket(cohort.early_sales);
  const late_sales = recomputeBucket(cohort.late_sales);
  const allOrders = [...(early_sales?.orders || []), ...daily_data.flatMap(d => d.orders), ...(late_sales?.orders || [])];
  const sum = (k) => Math.round(allOrders.reduce((s, o) => s + (o[k] || 0), 0) * 100) / 100;
  return { ...cohort, daily_data, early_sales, late_sales,
    totals: { transactions: allOrders.length, revenue: sum('total_amount'), net_revenue: sum('net_amount'),
      commission: sum('commission_amount'), refunds: sum('refund_amount'),
      window_transactions: cumTxn, window_revenue: Math.round(cumRev * 100) / 100, window_net_revenue: Math.round(cumNet * 100) / 100 } };
}

function scaleCohortToTarget(cohort, target) {
  const current = cohort.totals?.revenue || 0;
  if (!current) return cohort;
  const factor = target / current;
  const scaleBucket = (b) => b ? { ...b, orders: (b.orders || []).map(o => scaleOrder(o, factor)) } : b;
  const daily_data = (cohort.daily_data || []).map(d => ({ ...d, orders: (d.orders || []).map(o => scaleOrder(o, factor)) }));
  return rebuildCohortAggregates({ ...cohort, daily_data, early_sales: scaleBucket(cohort.early_sales), late_sales: scaleBucket(cohort.late_sales) });
}

function cohortWeights(cohortKeys) {
  // Jitter the base growth-story weights per cohort, then renormalize to sum to 1.
  const jittered = cohortKeys.map((key, i) => {
    const base = COHORT_WEIGHTS[i % COHORT_WEIGHTS.length];
    const u = seededUnit(key, 'weight');
    return base * (1 + (u * 2 - 1) * 0.35);
  });
  const sum = jittered.reduce((s, w) => s + w, 0);
  return jittered.map((w) => w / sum);
}

function buildFakeBroadcasts(cohort, cohortKey) {
  const days = (cohort.daily_data || []).map((d) => d.day);
  if (!days.length) return [];
  const minDay = Math.min(...days);
  const maxDay = Math.max(...days);
  const count = Math.min(6, Math.max(3, Math.round(seededUnit(cohortKey, 'emailcount') * 4) + 3));
  const spread = maxDay - minDay;
  const chosenDays = new Set();
  for (let i = 0; i < count; i++) {
    const u = seededUnit(cohortKey, 'emailday', i);
    let day = minDay + Math.round(u * spread);
    while (chosenDays.has(day) && day < maxDay) day++;
    chosenDays.add(day);
  }
  return [...chosenDays].sort((a, b) => a - b).map((day, i) => fakeBroadcast(cohortKey, day, i));
}

const src = JSON.parse(readFileSync(SRC, 'utf8'));
const cohortKeys = Object.keys(src.cohorts);
const weights = cohortWeights(cohortKeys);
const redacted = {
  generated_at: new Date().toISOString(),
  fake: true,
  cohorts: {},
  broadcasts: {},
};
cohortKeys.forEach((key, i) => {
  const jittered = redactCohort(src.cohorts[key], key);
  const scaled = scaleCohortToTarget(jittered, TARGET_TOTAL * weights[i]);
  redacted.cohorts[key] = scaled;
  redacted.broadcasts[key] = buildFakeBroadcasts(scaled, key);
});
writeFileSync(OUT, JSON.stringify(redacted, null, 2));

const grandTotal = Object.values(redacted.cohorts).reduce((s, c) => s + c.totals.revenue, 0);
const sizes = Object.entries(redacted.cohorts).map(([k, c]) => `  ${k}: ${c.totals.transactions} txns / $${c.totals.revenue.toLocaleString()} rev / ${redacted.broadcasts[k].length} emails`);
console.log('Fake cohort_data.json written. Summary:');
console.log(sizes.join('\n'));
console.log(`  TOTAL: $${Math.round(grandTotal).toLocaleString()}`);
