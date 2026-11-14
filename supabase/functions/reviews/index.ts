// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { body, json, preflight, subPath } from "../_shared/http.ts";

/**
 * /functions/v1/reviews
 *   POST   /               submit a customer review (diner session validation)
 *   GET    /               list reviews and stats for the caller's restaurant (orders.view)
 *   POST   /respond        reply to a review (settings.view | orders.create)
 *   DELETE /:id            delete a review (orders.manage)
 *
 * Internal review system:
 * - Proper RLS and restaurant-level data isolation
 * - Session validation: requires a valid table session token
 * - Duplicate-submission prevention: at most one review per table session
 * - 1-5 star ratings and optional customer feedback
 */

function mapReview(r: any) {
  const table = Array.isArray(r.table) ? r.table[0] : r.table;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tableId: r.table_id,
    tableSessionId: r.table_session_id,
    orderId: r.order_id,
    rating: r.rating,
    authorName: r.author_name || "Guest",
    comment: r.comment || null,
    tags: r.tags || null,
    reply: r.reply || null,
    replyAt: r.reply_at || null,
    createdAt: r.created_at,
    tableName: table?.name ?? null,
    tableArea: table?.area ?? null,
    table: table
      ? {
          id: table.id,
          name: table.name,
          seats: table.seats,
          area: table.area,
        }
      : null,
  };
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const segments = subPath(req, "reviews");

  switch (req.method) {
    case "POST": {
      if (segments[0] === "respond") {
        return await respond(req);
      }
      return await create(req);
    }
    case "GET":
      return await list(req);
    case "DELETE": {
      const reviewId = segments[0];
      return await remove(req, reviewId);
    }
    default:
      return json(req, { error: "Method not allowed" }, 405);
  }
});

async function create(req: Request): Promise<Response> {
  try {
    const b = await body(req);

    // 1. Session validation
    const sessionToken = (typeof b.tableSessionToken === "string" && b.tableSessionToken.trim()) ||
                         (typeof b.sessionToken === "string" && b.sessionToken.trim()) ||
                         null;

    if (!sessionToken) {
      return json(req, { error: "Table session token is required to submit a review." }, 400);
    }

    // Verify session in database
    const { data: sessionRow, error: sessionErr } = await admin()
      .from("table_sessions")
      .select("id, tenant_id, table_id, status")
      .eq("token", sessionToken)
      .maybeSingle();

    if (sessionErr || !sessionRow) {
      return json(req, { error: "Invalid table session. Please scan your table QR code." }, 401);
    }

    const tenantId = sessionRow.tenant_id;
    const tableId = sessionRow.table_id;
    const sessionId = sessionRow.id;

    // The owner can turn review collection off. The session-end page hides
    // the form in that case; this is the server-side gate that keeps a
    // replayed or stale form from slipping a review in anyway.
    const { data: enabledRow } = await admin()
      .from("settings")
      .select("value")
      .eq("tenant_id", tenantId)
      .eq("key", "reviews_enabled")
      .maybeSingle();
    if (enabledRow?.value === "false") {
      return json(req, { error: "This restaurant is not collecting reviews right now." }, 403);
    }

    // Check if client passed mismatched tenant
    if (b.tenantId && b.tenantId !== tenantId) {
      return json(req, { error: "Session does not match restaurant." }, 403);
    }

    // 2. Duplicate submission prevention
    const { data: existingReview } = await admin()
      .from("customer_reviews")
      .select("id")
      .eq("table_session_id", sessionId)
      .maybeSingle();

    if (existingReview) {
      return json(req, { error: "A review has already been submitted for this table session." }, 409);
    }

    // 3. Rating validation: 1 to 5 stars
    const rawRating = Number(b.rating);
    if (!Number.isInteger(rawRating) || rawRating < 1 || rawRating > 5) {
      return json(req, { error: "Rating must be an integer between 1 and 5 stars." }, 400);
    }
    const rating = rawRating;

    // 4. Optional feedback and author name
    const authorName = typeof b.authorName === "string" && b.authorName.trim()
      ? b.authorName.trim().slice(0, 100)
      : "Guest";
    const comment = typeof b.comment === "string" && b.comment.trim()
      ? b.comment.trim().slice(0, 1000)
      : null;
    const tags: string[] = Array.isArray(b.tags)
      ? b.tags
          .map((t: any) => (typeof t === "string" ? t.trim() : ""))
          .filter(Boolean)
          .slice(0, 10)
      : typeof b.tags === "string" && b.tags.trim()
      ? [b.tags.trim().slice(0, 50)]
      : [];

    // 5. Insert review
    const { data: review, error: insertErr } = await admin()
      .from("customer_reviews")
      .insert({
        tenant_id: tenantId,
        table_id: tableId,
        table_session_id: sessionId,
        rating,
        author_name: authorName,
        comment,
        tags,
      })
      .select("*, table:tables(*)")
      .single();

    if (insertErr) {
      // 23505 is PostgreSQL unique_violation code
      if (insertErr.code === "23505") {
        return json(req, { error: "A review has already been submitted for this table session." }, 409);
      }
      console.error("Error inserting review:", insertErr);
      return json(req, { error: insertErr.message }, 500);
    }

    return json(req, { success: true, review: mapReview(review) }, 201);
  } catch (error: any) {
    console.error("Error submitting review:", error);
    return json(req, { error: "Failed to submit review" }, 500);
  }
}

