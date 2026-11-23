import { createServer } from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// Create valid dummy JWT with sub: "usr-mock-owner"
const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(JSON.stringify({
  sub: "usr-mock-owner",
  session_id: "sess-1",
  role: "authenticated",
})).toString("base64url");
const dummyJwt = `${header}.${payload}.signature`;

// 1. Setup mock Supabase REST server for Deno function
const mockServer = createServer((req, res) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  res.setHeader("Content-Type", "application/json");

  // Mock auth.getUser
  if (url.pathname.includes("/auth/v1/user")) {
    res.writeHead(200);
    res.end(JSON.stringify({
      id: "usr-mock-owner",
      email: "owner@example.com",
      role: "authenticated",
    }));
    return;
  }

  // Mock profiles
  if (url.pathname.includes("/rest/v1/profiles")) {
    res.writeHead(200);
    res.end(JSON.stringify([
      {
        id: "usr-mock-owner",
        tenant_id: "ten-mock-1",
        name: "Mock Owner",
        email: "owner@example.com",
        role: "Owner",
        active: true,
      }
    ]));
    return;
  }

  // Mock tenants
  if (url.pathname.includes("/rest/v1/tenants")) {
    res.writeHead(200);
    res.end(JSON.stringify([
      {
        id: "ten-mock-1",
        name: "Mock Restaurant",
        plan: "starter",
        active: true,
        currency_symbol: "₹",
      }
    ]));
    return;
  }

  // Mock settings
  if (url.pathname.includes("/rest/v1/settings")) {
    res.writeHead(200);
    res.end(JSON.stringify([
      { value: "Asia/Kolkata" }
    ]));
    return;
  }

  // Mock locations
  if (url.pathname.includes("/rest/v1/locations")) {
    res.writeHead(200);
    res.end(JSON.stringify([
      { id: "loc-1", name: "Main Branch", is_primary: true, active: true, tenant_id: "ten-mock-1" }
    ]));
    return;
  }

  // Mock tables
  if (url.pathname.includes("/rest/v1/tables")) {
    res.writeHead(200);
    res.end(JSON.stringify([
      { id: "tbl-1", name: "Table 1", location_id: "loc-1" }
    ]));
    return;
  }

  // Mock menu_items
  if (url.pathname.includes("/rest/v1/menu_items")) {
    res.writeHead(200);
    res.end(JSON.stringify([
      { id: "item-1", name: "Salad", is_active: true, category: { name: "Food" } }
    ]));
    return;
  }

  // Default empty list for check_payments, table_checks, orders
  res.writeHead(200);
  res.end(JSON.stringify([]));
});

mockServer.listen(54321, "127.0.0.1", async () => {
  console.log("Mock Supabase backend listening on http://127.0.0.1:54321");

  // 2. Spawn Deno running supabase/functions/analytics/index.ts
  const denoProc = spawn("deno", ["run", "--allow-all", "--allow-env", "supabase/functions/analytics/index.ts"], {
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.deno/bin:${process.env.PATH}`,
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_ANON_KEY: "mock-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "mock-service-role-key",
      PORT: "8000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  denoProc.stdout.on("data", (d) => console.log(`[Deno stdout] ${d.toString().trim()}`));
  denoProc.stderr.on("data", (d) => console.error(`[Deno stderr] ${d.toString().trim()}`));

  // Wait for Deno to listen
  await new Promise((r) => setTimeout(r, 1500));

  try {
    // 3. Make authenticated request to Analytics endpoint
    console.log("Invoking http://127.0.0.1:8000/ with authenticated headers...");
    const res = await fetch("http://127.0.0.1:8000/", {
      method: "GET",
      headers: {
        "apikey": "mock-anon-key",
        "authorization": `Bearer ${dummyJwt}`,
        "x-tenant-id": "ten-mock-1",
      },
    });

    console.log(`Response status: ${res.status}`);
    const json = await res.json();
    console.log("Response JSON keys:", Object.keys(json));

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.equal(typeof json.totalRevenue, "number", "totalRevenue must be a number");
    assert.equal(typeof json.totalOrders, "number", "totalOrders must be a number");
    assert.equal(typeof json.avgOrder, "number", "avgOrder must be a number");
    assert.ok(json.paymentMethods, "paymentMethods must exist");
    assert.ok(json.operationsPerformance, "operationsPerformance must exist");
    assert.ok(json.discountsAndRefunds, "discountsAndRefunds must exist");

    console.log("✓ Batch 1: Authenticated Analytics request returns HTTP 200 and valid Analytics JSON!");
  } catch (err) {
    console.error("Test failed:", err);
    process.exitCode = 1;
  } finally {
    denoProc.kill();
    mockServer.close();
  }
});
