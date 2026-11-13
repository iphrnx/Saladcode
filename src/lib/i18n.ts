'use client'

import { useMemo } from 'react'
import { useApp } from '@/components/app/data-context'

/**
 * Two languages, both real.
 *
 * The settings page used to offer ten — Bengali, Tamil, Telugu, Marathi,
 * Gujarati, Kannada, Malayalam, Punjabi — and translate none of them. Choosing
 * Tamil saved the value and changed nothing, so the app looked broken to anyone
 * who picked one. Offering a language is a promise; this file is what keeps it.
 *
 * Deliberately not a library. The operator surface is around a hundred strings,
 * and a dependency would cost more than it saves. Add one when the surface is
 * large enough to need pluralisation and formatting.
 *
 * Where Hindi and English mix in ordinary speech — ऑर्डर, बिल, टेबल, मेन्यू — the
 * loanword is used, because that is what a restaurant actually says out loud.
 */
export type Lang = 'en' | 'hi'

export const LANGUAGES: { value: Lang; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'हिन्दी (Hindi)' },
]

type Entry = { en: string; hi: string }

const DICT: Record<string, Entry> = {
  // ---- navigation -----------------------------------------------------------
  'nav.dashboard': { en: 'POS Dashboard', hi: 'पीओएस डैशबोर्ड' },
  'nav.dashboard.desc': { en: 'Take new orders', hi: 'नए ऑर्डर लें' },
  'nav.orders': { en: 'Orders', hi: 'ऑर्डर' },
  'nav.orders.desc': { en: 'Manage active orders', hi: 'चालू ऑर्डर संभालें' },
  'nav.analytics': { en: 'Analytics', hi: 'रिपोर्ट' },
  'nav.analytics.desc': { en: 'Revenue & insights', hi: 'आमदनी और आँकड़े' },
  'nav.menu': { en: 'Menu', hi: 'मेन्यू' },
  'nav.menu.desc': { en: 'Manage dishes', hi: 'व्यंजन संभालें' },
  'nav.qr': { en: 'QR Codes', hi: 'क्यूआर कोड' },
  'nav.qr.desc': { en: 'Table QR codes', hi: 'टेबल क्यूआर कोड' },
  'nav.promos': { en: 'Promo Codes', hi: 'प्रोमो कोड' },
  'nav.promos.desc': { en: 'Discounts & coupons', hi: 'छूट और कूपन' },
  'nav.roles': { en: 'Role Access', hi: 'भूमिका और अनुमतियाँ' },
  'nav.roles.desc': { en: 'Staff & permissions', hi: 'स्टाफ और अनुमतियाँ' },
  'nav.security': { en: 'Security', hi: 'सुरक्षा' },
  'nav.security.desc': { en: 'Sessions & logs', hi: 'सेशन और लॉग' },
  'nav.billing': { en: 'Billing', hi: 'बिलिंग' },
  'nav.billing.desc': { en: 'Plan & payments', hi: 'प्लान और भुगतान' },
  'nav.settings': { en: 'Settings', hi: 'सेटिंग्स' },
  'nav.settings.desc': { en: 'Restaurant config', hi: 'रेस्टोरेंट सेटिंग्स' },
  'nav.signOut': { en: 'Sign out', hi: 'साइन आउट' },

  // ---- access ---------------------------------------------------------------
  // Shown when a role opens something it does not hold. Deliberately about
  // permission and not about the data: "Failed to load orders" tells a Cashier
  // their orders are broken, when the truth is they may not see them.
  'access.title': { en: 'Access Denied', hi: 'पहुँच नहीं है' },
  'access.body': {
    en: 'Your role does not have permission to open this.',
    hi: 'आपकी भूमिका को यह खोलने की अनुमति नहीं है।',
  },
  'access.hint': {
    en: 'Ask the restaurant owner to grant you access.',
    hi: 'रेस्टोरेंट के मालिक से पहुँच देने को कहें।',
  },
  'access.needs': { en: 'Needs', hi: 'चाहिए' },
  'access.goTo': { en: 'Go to', hi: 'यहाँ जाएँ' },
  'access.signInAgain': { en: 'Sign in again', hi: 'फिर से साइन इन करें' },
  'access.expired': {
    en: 'Your session has expired. Sign in again to continue.',
    hi: 'आपका सेशन खत्म हो गया। जारी रखने के लिए फिर से साइन इन करें।',
  },
  'access.retry': { en: 'Try again', hi: 'फिर कोशिश करें' },
  'access.failedTitle': { en: 'Could not load', hi: 'लोड नहीं हो सका' },

  // ---- header ---------------------------------------------------------------
  'search.placeholder': { en: 'Search orders, dishes…', hi: 'ऑर्डर, व्यंजन खोजें…' },
  'search.label': { en: 'Search orders, dishes and pages', hi: 'ऑर्डर, व्यंजन और पेज खोजें' },
  'search.nothing': { en: 'Nothing matches', hi: 'कुछ नहीं मिला' },
  'notifications.title': { en: 'Notifications', hi: 'सूचनाएँ' },
  'notifications.empty': { en: "You're all caught up.", hi: 'सब देख लिया गया।' },
  'tenant.yours': { en: 'Your restaurant', hi: 'आपका रेस्टोरेंट' },

  // ---- point of sale --------------------------------------------------------
  'pos.open': { en: 'OPEN', hi: 'खुला' },
  'pos.today': { en: 'TODAY', hi: 'आज' },
  'pos.active': { en: 'ACTIVE', hi: 'चालू' },
  'pos.search': { en: 'Search for food, coffee, etc…', hi: 'खाना, चाय, कॉफ़ी खोजें…' },
  'pos.all': { en: 'All', hi: 'सब' },
  'pos.sessions': { en: 'ACTIVE SESSIONS', hi: 'चालू सेशन' },
  'pos.noSessions': { en: 'No tables are currently in session.', hi: 'अभी कोई टेबल सेशन में नहीं है।' },
  'pos.endSession': { en: 'End session', hi: 'सेशन बंद करें' },
  'pos.noOrderYet': { en: 'no order yet', hi: 'अभी ऑर्डर नहीं' },
  'pos.cart': { en: 'Order Cart', hi: 'ऑर्डर कार्ट' },
  'pos.cartEmpty': { en: 'No items yet', hi: 'अभी कोई आइटम नहीं' },
  'pos.cartHint': { en: 'Tap menu items to add them', hi: 'जोड़ने के लिए मेन्यू आइटम दबाएँ' },
  'pos.noItems': { en: 'No items found', hi: 'कोई आइटम नहीं मिला' },
  'pos.qtyPrice': { en: 'Qty · Price', hi: 'संख्या · दाम' },
  'pos.promo': { en: 'PROMO CODE', hi: 'प्रोमो कोड' },
  'pos.apply': { en: 'Apply', hi: 'लागू करें' },
  'pos.subtotal': { en: 'Sub total', hi: 'उप-योग' },
  'pos.tax': { en: 'Tax', hi: 'कर' },
  'pos.service': { en: 'Service', hi: 'सेवा शुल्क' },
  'pos.total': { en: 'Total', hi: 'कुल' },
  'pos.checkout': { en: 'Place Order', hi: 'ऑर्डर करें' },
  'pos.dineIn': { en: 'Dine In', hi: 'डाइन इन' },
  'pos.takeaway': { en: 'Takeaway', hi: 'टेकअवे' },
  'pos.delivery': { en: 'Delivery', hi: 'डिलीवरी' },
  'pos.selectTable': { en: 'Select table', hi: 'टेबल चुनें' },
  'pos.selectItems': { en: 'Select items', hi: 'आइटम चुनें' },
  'pos.unavailable': { en: 'Not orderable', hi: 'उपलब्ध नहीं' },
  'pos.min': { en: 'min', hi: 'मिनट' },
  'pos.promoInvalid': { en: 'Invalid or expired promo code', hi: 'प्रोमो कोड ग़लत या ख़त्म' },
  'pos.promoExpired': { en: 'Promo code has expired', hi: 'प्रोमो कोड की अवधि ख़त्म' },

  // ---- orders ---------------------------------------------------------------
  'orders.title': { en: 'Manage and track every order', hi: 'हर ऑर्डर देखें और संभालें' },
  'orders.search': { en: 'Search by number or name…', hi: 'नंबर या नाम से खोजें…' },
  'orders.start': { en: 'Start Preparing', hi: 'तैयार करना शुरू करें' },
  'orders.ready': { en: 'Mark Ready', hi: 'तैयार है' },
  'orders.served': { en: 'Mark Served', hi: 'परोस दिया' },
  'orders.complete': { en: 'Complete & Pay', hi: 'पूरा करें और भुगतान' },
  'orders.view': { en: 'View', hi: 'देखें' },
  'orders.bill': { en: 'Bill', hi: 'बिल' },
  'orders.delete': { en: 'Delete order', hi: 'ऑर्डर हटाएँ' },
  'orders.noOrders': { en: 'No orders yet', hi: 'अभी कोई ऑर्डर नहीं' },
  'orders.noMatch': { en: 'No orders match', hi: 'कोई ऑर्डर नहीं मिला' },
  'orders.pending': { en: 'Pending', hi: 'बाकी' },
  'orders.preparing': { en: 'Preparing', hi: 'बन रहा है' },
  'orders.readyState': { en: 'Ready', hi: 'तैयार' },
  'orders.servedState': { en: 'Served', hi: 'परोसा गया' },
  'orders.completed': { en: 'Completed', hi: 'पूरा हुआ' },
  'orders.cancelled': { en: 'Cancelled', hi: 'रद्द' },

  // ---- cart / common --------------------------------------------------------
  'common.cancel': { en: 'Cancel', hi: 'रद्द करें' },
  'common.retry': { en: 'Retry', hi: 'फिर कोशिश करें' },
  'common.dismiss': { en: 'Dismiss', hi: 'हटाएँ' },
  'pos.queue.offline': {
    en: 'Offline — order saved, will send when back online',
    hi: 'ऑफ़लाइन — ऑर्डर सुरक्षित है, नेटवर्क आने पर भेजा जाएगा',
  },
  'pos.queue.sending': { en: 'Sending order…', hi: 'ऑर्डर भेजा जा रहा है…' },
  'pos.queue.failed': { en: 'Order could not be sent', hi: 'ऑर्डर नहीं भेजा जा सका' },
  'common.close': { en: 'Close', hi: 'बंद करें' },
  'common.save': { en: 'Save', hi: 'सेव करें' },
  'common.done': { en: 'Done', hi: 'हो गया' },
  'common.clear': { en: 'Clear', hi: 'साफ़ करें' },
  'common.add': { en: 'Add', hi: 'जोड़ें' },
  'common.remove': { en: 'Remove', hi: 'हटाएँ' },
  'common.item': { en: 'Item', hi: 'आइटम' },
  'common.qty': { en: 'Qty', hi: 'संख्या' },
  'common.price': { en: 'Price', hi: 'दाम' },
  'orders.type': { en: 'Type', hi: 'प्रकार' },
  'orders.phone': { en: 'Phone', hi: 'फ़ोन' },
  'orders.servedBy': { en: 'Served by', hi: 'किसने परोसा' },
  'orders.note': { en: 'Order Note', hi: 'ऑर्डर नोट' },
  'orders.discount': { en: 'Discount', hi: 'छूट' },
}

export type T = (key: string) => string

/** Build a translator for one language. Falls back to English, then the key. */
export function translator(lang: Lang): T {
  return (key: string) => {
    const entry = DICT[key]
    if (!entry) return key
    return lang === 'hi' ? entry.hi : entry.en
  }
}

/**
 * The translator for the signed-in restaurant's chosen language.
 *
 * Reads the saved preference rather than local state, so every device on the
 * account shows the same thing.
 */
export function useT(): T {
  const { data } = useApp()
  const lang = ((data?.settings as Record<string, unknown> | undefined)?.pref_language as Lang) || 'en'
  return useMemo(() => translator(lang === 'hi' ? 'hi' : 'en'), [lang])
}
