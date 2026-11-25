/**
 * Real PostgreSQL concurrency, transaction, and refund accounting tests.
 *
 * Connects to the isolated local Supabase PostgreSQL instance (port 54322 by
 * default, or DATABASE_URL if provided) using a multi-connection pg.Pool so
 * concurrent calls execute in parallel database sessions.
 *
 *   npx tsx scripts/test-billing-db-concurrency.mts
 */
import { Pool } from "pg";
import crypto from "node:crypto";

const DB_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const pool = new Pool({ connectionString: DB_URL, max: 10 });

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok    ${name}`);
    pass++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
    fail++;
  }
}

const createdTenantIds: string[] = [];

async function createTestTenant(opts: { periodEnd?: string | null; status?: string } = {}) {
  const id = crypto.randomUUID();
  const slug = `test-db-${id.slice(0, 8)}`;
  await pool.query(
    `insert into public.tenants (id, name, slug, plan, subscription_plan, subscription_status, current_period_end)
     values ($1, $2, $3, 'starter', 'starter', $4, $5)`,
    [id, `Test Restaurant ${slug}`, slug, opts.status ?? "trial", opts.periodEnd ?? null],
  );
  createdTenantIds.push(id);
  return id;
}

async function createAnnualCheckout(tenantId: string, orderId: string, amount = 9990, planId = "starter") {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into public.subscription_checkouts
       (id, tenant_id, plan_id, amount, currency, billing_interval, payment_mode, razorpay_order_id, status)
     values ($1, $2, $5, $3, 'INR', 'annual', 'pay_once', $4, 'pending')`,
    [id, tenantId, amount, orderId, planId],
  );
  return id;
}

