-- ===========================================================================
-- THE SALAD — SYNTHETIC DEVELOPMENT SEED DATA
-- ===========================================================================
-- Description: Isolated development seed fixtures for testing and development.
-- NEVER RUN AGAINST A PRODUCTION SYSTEM WITH LIVE CUSTOMERS.
-- ===========================================================================

do $$
declare
  v_tenant_id uuid := 'a0000000-0000-0000-0000-000000000001'::uuid;
  v_loc_id uuid := 'b0000000-0000-0000-0000-000000000001'::uuid;
  v_role_owner uuid := 'c0000000-0000-0000-0000-000000000001'::uuid;
  v_role_mgr uuid := 'c0000000-0000-0000-0000-000000000002'::uuid;
  v_role_cashier uuid := 'c0000000-0000-0000-0000-000000000003'::uuid;
  v_role_kitchen uuid := 'c0000000-0000-0000-0000-000000000004'::uuid;
  v_role_waiter uuid := 'c0000000-0000-0000-0000-000000000005'::uuid;
  v_cat_bowls uuid := 'd0000000-0000-0000-0000-000000000001'::uuid;
  v_cat_wraps uuid := 'd0000000-0000-0000-0000-000000000002'::uuid;
  v_cat_beverages uuid := 'd0000000-0000-0000-0000-000000000003'::uuid;
  v_table_1 uuid := 'e0000000-0000-0000-0000-000000000001'::uuid;
  v_table_2 uuid := 'e0000000-0000-0000-0000-000000000002'::uuid;
  v_table_5 uuid := 'e0000000-0000-0000-0000-000000000005'::uuid;
  v_table_10 uuid := 'e0000000-0000-0000-0000-000000000010'::uuid;
