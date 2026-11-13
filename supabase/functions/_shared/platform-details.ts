/**
 * The platform's business details — the "From" identity on every The Salad
 * subscription invoice. Edited in Super Admin → Settings → Billing &
 * Invoices, stored in the platform_business_details table, validated
 * here. Pure functions only, so the whole module tests offline.
 *
 * The GSTIN is stored for future use. It is deliberately NOT rendered
 * on any document — a GSTIN on an invoice implies tax treatment the
 * platform does not do.
 */

export type PlatformBusinessDetails = {
  legalName: string;
  street: string;
  city: string;
  state: string;
  pinCode: string;
  country: string;
  email: string;
  phone: string;
  gstin: string;
};

export const EMPTY_BUSINESS_DETAILS: PlatformBusinessDetails = {
  legalName: "",
  street: "",
  city: "",
  state: "",
  pinCode: "",
  country: "India",
  email: "",
  phone: "",
  gstin: "",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PIN_INDIA_RE = /^\d{6}$/;
const PIN_GENERAL_RE = /^[A-Za-z0-9][A-Za-z0-9\- ]{1,11}$/;
const PHONE_RE = /^\+?\d{7,15}$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

/**
 * Validate a save. Returns either the cleaned details or a map of
 * field → message, so the form can point at exactly what is wrong.
 * Everything is trimmed; the GSTIN is normalised to upper case.
 */
export function validateBusinessDetails(
  input: Record<string, unknown>,
): { ok: true; value: PlatformBusinessDetails } | { ok: false; errors: Record<string, string> } {
  const value: PlatformBusinessDetails = {
    legalName: clean(input.legalName),
    street: clean(input.street),
    city: clean(input.city),
    state: clean(input.state),
    pinCode: clean(input.pinCode),
    country: clean(input.country) || "India",
    email: clean(input.email).toLowerCase(),
    phone: clean(input.phone),
    gstin: clean(input.gstin).toUpperCase(),
  };
  const errors: Record<string, string> = {};

  if (!value.legalName) errors.legalName = "Legal business name is required.";
  else if (value.legalName.length < 2 || value.legalName.length > 140) {
    errors.legalName = "Keep it between 2 and 140 characters.";
  }

  if (!value.street) errors.street = "Street / area is required.";
  else if (value.street.length > 200) errors.street = "Keep it under 200 characters.";

  if (!value.city) errors.city = "City is required.";
  if (!value.state) errors.state = "State is required.";
  if (!value.country) errors.country = "Country is required.";

  if (!value.pinCode) {
    errors.pinCode = "PIN code is required.";
  } else if (value.country.toLowerCase() === "india" && !PIN_INDIA_RE.test(value.pinCode)) {
    errors.pinCode = "An Indian PIN code is exactly 6 digits.";
  } else if (value.country.toLowerCase() !== "india" && !PIN_GENERAL_RE.test(value.pinCode)) {
    errors.pinCode = "That postal code does not look right.";
  }

  if (!value.email) errors.email = "Business email is required.";
  else if (!EMAIL_RE.test(value.email) || value.email.length > 160) {
    errors.email = "Enter a valid email address.";
  }

  const phoneDigits = value.phone.replace(/[\s\-()]/g, "");
  if (!value.phone) errors.phone = "Contact number is required.";
  else if (!PHONE_RE.test(phoneDigits)) {
    errors.phone = "Enter 7–15 digits, optionally starting with +.";
  } else {
    value.phone = phoneDigits; // stored compact: +919000000000
  }

  if (value.gstin && !GSTIN_RE.test(value.gstin)) {
    errors.gstin = "A GSTIN is 15 characters, e.g. 29ABCDE1234F1Z5.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * The structured address as document lines, empties dropped:
 *   12, MG Road
 *   Bengaluru, Karnataka – 560001
 *   India
 */
export function composeBusinessAddressLines(d: {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  pin_code?: string | null;
  country?: string | null;
}): string[] {
  const lines: string[] = [];
  const street = clean(d.street);
  if (street) lines.push(street);
  const region = [clean(d.city), clean(d.state)].filter(Boolean).join(", ");
  const pin = clean(d.pin_code);
  if (region && pin) lines.push(`${region} – ${pin}`);
  else if (region) lines.push(region);
  else if (pin) lines.push(pin);
  const country = clean(d.country);
  if (country) lines.push(country);
  return lines;
}

/** True when a stored row actually carries an identity worth using. */
export function businessDetailsConfigured(row: { legal_name?: string | null } | null): boolean {
  return !!row && clean(row.legal_name).length > 0;
}
