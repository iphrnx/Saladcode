// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sanitizeMenuTags } from "../_shared/menu-tags.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { MENU_THEME_KEY, normaliseMenuTheme } from "../_shared/menu-theme.ts";
import { DEFAULT_ROLES } from "../_shared/permissions.ts";
import { trialFields } from "../_shared/plans.ts";
import { body, json, preflight } from "../_shared/http.ts";
import { ONBOARDING_DRAFT_KEY } from "../_shared/settings-keys.ts";
import { effectiveDishBasePrice, normalizeStoredPortions } from "../_shared/portions.ts";

/**
 * /functions/v1/onboarding  (POST, owner session with settings.manage)
 *   Body: { restaurant, categories, menuItems, tables }
 *
 * Persists the restaurant details, categories, menu items, tables and default
 * roles/settings for the signed-in owner's tenant, then marks onboarding done.
 *
 * The tenant is always derived from the session — never from the request body.
 */

/** Default system roles seeded for every new tenant. */
/** Default settings seeded for a freshly onboarded restaurant. */
const DEFAULT_SETTINGS: Record<string, string> = {
  bill_footer: "Thank you for dining with us.",
  terms: "Prices inclusive of applicable taxes unless stated.",
};

/**
 * The setup draft, mirrored server-side so progress survives the email
 * confirmation gap and the device boundary. The browser draft in localStorage
 * is still the primary — this is the copy that lets a owner who confirms on
 * their phone and opens the laptop land on the exact step they stopped at.
 */

/** A settings value is a text column; a draft with photos can be large. */
const MAX_DRAFT_CHARS = 200_000;

/**
 * Drop the base64 images (the logo, extracted dish photos) from a draft that
 * is too large to store. The text — the part that took the owner real typing —
 * survives; the photos are re-addable, and the browser draft on the device
 * that had them keeps them anyway.
 */