async function list(req: Request): Promise<Response> {
  // Reviews are a Settings feature — the only screen that reads them is
  // Settings → Reviews, which is behind `settings.view`. Guarding the list with
  // `orders.view` meant every role that can see the order book could also read
  // every guest's name and comment, including Kitchen. The key that matches the
  // screen is the key that belongs here.
  const g = await guard(req, { permission: "settings.view" });
  if (!g.ok) return g.response;

  try {
    const tenantId = g.session.tenantId;
    const url = new URL(req.url);
    const ratingParam = url.searchParams.get("rating");
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));

    // Base reviews query for this restaurant
    let query = admin()
      .from("customer_reviews")
      .select("*, table:tables(*)")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (ratingParam) {
      const r = Number(ratingParam);
      if (r >= 1 && r <= 5) {
        query = query.eq("rating", r);
      }
    }

    const { data: reviewsData, error: reviewsErr } = await query;
    if (reviewsErr) {
      console.error("Error fetching reviews:", reviewsErr);
      return json(req, { error: reviewsErr.message }, 500);
    }

    // All reviews for statistics calculation
    const { data: allStatsData, error: statsErr } = await admin()
      .from("customer_reviews")
      .select("id, rating, comment")
      .eq("tenant_id", tenantId);
    if (statsErr) {
      console.error("Error fetching review stats:", statsErr);
      return json(req, { error: statsErr.message }, 500);
    }

    const allReviews = allStatsData ?? [];
    const totalReviews = allReviews.length;
    const sumRatings = allReviews.reduce((sum, r) => sum + (Number(r.rating) || 0), 0);
    const averageRating = totalReviews > 0 ? +(sumRatings / totalReviews).toFixed(1) : 0;
    const distribution = [5, 4, 3, 2, 1].map((stars) => ({
      stars,
      count: allReviews.filter((r) => r.rating === stars).length,
    }));
    const feedbackCount = allReviews.filter((r) => r.comment && r.comment.trim().length > 0).length;

    return json(req, {
      reviews: (reviewsData ?? []).map(mapReview),
      stats: {
        averageRating,
        totalReviews,
        distribution,
        feedbackCount,
      },
    });
  } catch (err: any) {
    console.error("Error in reviews list:", err);
    return json(req, { error: (err as Error)?.message ?? "Unexpected error" }, 500);
  }
}

async function respond(req: Request): Promise<Response> {
  const g = await guard(req, { anyOf: ["settings.view", "orders.create"] });
  if (!g.ok) return g.response;

  try {
    const tenantId = g.session.tenantId;
    const b = await body(req);
    const reviewId = String(b.reviewId || "").trim();
    const reply = typeof b.reply === "string" ? b.reply.trim().slice(0, 1000) : "";

    if (!reviewId) {
      return json(req, { error: "Review ID is required" }, 400);
    }

    const { data: updated, error } = await admin()
      .from("customer_reviews")
      .update({
        reply: reply || null,
        reply_at: reply ? new Date().toISOString() : null,
      })
      .eq("id", reviewId)
      .eq("tenant_id", tenantId)
      .select("*, table:tables(*)")
      .maybeSingle();

    if (error) {
      return json(req, { error: error.message }, 500);
    }
    if (!updated) {
      return json(req, { error: "Review not found" }, 404);
    }

    return json(req, { success: true, review: mapReview(updated) });
  } catch (err: any) {
    return json(req, { error: err.message || "Failed to post reply" }, 500);
  }
}

async function remove(req: Request, reviewId?: string): Promise<Response> {
  const g = await guard(req, { anyOf: ["settings.view", "orders.create"] });
  if (!g.ok) return g.response;

  if (!reviewId) {
    return json(req, { error: "Review ID is required" }, 400);
  }

  try {
    const tenantId = g.session.tenantId;
    const { error } = await admin()
      .from("customer_reviews")
      .delete()
      .eq("id", reviewId)
      .eq("tenant_id", tenantId);

    if (error) return json(req, { error: error.message }, 500);
    return json(req, { success: true });
  } catch (err: any) {
    return json(req, { error: err.message || "Failed to delete review" }, 500);
  }
}
