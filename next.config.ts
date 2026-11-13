import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Content-Security-Policy.
 *
 * Next's runtime and Tailwind both need inline styles, and Next injects inline
 * bootstrap scripts, so 'unsafe-inline' is unavoidable without a nonce
 * pipeline. 'unsafe-eval' is only granted in development (React Refresh needs
 * it) — it is NOT in the production policy.
 */
const csp = [
  "default-src 'self'",
  // checkout.razorpay.com serves checkout.js, the payment window itself.
  // 'wasm-unsafe-eval' permits WebAssembly compilation only — NOT JavaScript
  // eval — required by the HEIC→JPEG fallback decoder's libheif WASM build.
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://checkout.razorpay.com${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // heic2any (the desktop HEIC→JPEG fallback decoder) builds its libheif
  // worker from a blob URL. Without this directive worker-src falls back to
  // script-src, which does not allow blob: — the Worker constructor throws,
  // the library swallows it, and the conversion promise hangs forever.
  // That is exactly how "Converting iPhone photo…" used to never finish.
  "worker-src 'self' blob:",
  // Supabase REST + Realtime (websocket) endpoints; api.razorpay.com is what
  // checkout.js talks to, lumberjack is its telemetry.
  //
  // `NEXT_PUBLIC_EDGE_BASE` is only ever set for a browser test run, where the
  // local edge-function harness answers the /functions/v1 calls instead of the
  // deployed functions. That origin has to be in connect-src as well, or the
  // browser blocks every call and the app quietly looks signed out — which is
  // exactly what a CSP violation looks like from the outside.
  `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.razorpay.com https://lumberjack.razorpay.com${
    process.env.NEXT_PUBLIC_EDGE_BASE ? ` ${process.env.NEXT_PUBLIC_EDGE_BASE}` : ""
  }`,
  // The payment window is an iframe Razorpay serves from its own domains.
  "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Type errors must fail the build. They were previously suppressed, which
  // let real bugs (e.g. onboarding sending undefined tax rates) ship silently.
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  // Don't advertise the framework.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }]
  },
};

export default nextConfig;
