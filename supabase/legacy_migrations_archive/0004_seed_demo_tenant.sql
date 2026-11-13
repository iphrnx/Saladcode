-- Demo restaurant so the app is not empty on first run.
-- Idempotent: does nothing if the 'jaegar' tenant already exists.
-- Staff PIN for every seeded staff member is 1234.

do $$
declare
  v_tenant   uuid;
  v_owner    uuid;
  v_manager  uuid;
  v_waiter   uuid;
  v_cashier  uuid;
  v_kitchen  uuid;
  v_cat_starters uuid;
  v_cat_mains    uuid;
  v_cat_biryani  uuid;
  v_cat_breads   uuid;
  v_cat_desserts uuid;
  v_cat_drinks   uuid;
begin
  if exists (select 1 from public.tenants where slug = 'jaegar') then
    raise notice 'Demo tenant already present — skipping seed.';
    return;
  end if;

  insert into public.tenants (
    name, slug, tagline, currency, currency_symbol,
    address, phone, email, tax_rate, service_charge, plan, active, onboarding_done
  ) values (
    'Jaegar Resto', 'jaegar', 'Modern Indian Dining',
    'INR', '₹',
    '42 MG Road, Indiranagar, Bengaluru 560038', '+91 80 4123 7788', 'hello@jaegarresto.in',
    5.0, 5.0, 'enterprise', true, true
  ) returning id into v_tenant;

  -- ── Roles ────────────────────────────────────────────────────────────────
  insert into public.roles (tenant_id, name, description, permissions, is_system, color)
  values (v_tenant, 'Owner', 'Full access to everything',
    'dashboard.view,orders.view,orders.manage,orders.refund,menu.view,menu.manage,tables.view,tables.manage,promos.view,promos.manage,analytics.view,qr.manage,settings.view,settings.manage,security.view,security.manage,roles.view,roles.manage,staff.view,staff.manage',
    true, '#ff7e6b') returning id into v_owner;

  insert into public.roles (tenant_id, name, description, permissions, is_system, color)
  values (v_tenant, 'Manager', 'Runs the floor',
    'dashboard.view,orders.view,orders.manage,menu.view,menu.manage,tables.view,tables.manage,promos.view,promos.manage,analytics.view,qr.manage,staff.view',
    true, '#60a5fa') returning id into v_manager;

  insert into public.roles (tenant_id, name, description, permissions, is_system, color)
  values (v_tenant, 'Waiter', 'Takes and serves orders',
    'orders.view,orders.manage,menu.view,tables.view',
    true, '#4ade80') returning id into v_waiter;

  insert into public.roles (tenant_id, name, description, permissions, is_system, color)
  values (v_tenant, 'Cashier', 'Handles billing and payments',
    'orders.view,orders.manage,orders.refund,menu.view,tables.view',
    true, '#fbbf24') returning id into v_cashier;

  insert into public.roles (tenant_id, name, description, permissions, is_system, color)
  values (v_tenant, 'Kitchen', 'Sees and advances the order queue',
    'orders.view,orders.manage,menu.view',
    true, '#c084fc') returning id into v_kitchen;

  -- ── Menu ─────────────────────────────────────────────────────────────────
  insert into public.categories (tenant_id, name, icon, sort_order) values
    (v_tenant, 'Starters',  '🥗', 1) returning id into v_cat_starters;
  insert into public.categories (tenant_id, name, icon, sort_order) values
    (v_tenant, 'Main Course', '🍛', 2) returning id into v_cat_mains;
  insert into public.categories (tenant_id, name, icon, sort_order) values
    (v_tenant, 'Biryani', '🍚', 3) returning id into v_cat_biryani;
  insert into public.categories (tenant_id, name, icon, sort_order) values
    (v_tenant, 'Breads', '🫓', 4) returning id into v_cat_breads;
  insert into public.categories (tenant_id, name, icon, sort_order) values
    (v_tenant, 'Desserts', '🍮', 5) returning id into v_cat_desserts;
  insert into public.categories (tenant_id, name, icon, sort_order) values
    (v_tenant, 'Beverages', '🥤', 6) returning id into v_cat_drinks;

  insert into public.menu_items
    (tenant_id, category_id, name, description, price, available, prep_time, tags, calories, sort_order, rating)
  values
    (v_tenant, v_cat_starters, 'Paneer Tikka', 'Char-grilled cottage cheese, mint chutney', 289, true, 15, 'veg,spicy', 320, 1, 4.7),
    (v_tenant, v_cat_starters, 'Chicken 65', 'Crisp fried chicken, curry leaf, chilli', 329, true, 18, 'spicy,bestseller', 410, 2, 4.8),
    (v_tenant, v_cat_starters, 'Veg Manchurian', 'Indo-Chinese vegetable dumplings in soy glaze', 259, true, 16, 'veg', 290, 3, 4.4),
    (v_tenant, v_cat_starters, 'Tandoori Mushroom', 'Clay-oven mushrooms, yoghurt marinade', 299, true, 17, 'veg,new', 240, 4, 4.5),
    (v_tenant, v_cat_mains, 'Butter Chicken', 'Tandoori chicken in silky tomato-butter gravy', 429, true, 22, 'bestseller', 620, 1, 4.9),
    (v_tenant, v_cat_mains, 'Dal Makhani', 'Black lentils, slow-cooked overnight', 319, true, 20, 'veg', 430, 2, 4.7),
    (v_tenant, v_cat_mains, 'Palak Paneer', 'Cottage cheese in creamed spinach', 349, true, 20, 'veg', 380, 3, 4.6),
    (v_tenant, v_cat_mains, 'Kadai Chicken', 'Chicken tossed with peppers and kadai masala', 399, true, 24, 'spicy', 540, 4, 4.6),
    (v_tenant, v_cat_mains, 'Malai Kofta', 'Paneer dumplings in cashew cream', 359, true, 22, 'veg', 470, 5, 4.5),
    (v_tenant, v_cat_biryani, 'Hyderabadi Chicken Biryani', 'Dum-cooked long grain rice, saffron, raita', 449, true, 30, 'bestseller,spicy', 720, 1, 4.9),
    (v_tenant, v_cat_biryani, 'Lucknowi Mutton Biryani', 'Awadhi-style mutton, gentle spices', 549, true, 35, 'spicy', 810, 2, 4.8),
    (v_tenant, v_cat_biryani, 'Veg Dum Biryani', 'Seasonal vegetables, fried onion, mint', 379, true, 28, 'veg', 610, 3, 4.5),
    (v_tenant, v_cat_breads, 'Garlic Naan', 'Tandoor-baked, garlic butter', 89, true, 8, 'veg', 210, 1, 4.6),
    (v_tenant, v_cat_breads, 'Laccha Paratha', 'Flaky layered whole wheat paratha', 79, true, 8, 'veg', 230, 2, 4.5),
    (v_tenant, v_cat_breads, 'Tandoori Roti', 'Whole wheat, clay oven', 49, true, 6, 'veg', 140, 3, 4.3),
    (v_tenant, v_cat_desserts, 'Gulab Jamun', 'Warm milk dumplings in rose syrup', 149, true, 8, 'veg,bestseller', 320, 1, 4.8),
    (v_tenant, v_cat_desserts, 'Rasmalai', 'Saffron milk, pistachio', 169, true, 8, 'veg', 290, 2, 4.7),
    (v_tenant, v_cat_desserts, 'Gajar Ka Halwa', 'Slow-cooked carrot, ghee, almonds', 179, true, 10, 'veg', 340, 3, 4.6),
    (v_tenant, v_cat_drinks, 'Masala Chai', 'Assam tea, ginger, cardamom', 79, true, 5, 'veg', 90, 1, 4.6),
    (v_tenant, v_cat_drinks, 'Sweet Lassi', 'Thick yoghurt, rose, pistachio', 129, true, 5, 'veg', 210, 2, 4.7),
    (v_tenant, v_cat_drinks, 'Fresh Lime Soda', 'Sweet or salted', 99, true, 4, 'veg,vegan', 60, 3, 4.4),
    (v_tenant, v_cat_drinks, 'Cold Coffee', 'Blended, chocolate drizzle', 159, true, 6, 'veg', 260, 4, 4.5);

  -- ── Tables ───────────────────────────────────────────────────────────────
  insert into public.tables (tenant_id, name, seats, area)
  select v_tenant, 'Table ' || g, 4, 'Main Hall' from generate_series(1, 8) g;
  insert into public.tables (tenant_id, name, seats, area)
  select v_tenant, 'Terrace ' || g, 6, 'Terrace' from generate_series(1, 4) g;
  insert into public.tables (tenant_id, name, seats, area)
  select v_tenant, 'Private ' || g, 8, 'Private Dining' from generate_series(1, 2) g;

  -- ── Staff (PIN 1234 for all) ─────────────────────────────────────────────
  insert into public.staff (tenant_id, name, employee_id, role_id, pin_hash, pin_salt)
  values
    (v_tenant, 'Raj Kumar',   'raj',   v_waiter,  'c9b192b9d06699cdedb2033f617e329f2728d00dafd260ced8b2895a1b8315a3e7cdb7e83890c2d50a7d9f558325286311347506617486da1fab240591c1e7d5', '5f2a9c1e7b3d4086a1c2e3f405162738'),
    (v_tenant, 'Priya Nair',  'priya', v_manager, 'c9b192b9d06699cdedb2033f617e329f2728d00dafd260ced8b2895a1b8315a3e7cdb7e83890c2d50a7d9f558325286311347506617486da1fab240591c1e7d5', '5f2a9c1e7b3d4086a1c2e3f405162738'),
    (v_tenant, 'Amit Singh',  'amit',  v_cashier, 'c9b192b9d06699cdedb2033f617e329f2728d00dafd260ced8b2895a1b8315a3e7cdb7e83890c2d50a7d9f558325286311347506617486da1fab240591c1e7d5', '5f2a9c1e7b3d4086a1c2e3f405162738'),
    (v_tenant, 'Chef Ramesh', 'ramesh', v_kitchen, 'c9b192b9d06699cdedb2033f617e329f2728d00dafd260ced8b2895a1b8315a3e7cdb7e83890c2d50a7d9f558325286311347506617486da1fab240591c1e7d5', '5f2a9c1e7b3d4086a1c2e3f405162738');

  -- ── Settings ─────────────────────────────────────────────────────────────
  insert into public.settings (tenant_id, key, value) values
    (v_tenant, 'gstin', '29ABCDE1234F1Z5'),
    (v_tenant, 'fssai', '10020065000123'),
    (v_tenant, 'instagram', 'https://instagram.com/jaegarresto'),
    (v_tenant, 'facebook', 'https://facebook.com/jaegarresto'),
    (v_tenant, 'youtube', 'https://youtube.com/@jaegarresto'),
    (v_tenant, 'google_review_url', 'https://g.page/r/jaegar-resto/review'),
    (v_tenant, 'bill_footer', 'Thank you for dining with us.'),
    (v_tenant, 'terms', 'Prices inclusive of applicable taxes unless stated.');

  -- ── Promo codes ──────────────────────────────────────────────────────────
  insert into public.promo_codes
    (tenant_id, code, description, type, value, min_order, max_discount, usage_limit, valid_to, active)
  values
    (v_tenant, 'WELCOME10', '10% off your first order', 'PERCENTAGE', 10, 300, 150, 0, now() + interval '90 days', true),
    (v_tenant, 'FLAT50',    'Flat ₹50 off over ₹500',  'FIXED',      50, 500,   0, 200, now() + interval '30 days', true),
    (v_tenant, 'WEEKEND15', '15% off on weekends',      'PERCENTAGE', 15, 800, 250, 0, now() + interval '60 days', true);

  raise notice 'Seeded demo tenant % (Jaegar Resto).', v_tenant;
end $$;