begin
  -- 1. Tenant
  insert into public.tenants (
    id, name, slug, tagline, currency, currency_symbol,
    address, phone, email, tax_rate, service_charge,
    plan, active, onboarding_done
  ) values (
    v_tenant_id, 'The Salad Bistro', 'the-salad-bistro', 'Fresh Greens, Healthy Living',
    'INR', '₹', 'Shop 12, Indiranagar, Bengaluru, KA 560038', '+91 98765 43210',
    'contact@thesaladbistro.com', 5.00, 0.00, 'starter', true, true
  ) on conflict (id) do nothing;

  -- 2. Locations
  insert into public.locations (
    id, tenant_id, name, slug, address, phone, is_primary, active
  ) values (
    v_loc_id, v_tenant_id, 'Indiranagar Flagship', 'indiranagar',
    'Shop 12, Indiranagar, Bengaluru, KA 560038', '+91 98765 43210', true, true
  ) on conflict (tenant_id, slug) do nothing;

  -- 3. System Roles
  insert into public.roles (id, tenant_id, name, description, permissions, is_system, color)
  values
    (v_role_owner, v_tenant_id, 'Owner', 'Full platform access and management', '["dashboard.view","orders.view","orders.manage","kitchen.view","kitchen.manage","tables.view","tables.manage","menu.view","menu.manage","billing.view","billing.manage","staff.view","staff.manage","roles.view","roles.manage","analytics.view","settings.view","settings.manage","security.view","security.manage"]', true, '#ea580c'),
    (v_role_mgr, v_tenant_id, 'Manager', 'Day-to-day operations and staff oversight', '["dashboard.view","orders.view","orders.manage","kitchen.view","kitchen.manage","tables.view","tables.manage","menu.view","billing.view","staff.view","analytics.view","settings.view"]', true, '#3b82f6'),
    (v_role_cashier, v_tenant_id, 'Cashier', 'POS billing and settlement', '["orders.view","orders.manage","tables.view","billing.view","billing.manage"]', true, '#10b981'),
    (v_role_kitchen, v_tenant_id, 'Kitchen', 'Kitchen display and order prep', '["kitchen.view","kitchen.manage"]', true, '#8b5cf6'),
    (v_role_waiter, v_tenant_id, 'Waiter', 'Order taking and table service', '["orders.view","orders.manage","tables.view"]', true, '#f59e0b')
  on conflict (tenant_id, name) do nothing;

  -- 4. Staff members (PIN: 1234)
  -- scrypt hash with salt '0123456789abcdef0123456789abcdef'
  insert into public.staff (
    tenant_id, location_id, role_id, name, employee_id, pin_hash, pin_salt, active
  ) values
    (v_tenant_id, v_loc_id, v_role_mgr, 'Aarav Mehta', 'EMP001', '7a5e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b', '0123456789abcdef0123456789abcdef', true),
    (v_tenant_id, v_loc_id, v_role_cashier, 'Rohan Sharma', 'EMP002', '7a5e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b', '0123456789abcdef0123456789abcdef', true),
    (v_tenant_id, v_loc_id, v_role_kitchen, 'Chef Vikram', 'EMP003', '7a5e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b', '0123456789abcdef0123456789abcdef', true),
    (v_tenant_id, v_loc_id, v_role_waiter, 'Pooja Nair', 'EMP004', '7a5e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b3d6f4a2e8c1b', '0123456789abcdef0123456789abcdef', true)
  on conflict (tenant_id, employee_id) do nothing;

  -- 5. Dining Areas
  insert into public.dining_areas (tenant_id, location_id, name, sort_order)
  values
    (v_tenant_id, v_loc_id, 'Main Hall', 1),
    (v_tenant_id, v_loc_id, 'Terrace Garden', 2),
    (v_tenant_id, v_loc_id, 'Window Lounge', 3)
  on conflict do nothing;

  -- 6. Tables
  insert into public.tables (id, tenant_id, location_id, name, seats, area, qr_token, active)
  values
    (v_table_1, v_tenant_id, v_loc_id, 'Table 1', 2, 'Window Lounge', 'qr-bistro-t1', true),
    (v_table_2, v_tenant_id, v_loc_id, 'Table 2', 4, 'Window Lounge', 'qr-bistro-t2', true),
    (v_table_5, v_tenant_id, v_loc_id, 'Table 5', 4, 'Main Hall', 'qr-bistro-t5', true),
    (v_table_10, v_tenant_id, v_loc_id, 'Table 10', 6, 'Main Hall', 'qr-bistro-t10', true)
  on conflict (tenant_id, name) do nothing;

  -- 7. Categories
  insert into public.categories (id, tenant_id, name, icon, sort_order)
  values
    (v_cat_bowls, v_tenant_id, 'Salad Bowls', '🥗', 1),
    (v_cat_wraps, v_tenant_id, 'Protein Wraps', '🌯', 2),
    (v_cat_beverages, v_tenant_id, 'Cold Pressed Juices', '🥤', 3)
  on conflict do nothing;

  -- 8. Menu Items
  insert into public.menu_items (
    tenant_id, category_id, name, description, price, available,
    prep_time, tags, rating, sort_order, portions
  ) values
    (v_cat_bowls, v_tenant_id, 'Harissa Paneer Warm Bowl', 'Spiced cottage cheese with quinoa, roasted veggies & citrus harissa dressing', 420.00, true, 15, 'VEG,BESTSELLER,GLUTEN-FREE', 4.9, 1, '[{"id":"reg","name":"Regular","price":420},{"id":"large","name":"Large","price":520}]'::jsonb),
    (v_cat_bowls, v_tenant_id, 'Mediterranean Falafel Bowl', 'Crispy falafels, hummus, tabbouleh & tahini drizzle over pearl couscous', 380.00, true, 12, 'VEGAN,HEALTHY', 4.8, 2, null),
    (v_cat_wraps, v_tenant_id, 'Avocado & Smoked Tofu Wrap', 'Whole wheat tortilla packed with Haas avocado, smoked tofu & fresh greens', 340.00, true, 10, 'VEGAN,NEW', 4.7, 3, null),
    (v_cat_beverages, v_tenant_id, 'Green Detox Elixir', 'Celery, green apple, cucumber, spinach & lime cold pressed fresh', 180.00, true, 5, 'VEGAN,GLUTEN-FREE', 4.9, 4, null)
  on conflict do nothing;

  -- 9. Settings
  insert into public.settings (tenant_id, key, value)
  values
    (v_tenant_id, 'bill_footer', 'Thank you for eating healthy with The Salad Bistro!'),
    (v_tenant_id, 'terms', 'All prices inclusive of 5% GST. No service charge.'),
    (v_tenant_id, 'gstin', '29ABCDE1234F1Z5'),
    (v_tenant_id, 'fssai', '11223344556677'),
    (v_tenant_id, 'auto_accept_orders', 'true'),
    (v_tenant_id, 'currency', 'INR'),
    (v_tenant_id, 'currency_symbol', '₹')
  on conflict (tenant_id, key) do update
    set value = excluded.value, updated_at = now();

  -- 10. Promo Code
  insert into public.promo_codes (
    tenant_id, code, description, type, value, min_order, max_discount, usage_limit, active
  ) values (
    v_tenant_id, 'WELCOME20', '20% off on your first healthy meal', 'PERCENTAGE', 20.00, 300.00, 100.00, 500, true
  ) on conflict (tenant_id, code) do nothing;

  -- 11. Subscription
  insert into public.subscriptions (
    tenant_id, plan_id, status, trial_started_at, trial_ends_at, current_period_end
  ) values (
    v_tenant_id, 'starter', 'trialing', now(), now() + interval '14 days', now() + interval '14 days'
  ) on conflict (tenant_id) do nothing;

end $$;