function trimDraftImages(draft: Record<string, any>): void {
  if (draft.restaurant) draft.restaurant.logo = "";
  if (Array.isArray(draft.menu?.categories)) {
    draft.menu.categories = draft.menu.categories.map((c: any) => ({
      ...c,
      items: Array.isArray(c.items)
        ? c.items.map(({ image: _image, ...rest }: any) => rest)
        : c.items,
    }));
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "restaurant"
  );
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    // Authenticate first so an anonymous request of *any* method fails closed
    // with 401 rather than leaking that only POST is routed.
    //
    // This was authenticated but ungated, which is not the same thing. A POST
    // rewrites the restaurant's profile, its settings, its categories, its menu
    // and its tables — every one of which is gated elsewhere — and marks setup
    // complete. So any staff PIN could rewrite the menu and finish setup for the
    // tenant. It is the owner's flow: the wizard is only reachable from the
    // owner shell, and the draft it resumes belongs to the owner who started it.
    // `settings.manage` is the key that already governs the settings it writes.
    const g = await guard(req, { permission: "settings.manage" });
    if (!g.ok) return g.response;
    if (g.session.kind !== "owner") {
      return json(req, { error: "Forbidden", required: "owner" }, 403);
    }

    const db = admin();

    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("*")
      .eq("id", g.session.subjectId)
      .maybeSingle();
    if (profileError) return json(req, { error: profileError.message }, 500);

    // Resolve (or create) the tenant this owner belongs to. The session already
    // carries the tenant, so no client-supplied id is ever trusted.
    let tenantId: string | null = g.session.tenantId ?? profile?.tenant_id ?? null;

    // GET — the saved draft, so a fresh browser resumes where the owner left
    // off rather than at step 1.
    if (req.method === "GET") {
      if (!tenantId) return json(req, { draft: null });
      const { data: row, error } = await db
        .from("settings")
        .select("value")
        .eq("tenant_id", tenantId)
        .eq("key", ONBOARDING_DRAFT_KEY)
        .maybeSingle();
      if (error) return json(req, { error: error.message }, 500);
      if (!row?.value) return json(req, { draft: null });
      try {
        return json(req, { draft: JSON.parse(row.value) });
      } catch {
        // A draft that cannot be parsed is no draft at all.
        return json(req, { draft: null });
      }
    }

    // PUT — save the draft. Fire-and-forget from the client; best effort here.
    if (req.method === "PUT") {
      if (!tenantId) {
        return json(req, { error: "No restaurant to attach this draft to yet" }, 409);
      }
      const b = await body(req);
      const draft = (b as any)?.draft;
      if (
        !draft || typeof draft !== "object" || Array.isArray(draft) ||
        typeof draft.step !== "number"
      ) {
        return json(req, { error: "A draft with its step is required" }, 400);
      }
      let serialized = JSON.stringify(draft);
      if (serialized.length > MAX_DRAFT_CHARS) {
        trimDraftImages(draft);
        serialized = JSON.stringify(draft);
      }
      if (serialized.length > MAX_DRAFT_CHARS) {
        return json(req, { error: "Draft too large to save" }, 413);
      }
      const { error } = await db
        .from("settings")
        .upsert(
          { tenant_id: tenantId, key: ONBOARDING_DRAFT_KEY, value: serialized },
          { onConflict: "tenant_id,key" },
        );
      if (error) return json(req, { error: error.message }, 500);
      return json(req, { ok: true });
    }

    if (req.method !== "POST") {
      return json(req, { error: "Method not allowed" }, 405);
    }

    const b = await body(req);
    const { restaurant, categories, menuItems, tables } = b as any;
    // Dishes that could not be saved because no price was ever readable for
    // them — reported in the response, never written as ₹0 rows.
    const skippedItems: string[] = [];

    if (!tenantId) {
      const cleanName = String(
        restaurant?.name || g.session.email || "My Restaurant",
      ).trim();
      const baseSlug = slugify(cleanName);
      let slug = baseSlug;
      for (let i = 0; i < 5; i++) {
        const { data: existing, error } = await db
          .from("tenants")
          .select("id")
          .eq("slug", slug)
          .maybeSingle();
        if (error) return json(req, { error: error.message }, 500);
        if (!existing) break;
        slug = `${baseSlug}-${Math.random().toString(36).substring(2, 7)}`;
      }

      // The trial is a full trial, so it carries the trial plan, and it runs
      // for the plan's configured trial days from the moment the restaurant
      // was created. The length comes from the catalogue, not from a number
      // written here — the same helper the registration path uses, so the two
      // cannot drift apart.
      const trial = await trialFields();
      const { data: tenant, error: tenantError } = await db
        .from("tenants")
        .insert({
          name: cleanName,
          slug,
          plan: "pro",
          ...trial,
          // India-first, matching the registration path and the only currency
          // the setup flow offers. This pair used to read USD with a ₹ symbol.
          currency: "INR",
          currency_symbol: "₹",
          active: true,
        })
        .select()
        .single();
      if (tenantError) return json(req, { error: tenantError.message }, 500);
      tenantId = tenant.id;
    }

    // 1. Update the tenant's profile fields.
    if (restaurant) {
      const updateData: Record<string, any> = {};
      if (restaurant.name) updateData.name = restaurant.name;
      if (restaurant.tagline) updateData.tagline = restaurant.tagline;
      if (restaurant.phone) updateData.phone = restaurant.phone;
      if (restaurant.email) updateData.email = restaurant.email;
      if (restaurant.address) updateData.address = restaurant.address;
      if (restaurant.currency) updateData.currency = restaurant.currency;
      if (restaurant.currencySymbol) updateData.currency_symbol = restaurant.currencySymbol;
      if (typeof restaurant.taxRate === "number") updateData.tax_rate = restaurant.taxRate;
      if (typeof restaurant.serviceCharge === "number") {
        updateData.service_charge = restaurant.serviceCharge;
      }
      if (restaurant.logo) updateData.logo = restaurant.logo;

      if (Object.keys(updateData).length > 0) {
        const { error } = await db.from("tenants").update(updateData).eq("id", tenantId);
        if (error) return json(req, { error: error.message }, 500);
      }
    }

    // 2. Seed the default system roles (idempotent).
    const { error: rolesError } = await db.from("roles").upsert(
      DEFAULT_ROLES.map((r) => ({ ...r, tenant_id: tenantId })),
      { onConflict: "tenant_id,name" },
    );
    if (rolesError) return json(req, { error: rolesError.message }, 500);

    // 3. Seed default settings (idempotent).
    //
    // The tax IDs typed during setup belong here: they are settings keys, not
    // tenant columns. They used to be collected by the onboarding form and then
    // dropped on the floor — the payload never carried them and this function
    // had no field for them — so a restaurant that entered its GSTIN at setup
    // ended up with an empty one, and its bills printed with no tax ID at all.
    // Only written when actually provided, so an empty field can never blank a
    // value the owner set later in Settings.
    const settingsSeed: Record<string, string> = { ...DEFAULT_SETTINGS };
    if (restaurant?.gstin) settingsSeed.gstin = String(restaurant.gstin).trim();
    if (restaurant?.fssai) settingsSeed.fssai = String(restaurant.fssai).trim();
    if (restaurant?.autoAcceptOrders !== undefined) {
      settingsSeed.auto_accept_orders = String(Boolean(restaurant.autoAcceptOrders));
    }
    if (restaurant?.autoBillPrint !== undefined) {
      settingsSeed.auto_bill_print = String(Boolean(restaurant.autoBillPrint));
    }
    // The customer menu's theme. It used to be collected on the setup form
    // and never sent, so the menu looked the same for every restaurant.
    settingsSeed[MENU_THEME_KEY] = normaliseMenuTheme(restaurant?.menuTheme);

    const { error: settingsError } = await db.from("settings").upsert(
      Object.entries(settingsSeed).map(([key, value]) => ({
        tenant_id: tenantId,
        key,
        value,
      })),
      { onConflict: "tenant_id,key" },
    );
    if (settingsError) return json(req, { error: settingsError.message }, 500);

    // 4. Insert categories & menu items.
    if (Array.isArray(categories) && categories.length > 0) {
      const categoryMap = new Map<string, string>();

      // Everything here is batched: one lookup and one insert for the whole
      // menu, instead of a round trip per category and per dish. A forty-dish
      // menu used to make about ninety sequential round trips, which is what
      // kept the setup button reading "Saving…" for tens of seconds.
      const catNames = categories
        .map((c: any) => String(c?.name ?? "").trim())
        .filter(Boolean);
      const { data: existingCats, error: catLookupError } = catNames.length
        ? await db
            .from("categories")
            .select("id, name")
            .eq("tenant_id", tenantId)
            .in("name", catNames)
        : { data: [], error: null };
      if (catLookupError) return json(req, { error: catLookupError.message }, 500);

      const catIdByName = new Map<string, string>(
        ((existingCats ?? []) as any[]).map((c) => [c.name, c.id]),
      );

      // A name repeated inside the payload is created once, exactly as the
      // old per-category lookup made it behave.
      const newCats: { name: string; sortOrder: number }[] = [];
      categories.forEach((cat: any, i: number) => {
        const name = String(cat?.name ?? "").trim();
        if (!name || catIdByName.has(name)) return;
        if (newCats.some((c) => c.name === name)) return;
        newCats.push({ name, sortOrder: i });
      });
      if (newCats.length > 0) {
        const { data: createdCats, error } = await db
          .from("categories")
          .insert(newCats.map((c) => ({ tenant_id: tenantId, name: c.name, sort_order: c.sortOrder })))
          .select("id, name");
        if (error) return json(req, { error: error.message }, 500);
        for (const c of (createdCats ?? []) as any[]) catIdByName.set(c.name, c.id);
      }

      // The payload's own ids and names both have to lead to the database id:
      // the AI extractor supplies a name, the setup wizard a client-side id.
      for (const cat of categories as any[]) {
        const dbId = catIdByName.get(String(cat?.name ?? "").trim());
        if (!dbId) continue;
        if (cat.id) categoryMap.set(String(cat.id), dbId);
        categoryMap.set(String(cat?.name ?? "").toLowerCase(), dbId);
      }

      if (Array.isArray(menuItems) && menuItems.length > 0) {
        const firstCatId = Array.from(categoryMap.values())[0];
        // One lookup of the tenant's existing item names — compared
        // case-insensitively, because "Paneer Tikka" and "paneer tikka" are
        // the same dish and must never both land in the menu.
        const { data: existingItems, error: itemLookupError } = await db
          .from("menu_items")
          .select("name")
          .eq("tenant_id", tenantId);
        if (itemLookupError) return json(req, { error: itemLookupError.message }, 500);

        // Names already in the database — and names repeated in this payload —
        // are skipped, which is what the per-item lookup used to achieve.
        const knownNames = new Set<string>(
          ((existingItems ?? []) as any[]).map((r) => String(r.name).toLowerCase()),
        );
        const itemRows: Record<string, any>[] = [];
        menuItems.forEach((item: any, i: number) => {
          const name = String(item?.name ?? "").trim();
          if (!name || knownNames.has(name.toLowerCase())) return;

          const catDbId =
            (item.categoryId ? categoryMap.get(String(item.categoryId)) : null) ||
            (item.category ? categoryMap.get(String(item.category).toLowerCase()) : null) ||
            firstCatId;
          if (!catDbId) return;
          knownNames.add(name.toLowerCase());

          // Scanner tags are validated here too, not only in the extractor:
          // this endpoint is the door the dishes actually save through.
          const tagList: string[] = sanitizeMenuTags(item.tags);
          if (item.veg && !tagList.includes("VEG")) tagList.push("VEG");

          // Portion options extracted from the menu photo (Quarter/Half/Full…),
          // each with its own price. Entries without a readable price are
          // dropped rather than guessed — the same rule the extractor applies.
          const portions = normalizeStoredPortions(item.variants ?? item.portions);
          const rawPrice = Number(item?.price);
          const hasReadablePrice = Number.isFinite(rawPrice) && rawPrice > 0;

          // A dish with no readable price anywhere — not on itself, not on a
          // portion — cannot go on the menu: the menu_items price column is
          // NOT NULL, so it would be saved as ₹0 and ordered at ₹0. Skip it
          // and report it; the preview is where its price gets typed in.
          if (!hasReadablePrice && !portions) {
            skippedItems.push(name);
            return;
          }

          const resolvedPrice = effectiveDishBasePrice(item.price, portions);

          itemRows.push({
            tenant_id: tenantId,
            category_id: catDbId,
            name,
            description: item.description || null,
            price: resolvedPrice,
            available: true,
            sort_order: i,
            image: item.image || null,
            tags: tagList.join(","),
            portions,
          });
        });

        if (itemRows.length > 0) {
          const { error } = await db.from("menu_items").insert(itemRows);
          if (error) return json(req, { error: error.message }, 500);
        }
      }
    }

    // 5. Create tables.
    const tableCount = typeof tables === "number" ? tables : 8;
    const { count: existingTableCount, error: tableCountError } = await db
      .from("tables")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId);
    if (tableCountError) return json(req, { error: tableCountError.message }, 500);

    if ((existingTableCount ?? 0) === 0 && tableCount > 0) {
      const rows: Record<string, any>[] = [];
      for (let i = 1; i <= tableCount; i++) {
        const bytes = new Uint8Array(9);
        crypto.getRandomValues(bytes);
        const token = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
        rows.push({
          tenant_id: tenantId,
          name: `Table ${i}`,
          seats: 4,
          area: "Main Hall",
          qr_token: token,
          active: true,
        });
      }
      const { error } = await db.from("tables").insert(rows);
      if (error) return json(req, { error: error.message }, 500);
    }

    // 6. Mark onboarding complete.
    const { error: onboardingError } = await db
      .from("tenants")
      .update({ onboarding_done: true })
      .eq("id", tenantId);
    if (onboardingError) return json(req, { error: onboardingError.message }, 500);

    // The draft is obsolete the moment setup completes — a saved draft is what
    // routes an owner back into the wizard, so leaving it behind would bounce
    // a finished restaurant back into setup on every dashboard load.
    const { error: draftClearError } = await db
      .from("settings")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("key", ONBOARDING_DRAFT_KEY);
    if (draftClearError) {
      console.error("onboarding: could not clear the saved draft", draftClearError.message);
    }

    // 7. Link the current auth user's profile to the tenant (upsert on id).
    //
    // The name typed in the setup flow wins, so what the owner sees in the
    // form is what the account carries. It is only written when it was
    // actually filled in, so an empty field can never blank a name that is
    // already set.
    const typedOwnerName =
      typeof restaurant?.ownerName === "string" ? restaurant.ownerName.trim() : "";
    const { error: linkError } = await db.from("profiles").upsert(
      {
        id: g.session.subjectId,
        tenant_id: tenantId,
        // Always the authenticated address, never whatever the profile row
        // currently says — the copy must not drift from the thing that proves
        // it, and a stale profile cannot become the source of truth.
        email: g.session.email || profile?.email,
        name:
          typedOwnerName ||
          profile?.name ||
          g.session.name ||
          String(restaurant?.name || "Owner"),
      },
      { onConflict: "id" },
    );
    if (linkError) return json(req, { error: linkError.message }, 500);

    return json(req, {
      success: true,
      tenantId,
      // Names of dishes that were not imported because no price was readable
      // anywhere for them. The preview normally prevents this — a non-empty
      // list means the owner approved items whose price was still missing.
      skippedItems: skippedItems.length > 0 ? skippedItems : undefined,
    });
  } catch (error: any) {
    console.error("Onboarding complete error:", error);
    return json(req, { error: error.message || "Failed to complete onboarding" }, 500);
  }
});
