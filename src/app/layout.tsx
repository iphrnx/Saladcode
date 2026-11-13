import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { CookieConsentBanner } from "@/components/shared/cookie-consent";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const DESCRIPTION =
  "The Salad runs the floor for Indian restaurants: point-of-sale, live order flow, " +
  "QR table ordering, staff PIN sessions, reservations, analytics and GST-compliant bills.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  alternates: { canonical: "/" },
  title: {
    default: "The Salad — Restaurant Management Software for India | QR Ordering, POS & GST Billing",
    template: "%s · The Salad",
  },
  description: DESCRIPTION,
  applicationName: "The Salad",
  keywords: [
    "restaurant management software India",
    "restaurant POS software",
    "QR code ordering system",
    "QR menu for restaurant",
    "GST billing software for restaurant",
    "kitchen display system",
    "table ordering system",
    "restaurant software India",
  ],
  openGraph: {
    type: "website",
    siteName: "The Salad",
    title: "The Salad — Restaurant Management Software for India",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "The Salad — Restaurant Management Software for India",
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23f97316'/%3E%3Ctext x='16' y='22' font-size='18' text-anchor='middle' fill='white' font-family='sans-serif' font-weight='bold'%3ES%3C/text%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f97316",
};

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: "The Salad",
      url: SITE_URL,
      logo: `${SITE_URL}/opengraph-image.png`,
    },
    {
      "@type": "WebSite",
      name: "The Salad",
      url: SITE_URL,
    },
    {
      "@type": "SoftwareApplication",
      name: "The Salad",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description: DESCRIPTION,
      url: SITE_URL,
      offers: {
        "@type": "AggregateOffer",
        lowPrice: "999",
        highPrice: "2499",
        priceCurrency: "INR",
        description: "Per-restaurant monthly plans. Free to try — no card required.",
      },
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {/* Inline script to prevent flash of wrong theme */}
        <script dangerouslySetInnerHTML={{
          __html: `
            (function() {
              try {
                var stored = localStorage.getItem('the-salad-theme');
                if (!stored) {
                  // The key was renamed with the product; carry an existing
                  // choice across once, so a returning visitor does not see the
                  // wrong theme flash before the app has mounted.
                  var legacyKeys = ['toastly-theme', 'tablo-theme'];
                  for (var i = 0; i < legacyKeys.length; i++) {
                    var previous = localStorage.getItem(legacyKeys[i]);
                    if (previous) {
                      stored = previous;
                      localStorage.setItem('the-salad-theme', previous);
                      break;
                    }
                  }
                  for (var j = 0; j < legacyKeys.length; j++) {
                    localStorage.removeItem(legacyKeys[j]);
                  }
                }
                var theme = stored || 'dark';
                if (theme === 'dark') {
                  document.documentElement.classList.add('dark');
                } else {
                  document.documentElement.classList.remove('dark');
                }
              } catch(e) {
                document.documentElement.classList.add('dark');
              }
            })();
          `
        }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        {/* Site-wide, so the same choice covers the public site and the
            dashboard. It renders only when no choice is on record. */}
        <CookieConsentBanner />
        <Sonner />
      </body>
    </html>
  );
}
