// User-Agent parsing for session display: browser family, operating system,
// device class. Hand-rolled on purpose — a full parser dependency is dead
// weight for three display fields, and the edge bundle stays small.
//
// Order matters in every matcher: clients masquerade as each other
// (Edge contains "Chrome", Chrome contains "Safari", Android tablets omit
// "Mobile"), so the more specific token is always tested first.
//
// An agent that matches nothing reports null, never a placeholder word. An
// unknown agent used to come back as browser "Browser" and device "Device" —
// two invented labels that render as "Browser · Device" and read as real
// values, which is how a pile of script/test sessions looked like one
// inexplicable device. The UI says "Unknown client" when there is nothing to
// say, which is the truth.

export interface AgentInfo {
  browser: string | null;
  os: string | null;
  device: string | null;
}

export function browserFromAgent(ua: string | null): string | null {
  if (!ua) return null;
  if (/EdgA?\//.test(ua) || ua.includes("Edge/")) return "Edge";
  if (ua.includes("OPR/") || ua.includes("Opera")) return "Opera";
  if (ua.includes("SamsungBrowser/")) return "Samsung Internet";
  if (/CriOS\//.test(ua)) return "Chrome"; // Chrome on iOS
  if (/FxiOS\//.test(ua)) return "Firefox"; // Firefox on iOS
  if (ua.includes("Chrome/") || ua.includes("Chromium/")) return "Chrome";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("AppleWebKit") && ua.includes("Safari/")) return "Safari";
  // "node", "curl/8.x", "okhttp/…", the edge runtime's own agent: not a
  // browser this parser knows, and pretending otherwise invents metadata.
  return null;
}

export function osFromAgent(ua: string | null): string | null {
  if (!ua) return null;
  if (/iPhone|iPod/.test(ua)) return "iOS";
  if (/iPad/.test(ua)) return "iPadOS";
  if (/Windows Phone/.test(ua)) return "Windows Phone";
  if (/Android/.test(ua)) return "Android";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "ChromeOS";
  // A desktop-mode iPad reports "Macintosh"; without client hints "macOS"
  // is the honest answer.
  if (/Macintosh|Mac OS X/.test(ua)) return "macOS";
  if (/Linux|X11/.test(ua)) return "Linux";
  return null;
}

export function deviceFromAgent(ua: string | null): string | null {
  if (!ua) return null;
  if (/iPad|Tablet/.test(ua)) return "Tablet";
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return "Tablet";
  if (/iPhone|iPod|Windows Phone|Mobile/.test(ua)) return "Phone";
  if (/Macintosh|Windows NT|CrOS|X11|Linux x86_64/.test(ua)) return "Desktop";
  return null;
}

export function parseUserAgent(ua: string | null): AgentInfo {
  return {
    browser: browserFromAgent(ua),
    os: osFromAgent(ua),
    device: deviceFromAgent(ua),
  };
}