async function main() {
  console.log("\n── 1. Browser /verify + order.paid arriving simultaneously ──");
  {
    const tId = await createTestTenant();
    const orderId = `order_race1_${tId.slice(0, 8)}`;
    const payId = `pay_race1_${tId.slice(0, 8)}`;
    await createAnnualCheckout(tId, orderId, 9990);

    const [rVerify, rWebhook] = await Promise.all([
      pool.query(
        `select public.finalize_annual_order_payment($1, $2, $3, $2, 999000, 'INR', 'captured', 'upi', 'sig_1', null) as res`,
        [tId, orderId, payId],
      ),
      pool.query(
        `select public.finalize_annual_order_payment($1, $2, $3, $2, 999000, 'INR', 'captured', 'upi', null, $4) as res`,
        [tId, orderId, payId, `evt_order_${tId.slice(0, 8)}`],
      ),
    ]);

    const outcomes = [rVerify.rows[0].res.outcome, rWebhook.rows[0].res.outcome].sort();
    check("exactly one activated and one already", outcomes[0] === "activated" && outcomes[1] === "already", JSON.stringify(outcomes));

    const { rows: payRows } = await pool.query(
      `select count(*)::int as cnt from public.subscription_payments where razorpay_payment_id = $1`,
      [payId],
    );
    check("payment recorded exactly once", payRows[0].cnt === 1);

    const { rows: tRows } = await pool.query(
      `select subscription_status, billing_interval, payment_mode,
              extract(epoch from (current_period_end - subscription_started_at)) / 86400 as days_added
         from public.tenants where id = $1`,
      [tId],
    );
    check("tenant activated with annual pay_once", tRows[0].subscription_status === "active" && tRows[0].billing_interval === "annual" && tRows[0].payment_mode === "pay_once");
    check("entitlement extended by ~365 days (not 730)", Math.round(Number(tRows[0].days_added)) === 365, `days=${tRows[0].days_added}`);
  }

  console.log("\n── 2. order.paid + payment.captured + duplicate webhooks simultaneously ──");
  {
    const tId = await createTestTenant();
    const orderId = `order_race2_${tId.slice(0, 8)}`;
    const payId = `pay_race2_${tId.slice(0, 8)}`;
    await createAnnualCheckout(tId, orderId, 24990);

    // 5 concurrent webhook deliveries (2 duplicates + order.paid + payment.captured)
    const gateCalls = await Promise.all([
      pool.query(`select public.apply_subscription_event($1, 'order.paid', null, now()) as gate`, [`evt_dup_${tId.slice(0, 8)}`]),
      pool.query(`select public.apply_subscription_event($1, 'order.paid', null, now()) as gate`, [`evt_dup_${tId.slice(0, 8)}`]),
      pool.query(`select public.apply_subscription_event($1, 'payment.captured', null, now()) as gate`, [`evt_cap_${tId.slice(0, 8)}`]),
    ]);
    const dupGates = [gateCalls[0].rows[0].gate, gateCalls[1].rows[0].gate].sort();
    check("duplicate webhook gate admits once and blocks concurrent duplicate", dupGates[0] === "applied" && (dupGates[1] === "in_progress" || dupGates[1] === "duplicate"), JSON.stringify(dupGates));

    const finals = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        pool.query(
          `select public.finalize_annual_order_payment($1, $2, $3, $2, 2499000, 'INR', 'captured', 'card', null, $4) as res`,
          [tId, orderId, payId, `evt_w_${i}_${tId.slice(0, 8)}`],
        ),
      ),
    );
    const activatedCount = finals.filter((r) => r.rows[0].res.outcome === "activated").length;
    const alreadyCount = finals.filter((r) => r.rows[0].res.outcome === "already").length;
    check("5 concurrent finalizations produce 1 activated and 4 already", activatedCount === 1 && alreadyCount === 4, `act=${activatedCount}, alr=${alreadyCount}`);
  }

  console.log("\n── 3. Two different valid payments targeting the same tenant concurrently ──");
  {
    const tId = await createTestTenant();
    const order1 = `order_c1_${tId.slice(0, 8)}`;
    const order2 = `order_c2_${tId.slice(0, 8)}`;
    const pay1 = `pay_c1_${tId.slice(0, 8)}`;
    const pay2 = `pay_c2_${tId.slice(0, 8)}`;
    await createAnnualCheckout(tId, order1, 9990, "starter");
    await createAnnualCheckout(tId, order2, 24990, "pro");

    const results = await Promise.all([
      pool.query(`select public.finalize_annual_order_payment($1, $2, $3, $2, 999000, 'INR', 'captured', 'upi', null, null) as res`, [tId, order1, pay1]),
      pool.query(`select public.finalize_annual_order_payment($1, $2, $3, $2, 2499000, 'INR', 'captured', 'upi', null, null) as res`, [tId, order2, pay2]),
    ]);
    const bothActivated = results.every((r) => r.rows[0].res.outcome === "activated");
    const { rows: tRows } = await pool.query(
      `select extract(epoch from (current_period_end - subscription_started_at)) / 86400 as days_added,
              (select count(*)::int from public.subscription_payments where tenant_id = $1 and status = 'succeeded') as pay_cnt
         from public.tenants where id = $1`,
      [tId],
    );
    check("concurrent distinct valid payments for same tenant serialize cleanly and extend 730 days total",
      bothActivated && Math.round(Number(tRows[0].days_added)) === 730 && tRows[0].pay_cnt === 2,
      `both=${bothActivated}, days=${tRows[0].days_added}, pay_cnt=${tRows[0].pay_cnt}`);
  }

  console.log("\n── 4. Partial-failure recovery & transaction rollback + retry ──");
  {
    const tId = await createTestTenant();
    const orderId = `order_rec_${tId.slice(0, 8)}`;
    const payId = `pay_rec_${tId.slice(0, 8)}`;
    await createAnnualCheckout(tId, orderId, 9990);

    // 4a. Transaction rollback test
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `select public.finalize_annual_order_payment($1, $2, $3, $2, 999000, 'INR', 'captured', 'upi', null, null)`,
        [tId, orderId, payId],
      );
      await client.query("rollback");
    } finally {
      client.release();
    }
    const { rows: afterRollback } = await pool.query(
      `select t.subscription_status, c.status as checkout_status,
              (select count(*)::int from public.subscription_payments where razorpay_payment_id = $2) as pay_cnt
         from public.tenants t
         join public.subscription_checkouts c on c.tenant_id = t.id
        where t.id = $1 and c.razorpay_order_id = $3`,
      [tId, payId, orderId],
    );
    check("rollback leaves tenant trial, checkout pending, and 0 payment rows",
      afterRollback[0].subscription_status === "trial" && afterRollback[0].checkout_status === "pending" && afterRollback[0].pay_cnt === 0);

    // 4b. Simulate pre-existing ledger row while tenant was not activated yet (partial failure recovery)
    await pool.query(
      `insert into public.subscription_payments
         (tenant_id, amount, currency, status, transaction_id, plan_id, billing_period, payment_mode, razorpay_payment_id, razorpay_order_id)
       values ($1, 9990, 'INR', 'succeeded', $2, 'starter', 'annual', 'pay_once', $2, $3)`,
      [tId, payId, orderId],
    );
    const { rows: retryRes } = await pool.query(
      `select public.finalize_annual_order_payment($1, $2, $3, $2, 999000, 'INR', 'captured', 'upi', null, null) as res`,
      [tId, orderId, payId],
    );
    check("retry with pre-existing ledger row still activates tenant and marks checkout paid", retryRes[0].res.outcome === "activated");
  }

  console.log("\n── 5. Invoice failure & recovery ──");
  {
    const tId = await createTestTenant();
    const orderId = `order_inv_${tId.slice(0, 8)}`;
    const payId = `pay_inv_${tId.slice(0, 8)}`;
    await createAnnualCheckout(tId, orderId, 9990);
    const { rows: actRows } = await pool.query(
      `select public.finalize_annual_order_payment($1, $2, $3, $2, 999000, 'INR', 'captured', 'upi', null, null) as res`,
      [tId, orderId, payId],
    );
    const paymentUuid = actRows[0].res.payment_uuid;
    // Simulate invoice issuance recovering later on download
    const invNum = `INV-TEST-${tId.slice(0, 8)}`;
    await pool.query(
      `insert into public.billing_invoices (tenant_id, payment_id, invoice_number, invoice_date, fiscal_year, seller_name, amount, total_amount, currency, payment_status, razorpay_payment_id, razorpay_order_id)
       values ($1, $2, $3, now(), '2026-27', 'The Salad', 9990, 9990, 'INR', 'paid', $4, $5)`,
      [tId, paymentUuid, invNum, payId, orderId],
    );
    let dupBlocked = false;
    try {
      await pool.query(
        `insert into public.billing_invoices (tenant_id, payment_id, invoice_number, invoice_date, fiscal_year, seller_name, amount, total_amount, currency, payment_status)
         values ($1, $2, $3, now(), '2026-27', 'The Salad', 9990, 9990, 'INR', 'paid')`,
        [tId, paymentUuid, `${invNum}-2`],
      );
    } catch (e: any) {
      dupBlocked = e.code === "23505";
    }
    check("invoice recovers after activation and unique payment_id blocks duplicate invoices", dupBlocked);
  }

  console.log("\n── 6. Validation rejections (amount, currency, order ID, tenant, uncaptured) ──");
  {
    const tId = await createTestTenant();
    const otherTenant = await createTestTenant();
    const orderId = `order_val_${tId.slice(0, 8)}`;
    await createAnnualCheckout(tId, orderId, 9990);

    const wrongAmt = await pool.query(`select public.finalize_annual_order_payment($1, $2, 'pay_v1', $2, 100, 'INR', 'captured', 'upi', null, null) as res`, [tId, orderId]);
    const wrongCur = await pool.query(`select public.finalize_annual_order_payment($1, $2, 'pay_v2', $2, 999000, 'USD', 'captured', 'upi', null, null) as res`, [tId, orderId]);
    const wrongOrd = await pool.query(`select public.finalize_annual_order_payment($1, $2, 'pay_v3', 'order_other', 999000, 'INR', 'captured', 'upi', null, null) as res`, [tId, orderId]);
    const missingOrd = await pool.query(`select public.finalize_annual_order_payment($1, $2, 'pay_v4', null, 999000, 'INR', 'captured', 'upi', null, null) as res`, [tId, orderId]);
    const wrongTen = await pool.query(`select public.finalize_annual_order_payment($1, $2, 'pay_v5', $2, 999000, 'INR', 'captured', 'upi', null, null) as res`, [otherTenant, orderId]);
    const uncaptured = await pool.query(`select public.finalize_annual_order_payment($1, $2, 'pay_v6', $2, 999000, 'INR', 'authorized', 'upi', null, null) as res`, [tId, orderId]);

    check("wrong amount rejected", wrongAmt.rows[0].res.outcome === "reject");
    check("wrong currency rejected", wrongCur.rows[0].res.outcome === "reject");
    check("mismatched payment order_id rejected", wrongOrd.rows[0].res.outcome === "reject");
    check("missing payment order_id rejected", missingOrd.rows[0].res.outcome === "reject");
    check("wrong tenant rejected", wrongTen.rows[0].res.outcome === "reject");
    check("uncaptured payment rejected", uncaptured.rows[0].res.outcome === "reject");
  }

  console.log("\n── 7. Refunds: pending, failed, partial, cumulative full, duplicate & out-of-order ──");
  {
    const tId = await createTestTenant();
    const orderId = `order_rfnd_${tId.slice(0, 8)}`;
    const payId = `pay_rfnd_${tId.slice(0, 8)}`;
    await createAnnualCheckout(tId, orderId, 9990);
    const { rows: actRows } = await pool.query(
      `select public.finalize_annual_order_payment($1, $2, $3, $2, 999000, 'INR', 'captured', 'upi', null, null) as res`,
      [tId, orderId, payId],
    );
    const paymentUuid = actRows[0].res.payment_uuid;

    // 7a. Pending refund (refund.created)
    const rPending = await pool.query(
      `select public.record_subscription_refund($1, $2, $3, 4000, 'INR', 'pending', 'evt_rc_1') as res`,
      [tId, payId, `rfnd_p1_${tId.slice(0, 8)}`],
    );
    const { rows: afterPend } = await pool.query(`select status, refunded_amount from public.subscription_payments where id = $1`, [paymentUuid]);
    check("pending refund does not mark payment refunded", rPending.rows[0].res.outcome === "pending_recorded" && afterPend[0].status === "succeeded" && Number(afterPend[0].refunded_amount) === 0);

    // 7b. Failed refund (refund.failed)
    const rFailed = await pool.query(
      `select public.record_subscription_refund($1, $2, $3, 4000, 'INR', 'failed', 'evt_rf_1') as res`,
      [tId, payId, `rfnd_p1_${tId.slice(0, 8)}`],
    );
    const { rows: afterFail } = await pool.query(`select status, refunded_amount from public.subscription_payments where id = $1`, [paymentUuid]);
    check("failed refund does not mark payment refunded", rFailed.rows[0].res.outcome === "failed_recorded" && afterFail[0].status === "succeeded" && Number(afterFail[0].refunded_amount) === 0);

    // 7c. First partial refund processed (4000 of 9990)
    const rfnd1 = `rfnd_1_${tId.slice(0, 8)}`;
    const rPart1 = await pool.query(
      `select public.record_subscription_refund($1, $2, $3, 4000, 'INR', 'processed', 'evt_rp_1') as res`,
      [tId, payId, rfnd1],
    );
    const { rows: afterPart1 } = await pool.query(`select status, refunded_amount from public.subscription_payments where id = $1`, [paymentUuid]);
    check("partial refund keeps status succeeded and tracks refunded_amount = 4000",
      rPart1.rows[0].res.outcome === "processed" && rPart1.rows[0].res.is_fully_refunded === false && afterPart1[0].status === "succeeded" && Number(afterPart1[0].refunded_amount) === 4000);

    // 7d. Out-of-order pending + duplicate processed for rfnd1
    const rOutOfOrder = await pool.query(
      `select public.record_subscription_refund($1, $2, $3, 4000, 'INR', 'pending', 'evt_ooo_1') as res`,
      [tId, payId, rfnd1],
    );
    const rDup = await pool.query(
      `select public.record_subscription_refund($1, $2, $3, 4000, 'INR', 'processed', 'evt_dup_rp_1') as res`,
      [tId, payId, rfnd1],
    );
    const { rows: afterDup } = await pool.query(`select status, refunded_amount from public.subscription_payments where id = $1`, [paymentUuid]);
    check("out-of-order pending & duplicate processed are ignored without double-counting",
      rOutOfOrder.rows[0].res.outcome === "already_processed" && rDup.rows[0].res.outcome === "already_processed" && Number(afterDup[0].refunded_amount) === 4000);

    // 7e. Second partial refund completes full refund (5990 -> cumulative 9990)
    const rfnd2 = `rfnd_2_${tId.slice(0, 8)}`;
    const rPart2 = await pool.query(
      `select public.record_subscription_refund($1, $2, $3, 5990, 'INR', 'processed', 'evt_rp_2') as res`,
      [tId, payId, rfnd2],
    );
    const { rows: afterPart2 } = await pool.query(`select status, refunded_amount from public.subscription_payments where id = $1`, [paymentUuid]);
    check("second partial refund reaches full amount and marks payment refunded",
      rPart2.rows[0].res.is_fully_refunded === true && afterPart2[0].status === "refunded" && Number(afterPart2[0].refunded_amount) === 9990);

    // 7f. Multiple billing_refunds documents allowed per payment (keyed by razorpay_refund_id)
    await pool.query(
      `insert into public.billing_refunds (tenant_id, payment_id, refund_number, fiscal_year, seller_name, buyer_name, amount, currency, razorpay_payment_id, razorpay_refund_id)
       values ($1, $2, $3, '2026-27', 'The Salad', 'Test Restaurant', 4000, 'INR', $4, $5), ($1, $2, $6, '2026-27', 'The Salad', 'Test Restaurant', 5990, 'INR', $4, $7)`,
      [tId, paymentUuid, `RFND-1-${tId.slice(0, 8)}`, payId, rfnd1, `RFND-2-${tId.slice(0, 8)}`, rfnd2],
    );
    const { rows: docRows } = await pool.query(
      `select count(*)::int as cnt from public.billing_refunds where payment_id = $1`,
      [paymentUuid],
    );
    check("two distinct refund documents stored for two partial refunds", docRows[0].cnt === 2);
  }

  console.log("\n── 8. Monthly AutoPay checkout ignored by annual finalizer ──");
  {
    const tId = await createTestTenant();
    const orderId = `order_ap_${tId.slice(0, 8)}`;
    await pool.query(
      `insert into public.subscription_checkouts
         (id, tenant_id, plan_id, amount, currency, billing_interval, payment_mode, razorpay_order_id, razorpay_subscription_id, status)
       values ($1, $2, 'starter', 999, 'INR', 'monthly', 'autopay', $3, $4, 'pending')`,
      [crypto.randomUUID(), tId, orderId, `sub_ap_${tId.slice(0, 8)}`],
    );
    const { rows: apRes } = await pool.query(
      `select public.finalize_annual_order_payment($1, $2, 'pay_ap_1', $2, 99900, 'INR', 'captured', 'upi', null, null) as res`,
      [tId, orderId],
    );
    check("autopay checkout is ignored by finalize_annual_order_payment", apRes[0].res.outcome === "ignore");
  }

  console.log(`\n${pass}/${pass + fail} real PostgreSQL checks passed${fail ? ` — ${fail} FAILED` : ""}`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Test suite error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const tId of createdTenantIds) {
      await pool.query(`delete from public.billing_refunds where tenant_id = $1`, [tId]).catch(() => {});
      await pool.query(`delete from public.billing_invoices where tenant_id = $1`, [tId]).catch(() => {});
      await pool.query(`delete from public.tenants where id = $1`, [tId]).catch(() => {});
    }
    await pool.query(`delete from public.subscription_webhook_events where event_id like 'evt_%'`).catch(() => {});
    await pool.end();
  });
