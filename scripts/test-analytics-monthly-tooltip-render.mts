/**
 * Regression test — Monthly comparison tooltip prior-date labels.
 *
 * Exercises the production `groupRevenueData` and `RevenueTrendTooltip` from
 * src/components/views/analytics.tsx with API-shaped YYYY-MM-DD dates.
 *
 * Current period : 2025-08-25 … 2025-09-07  (14 days, 7 in Aug + 7 in Sep)
 * Prior period   : 2025-08-11 … 2025-08-24  (14 days)
 *
 * Expected monthly points:
 *   August   — prior ₹455  (50+55+60+65+70+75+80),  label "August 11–17"
 *   September — prior ₹735  (90+95+100+105+110+115+120), label "August 18–24"
 *
 * The en-dash character (–, U+2013) must be used in the range, not a hyphen.
 * The prior label must NOT carry the current-month prefix.
 * The rendered tooltip must use `whitespace-normal break-words` (not truncate).
 */

import React from 'react';
import ReactDOMServer from 'react-dom/server';
import assert from 'node:assert/strict';
import { groupRevenueData, RevenueTrendTooltip } from '../src/components/views/analytics';

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(desc: string, condition: boolean, extra?: string) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ok    ${desc}`);
  } else {
    failed++;
    console.error(`  \u2717 FAIL  ${desc}${extra ? ` (${extra})` : ''}`);
  }
}

// ── Fixture data ─────────────────────────────────────────────────────────────

const EN_DASH = '\u2013';

const currentDaily = [
  { date: '2025-08-25', label: 'Mon', revenue: 100, orders: 1 },
  { date: '2025-08-26', label: 'Tue', revenue: 110, orders: 1 },
  { date: '2025-08-27', label: 'Wed', revenue: 120, orders: 1 },
  { date: '2025-08-28', label: 'Thu', revenue: 130, orders: 1 },
  { date: '2025-08-29', label: 'Fri', revenue: 140, orders: 1 },
  { date: '2025-08-30', label: 'Sat', revenue: 150, orders: 1 },
  { date: '2025-08-31', label: 'Sun', revenue: 160, orders: 1 },
  { date: '2025-09-01', label: 'Mon', revenue: 200, orders: 2 },
  { date: '2025-09-02', label: 'Tue', revenue: 210, orders: 2 },
  { date: '2025-09-03', label: 'Wed', revenue: 220, orders: 2 },
  { date: '2025-09-04', label: 'Thu', revenue: 230, orders: 2 },
  { date: '2025-09-05', label: 'Fri', revenue: 240, orders: 2 },
  { date: '2025-09-06', label: 'Sat', revenue: 250, orders: 2 },
  { date: '2025-09-07', label: 'Sun', revenue: 260, orders: 2 },
];

const priorDaily = [
  { date: '2025-08-11', label: 'Mon', revenue: 50,  orders: 1 },
  { date: '2025-08-12', label: 'Tue', revenue: 55,  orders: 1 },
  { date: '2025-08-13', label: 'Wed', revenue: 60,  orders: 1 },
  { date: '2025-08-14', label: 'Thu', revenue: 65,  orders: 1 },
  { date: '2025-08-15', label: 'Fri', revenue: 70,  orders: 1 },
  { date: '2025-08-16', label: 'Sat', revenue: 75,  orders: 1 },
  { date: '2025-08-17', label: 'Sun', revenue: 80,  orders: 1 },
  { date: '2025-08-18', label: 'Mon', revenue: 90,  orders: 1 },
  { date: '2025-08-19', label: 'Tue', revenue: 95,  orders: 1 },
  { date: '2025-08-20', label: 'Wed', revenue: 100, orders: 1 },
  { date: '2025-08-21', label: 'Thu', revenue: 105, orders: 1 },
  { date: '2025-08-22', label: 'Fri', revenue: 110, orders: 1 },
  { date: '2025-08-23', label: 'Sat', revenue: 115, orders: 1 },
  { date: '2025-08-24', label: 'Sun', revenue: 120, orders: 1 },
];

// ── Test start ───────────────────────────────────────────────────────────────

console.log('========================================================================');
console.log('  REGRESSION: Monthly Comparison Tooltip Prior-Date Labels');
console.log('========================================================================\n');

// ---- 1. groupRevenueData('monthly') produces the expected data points ------
console.log('── 1. Monthly grouping data ──');

const monthly = groupRevenueData(currentDaily, priorDaily, 'monthly');

check('Returns exactly 2 monthly points', monthly.length === 2, `got ${monthly.length}`);

const aug = monthly[0];
const sep = monthly[1];

check('Point 0 label is "August"', aug.label === 'August', `got "${aug?.label}"`);
check('Point 1 label is "September"', sep.label === 'September', `got "${sep?.label}"`);

// Revenue totals
check('August  currentRevenue = 910',  aug.currentRevenue === 910,  `got ${aug.currentRevenue}`);
check('August  prevRevenue    = 455',  aug.prevRevenue === 455,     `got ${aug.prevRevenue}`);
check('September currentRevenue = 1610', sep.currentRevenue === 1610, `got ${sep.currentRevenue}`);
check('September prevRevenue    = 735',  sep.prevRevenue === 735,    `got ${sep.prevRevenue}`);

// ---- 2. prevPeriod carries the exact expected label (no prefix) ------
console.log('\n── 2. Prior period labels (exact match, no current-month prefix) ──');

const expectedAugPrev = `August 11${EN_DASH}17`;
const expectedSepPrev = `August 18${EN_DASH}24`;

check(
  `August  prevPeriod === "${expectedAugPrev}"`,
  aug.prevPeriod === expectedAugPrev,
  `got "${aug.prevPeriod}"`
);
check(
  `September prevPeriod === "${expectedSepPrev}"`,
  sep.prevPeriod === expectedSepPrev,
  `got "${sep.prevPeriod}"`
);

// Negative: must not contain the current-month name as a prefix
check(
  'August prevPeriod does not start with "August ("',
  !aug.prevPeriod.startsWith('August ('),
  `got "${aug.prevPeriod}"`
);
check(
  'September prevPeriod does not contain "September"',
  !sep.prevPeriod.includes('September'),
  `got "${sep.prevPeriod}"`
);

// ---- 3. Render RevenueTrendTooltip for August point ------
console.log('\n── 3. Rendered tooltip — August point ──');

function renderTooltip(point: any): string {
  const payload = [
    { dataKey: 'currentRevenue', value: point.currentRevenue, payload: point },
    { dataKey: 'prevRevenue',    value: point.prevRevenue,    payload: point },
  ];
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(RevenueTrendTooltip, {
      active: true,
      payload,
      isComparisonEnabled: true,
      currencySymbol: '\u20B9',
    })
  );
}

const augHtml = renderTooltip(aug);

check(
  'Contains exact prior label "Prior (August 11\u201317):"',
  augHtml.includes(`Prior (August 11${EN_DASH}17):`),
  `html snippet: ${augHtml.slice(0, 400)}`
);
check(
  'Contains prior value "\u20B9455.00"',
  augHtml.includes('\u20B9455.00'),
  `html snippet: ${augHtml.slice(0, 400)}`
);
check(
  'Does NOT contain double-prefix "Prior (August (August"',
  !augHtml.includes('Prior (August (August'),
);
check(
  'Uses whitespace-normal break-words (not truncate)',
  augHtml.includes('whitespace-normal') && augHtml.includes('break-words'),
);
check(
  'Does NOT use truncate max-w-[130px]',
  !augHtml.includes('truncate') || !augHtml.includes('max-w-[130px]'),
);

// ---- 4. Render RevenueTrendTooltip for September point ------
console.log('\n── 4. Rendered tooltip — September point ──');

const sepHtml = renderTooltip(sep);

check(
  'Contains exact prior label "Prior (August 18\u201324):"',
  sepHtml.includes(`Prior (August 18${EN_DASH}24):`),
  `html snippet: ${sepHtml.slice(0, 400)}`
);
check(
  'Contains prior value "\u20B9735.00"',
  sepHtml.includes('\u20B9735.00'),
  `html snippet: ${sepHtml.slice(0, 400)}`
);
check(
  'Prior label does NOT contain "September"',
  !sepHtml.includes('Prior (September'),
);
check(
  'Uses whitespace-normal break-words (not truncate)',
  sepHtml.includes('whitespace-normal') && sepHtml.includes('break-words'),
);

// ---- 5. Weekly labels still work (non-regression) ------
console.log('\n── 5. Weekly prior labels unchanged ──');

const weekly = groupRevenueData(currentDaily, priorDaily, 'weekly');
check('Weekly grouping returns 2 chunks', weekly.length === 2, `got ${weekly.length}`);
check(
  'Week 1 prevPeriod is "Week 1 (2025-08-11 \u2013 2025-08-17)"',
  weekly[0].prevPeriod === 'Week 1 (2025-08-11 \u2013 2025-08-17)',
  `got "${weekly[0].prevPeriod}"`
);
check(
  'Week 2 prevPeriod is "Week 2 (2025-08-18 \u2013 2025-08-24)"',
  weekly[1].prevPeriod === 'Week 2 (2025-08-18 \u2013 2025-08-24)',
  `got "${weekly[1].prevPeriod}"`
);

// ---- 6. Clipping / layout note ------
console.log('\n── 6. Layout / clipping note ──');
console.log('  ℹ  The component test verifies CSS classes (whitespace-normal break-words)');
console.log('     but cannot measure pixel layout in Node. A manual browser check is');
console.log('     needed to confirm both date endpoints remain readable at the existing');
console.log('     tooltip width (~210 px min-w). The tooltip container uses min-w-[210px]');
console.log('     and the prior label is set to wrap (whitespace-normal break-words)');
console.log('     instead of truncating, so it will flow to a second line if needed.');

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n========================================================================');
console.log(`  SUMMARY: ${passed} PASSED, ${failed} FAILED`);
console.log('========================================================================');

if (failed > 0) process.exit(1);
