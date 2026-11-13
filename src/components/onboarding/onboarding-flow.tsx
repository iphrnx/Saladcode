'use client'

/**
 * The Salad — 5-step onboarding wizard
 * Task ID: OB-1
 *
 * Steps:
 *  1. Create Restaurant (details + logo)
 *  2. Create Menu with AI (import via VLM or skip/manual)
 *  3. Customize (theme, currency, tax, ordering toggles)
 *  4. Generate QR (table count + grid preview)
 *  5. Go Live (success + confetti + action buttons)
 *
 * State is autosaved to `localStorage["the-salad-onboarding"]` on every change
 * and restored on mount. Back navigation never loses data because all steps
 * share the single `onboardingData` object.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sanitizeMenuTags } from '@/lib/menu-tags'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import {
  Store,
  Sparkles,
  Pencil,
  Trash2,
  Plus,
  Check,
  ChevronLeft,
  ChevronRight,
  FileImage,
  Loader2,
  Wand2,
  Utensils,
  Settings2,
  QrCode,
  Rocket,
  PartyPopper,
  ShoppingBag,
  LayoutDashboard,
  Download,
  Printer,
  Leaf,
  Drumstick,
  ShieldAlert,
  ImageIcon,
  ScanLine,
  Moon,
  Sun,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { edgeFetch } from '@/lib/edge'
import { keyName, readStored, removeStored, writeStored } from '@/lib/storage-keys'
import {
  MENU_THEMES as MENU_THEME_OPTIONS,
  normaliseMenuTheme,
  type MenuTheme,
} from '@/lib/menu-theme'
import { applyTheme, initTheme } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Progress } from '@/components/ui/progress'
import { ImageUpload } from '@/components/shared/image-upload'
import { PhoneInput } from '@/components/shared/phone-input'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type Confidence = 'low' | 'high'

interface ExtractedVariant {
  name: string
  /** null when the price of this portion could not be read — never 0. */
  price: number | null
  priceUnreadable?: boolean
}
interface ExtractedAddOn {
  name: string
  /** null when the price of this add-on could not be read — never 0. */
  price: number | null
  priceUnreadable?: boolean
}

interface MenuItemDraft {
  id: string
  name: string
  description: string | null
  /** null when no price was readable anywhere for this dish — never saved as 0. */
  price: number | null
  /** The price was not readable in the scan, so this is a placeholder, not a price. */
  priceUnreadable: boolean
  veg: boolean | null
  confidence: Confidence
  variants: ExtractedVariant[]
  addOns: ExtractedAddOn[]
  tags: string[]
}

interface CategoryDraft {
  id: string
  name: string
  icon: string
  items: MenuItemDraft[]
}

interface RestaurantDraft {
  name: string
  /** The person who owns the restaurant. The account already knows this. */
  ownerName: string
  logo: string
  phone: string
  email: string
  address: string
  cuisine: string
  gstin: string
  fssai: string
}

interface CustomizeDraft {
  theme: string
  currency: string
  currencySymbol: string
  taxRate: number
  serviceCharge: number
  autoAcceptOrders: boolean
  autoBillPrint: boolean
  tableQrOrdering?: boolean
  kitchenDisplay?: boolean
}

interface QrDraft {
  tableCount: number
  generated: boolean
}

interface OnboardingData {
  /**
   * The account this draft belongs to.
   *
   * The draft lives in the browser, not in the account, so without this a
   * half-finished setup from one account was restored into the next one — its
   * restaurant, its address, its menu — and the flow opened part-way through,
   * so the first step was never seen.
   */
  ownerId: string
  step: number
  restaurant: RestaurantDraft
  menu: { categories: CategoryDraft[] }
  customize: CustomizeDraft
  qr: QrDraft
}

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

const TOTAL_STEPS = 5

const STEP_META: { title: string; subtitle: string }[] = [
  { title: 'Create Restaurant', subtitle: 'Tell us about your place' },
  { title: 'Build Your Menu', subtitle: 'Import with AI or add manually' },
  { title: 'Customize', subtitle: 'Theme, currency & ordering' },
  { title: 'Generate QR Codes', subtitle: 'For dine-in tables' },
  { title: 'Go Live', subtitle: 'You are all set' },
]

const CUISINES = [
  'Indian',
  'Chinese',
  'Italian',
  'Mexican',
  'Japanese',
  'Thai',
  'Continental',
  'Multi-cuisine',
  'Other',
]

const CURRENCIES: { code: string; symbol: string; label: string }[] = [
  { code: 'INR', symbol: '₹', label: 'Indian Rupee' },
]

// The two themes the customer menu can be shown in. Warm and Minimal were
// names and nothing else — they were never applied to anything.
const MENU_THEMES = MENU_THEME_OPTIONS

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function defaultData(): OnboardingData {
  return {
    ownerId: '',
    step: 1,
    restaurant: {
      name: '',
      ownerName: '',
      logo: '',
      phone: '',
      email: '',
      address: '',
      cuisine: '',
      gstin: '',
      fssai: '',
    },
    menu: { categories: [] },
    customize: {
      // Light, because that is what the customer menu looks like today.
      // A restaurant that wants the dark one picks it here.
      theme: 'light',
      currency: 'INR',
      currencySymbol: '₹',
      taxRate: 5,
      serviceCharge: 0,
      autoAcceptOrders: false,
      autoBillPrint: false,
      tableQrOrdering: true,
      kitchenDisplay: false,
    },
    qr: {
      tableCount: 10,
      generated: false,
    },
  }
}

/** Merge persisted data over the default so new fields always exist. */
function hydrate(stored: Partial<OnboardingData> | null): OnboardingData {
  const base = defaultData()
  if (!stored) return base
  return {
    ownerId: typeof stored.ownerId === 'string' ? stored.ownerId : '',
    step:
      typeof stored.step === 'number'
        ? Math.min(TOTAL_STEPS, Math.max(1, Math.round(stored.step)))
        : 1,
    restaurant: { ...base.restaurant, ...(stored.restaurant || {}) },
    menu: {
      categories: Array.isArray(stored.menu?.categories)
        ? (stored.menu!.categories.map((c) => ({
            id: c.id || uid(),
            name: c.name || 'Untitled',
            icon: c.icon || '🍽️',
            items: Array.isArray(c.items)
              ? c.items.map((i) => ({
                  id: i.id || uid(),
                  name: i.name || '',
                  description: i.description ?? null,
                  // A flagged-but-zero price from an older draft becomes null
                  // again: it is not a price, it is the absence of one.
                  price:
                    typeof i.price === 'number' && Number.isFinite(i.price)
                      ? i.priceUnreadable && i.price === 0
                        ? null
                        : i.price
                      : null,
                  priceUnreadable: i.priceUnreadable === true,
                  veg: i.veg ?? null,
                  confidence: i.confidence === 'low' ? 'low' : 'high',
                  variants: Array.isArray(i.variants) ? i.variants : [],
                  addOns: Array.isArray(i.addOns) ? i.addOns : [],
                  tags: sanitizeMenuTags(i.tags),
                }))
              : [],
          })))
        : [],
    },
    customize: { ...base.customize, ...(stored.customize || {}) },
    qr: { ...base.qr, ...(stored.qr || {}) },
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

const HEIC_RE = /\.(heic|heif)$/i

function isHeicFile(file: File): boolean {
  return (
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    HEIC_RE.test(file.name)
  )
}

/** A decode that must never be allowed to run forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Decode through the browser's own image pipeline and re-encode as JPEG.
 * On an iPhone this is the OS decoder — fast and exact, EXIF orientation
 * included. Desktop browsers that cannot read HEIC fail fast via onerror,
 * which is what the WASM fallback is for.
 */
function decodeViaImageElement(file: File): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    const cleanup = () => URL.revokeObjectURL(url)
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx || !img.naturalWidth || !img.naturalHeight) {
          throw new Error('nothing decoded')
        }
        ctx.drawImage(img, 0, 0)
        canvas.toBlob(
          (blob) => {
            cleanup()
            blob ? resolve(blob) : reject(new Error('JPEG encode failed'))
          },
          'image/jpeg',
          0.9,
        )
      } catch (err) {
        cleanup()
        reject(err)
      }
    }
    img.onerror = () => {
      cleanup()
      reject(new Error('browser cannot read this HEIC file'))
    }
    img.src = url
  })
}

/**
 * iPhone photos arrive as HEIC. The primary AI reader accepts them, but the
 * backup reader (and browsers generally) do not — and a scan that only
 * works when the primary is not busy is a scan that fails exactly when the
 * restaurant is standing there waiting. Convert HEIC to JPEG in the
 * browser, before upload, so every reader always gets a format it accepts.
 *
 * The path matters. On the iPhone itself the OS decodes HEIC, so the
 * browser's own image pipeline handles it natively — instant and reliable.
 * The fallback for browsers with no HEIC support (desktop Chrome/Firefox)
 * is heic-decode, a WASM libheif build — lazy-loaded, and run under a hard
 * timeout. (heic2any, the previous fallback, bundles a 2017 asm.js libheif
 * whose decode promise silently never settles on modern x265 HEIC — the
 * exact code path that used to sit on "Converting iPhone photo…" forever.)
 */
async function fileToUploadableDataUrl(file: File): Promise<string> {
  if (!isHeicFile(file)) return fileToDataUrl(file)
  let blob: Blob
  try {
    blob = await withTimeout(decodeViaImageElement(file), 10_000, 'Photo decode')
  } catch {
    // The browser cannot read HEIC itself — desktop Chrome/Firefox. Fall
    // back to the bundled WASM decoder, still under a hard timeout.
    blob = await withTimeout(heicToJpegViaWasm(file), 25_000, 'Photo conversion')
  }
  return fileToDataUrl(
    new File([blob], file.name.replace(HEIC_RE, '.jpg'), { type: 'image/jpeg' }),
  )
}

/** heic-decode: WASM libheif + libde265, decodes modern x265 HEIC. */
async function heicToJpegViaWasm(file: File): Promise<Blob> {
  const { default: decodeHeic } = await import('heic-decode')
  // The decoder wants a typed array — a raw ArrayBuffer's slice() is not
  // iterable, which kills its format check with a confusing TypeError.
  const buffer = new Uint8Array(await file.arrayBuffer())
  const { width, height, data } = await decodeHeic({ buffer })
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  const imageData = ctx.createImageData(width, height)
  imageData.data.set(data)
  ctx.putImageData(imageData, 0, 0)
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('JPEG encode failed'))),
      'image/jpeg',
      0.9,
    ),
  )
}

/**
 * Guess a category icon from its name.
 *
 * Indian menu vocabulary is matched first, so "Biryani", "Tandoori" and "Naan"
 * are recognised before a generic term can claim them. The Western terms are
 * kept as a fallback — a restaurant is free to have a pizza section.
 */
function categoryIconFor(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('biryani') || n.includes('pulao') || n.includes('rice')) return '🍚'
  if (n.includes('tandoor') || n.includes('kebab') || n.includes('tikka') || n.includes('grill') || n.includes('bbq')) return '🍢'
  if (n.includes('bread') || n.includes('naan') || n.includes('roti') || n.includes('paratha')) return '🫓'
  if (n.includes('dessert') || n.includes('sweet') || n.includes('mithai')) return '🍮'
  if (n.includes('beverage') || n.includes('drink') || n.includes('chai') || n.includes('lassi') || n.includes('juice')) return '🫖'
  if (n.includes('starter') || n.includes('appet') || n.includes('salad') || n.includes('chaat')) return '🥗'
  if (n.includes('thali') || n.includes('main') || n.includes('curry') || n.includes('masala') || n.includes('dal')) return '🍛'
  if (n.includes('soup') || n.includes('shorba')) return '🍲'
  if (n.includes('paneer') || n.includes('cheese')) return '🧀'
  if (n.includes('seafood') || n.includes('fish') || n.includes('prawn')) return '🍤'
  if (n.includes('chicken') || n.includes('mutton') || n.includes('meat')) return '🍗'
  if (n.includes('dosa') || n.includes('idli') || n.includes('south indian')) return '🥘'
  if (n.includes('chinese') || n.includes('noodle') || n.includes('manchurian')) return '🍜'
  if (n.includes('pizza')) return '🍕'
  if (n.includes('burger')) return '🍔'
  if (n.includes('grill')) return '🍢'
  return '🍽️'
}

/* ================================================================== */
/* Root component                                                      */
/* ================================================================== */

export interface OnboardingFlowProps {
  isLocationMode?: boolean
  onCancel?: () => void
  onCompleteLocation?: (newLocation: any) => void
}

export function OnboardingFlow({
  isLocationMode = false,
  onCancel,
  onCompleteLocation,
}: OnboardingFlowProps = {}) {
  /**
   * The draft's save clock, and the two facts the server-mirror adoption has
   * to know: what the browser's own draft said when the page loaded, and
   * whether the owner has typed anything since. The server keeps a mirror of
   * the draft so setup survives the email-confirmation gap and the device
   * boundary — a copy that is newer than what this browser loaded, and that
   * arrives before any local editing, wins.
   */
  const mountUpdatedAtRef = useRef<number>(0)
  const userEditedRef = useRef(false)
  const [data, setData] = useState<OnboardingData>(() => {
    if (typeof window === 'undefined') return defaultData()
    if (isLocationMode) {
      const def = defaultData()
      def.restaurant.name = 'The Salad Bistro - Branch'
      def.restaurant.cuisine = 'Salads & Healthy Bowls'
      return def
    }
    try {
      const raw = readStored('onboarding')
      return hydrate(raw ? (JSON.parse(raw) as Partial<OnboardingData>) : null)
    } catch {
      return defaultData()
    }
  })

  // What the browser's own draft said when the page loaded. This is state —
  // reading storage in an initializer is allowed; writing a ref there is
  // not. The initializer sees storage exactly as the page found it (effects
  // — and therefore the autosave's first write — have not run yet), so the
  // stamp survives the autosave overwriting the draft a moment later.
  const [mountStamp] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    try {
      const raw = readStored('onboarding')
      const stored = raw ? (JSON.parse(raw) as any) : null
      return stored && typeof stored.updatedAt === 'number' ? stored.updatedAt : 0
    } catch {
      return 0
    }
  })
  useEffect(() => {
    mountUpdatedAtRef.current = mountStamp
  }, [mountStamp])

  // The app theme, applied here because the wizard renders without the app
  // shell — which is where it is normally put on the document — so the setup
  // screens ignored the owner's palette and offered no way to change it.
  // initTheme applies the stored choice (dark is the app's default), the
  // header toggle flips it instantly for every step, and applyTheme keeps it
  // in localStorage so a reload keeps it too. The server copy (pref_theme)
  // belongs to Settings: a tenant may not even exist while the wizard runs,
  // so the browser is the only honest place to keep it here.
  const [wizardDark, setWizardDark] = useState(false)
  useEffect(() => {
    initTheme()
    setWizardDark(document.documentElement.classList.contains('dark'))
  }, [])
  const toggleWizardTheme = useCallback(() => {
    const next = !wizardDark
    applyTheme(next ? 'dark' : 'light')
    setWizardDark(next)
  }, [wizardDark])

  // Autosave on every change — localStorage immediately, the server mirror
  // debounced so a fast typist makes one call, not one per keystroke.
  useEffect(() => {
    const updatedAt = Date.now()
    try {
      writeStored('onboarding', JSON.stringify({ ...data, updatedAt }))
    } catch {
      /* quota / private mode — ignore */
    }
    if (!data.ownerId) return
    const timer = window.setTimeout(() => {
      // The server copy is the cross-device one. Photos (base64 data URLs)
      // can dwarf the text, so they are the first thing dropped when the
      // payload is too large — the browser draft keeps them locally.
      const payload: any = { ...data, updatedAt }
      if (JSON.stringify(payload).length > 200_000) {
        payload.restaurant = { ...payload.restaurant, logo: '' }
        payload.menu = {
          categories: payload.menu.categories.map((c: any) => ({
            ...c,
            items: c.items.map(({ image: _image, ...rest }: any) => rest),
          })),
        }
      }
      if (JSON.stringify(payload).length > 200_000) return
      edgeFetch('/api/onboarding/draft', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: payload }),
      }).catch(() => {
        /* the local draft still covers this browser */
      })
    }, 900)
    return () => window.clearTimeout(timer)
  }, [data])

  // The server's copy of the draft — a fresh browser (the email link opened on
  // another device, a cleared cache) resumes at the exact step instead of
  // starting over. Whichever copy was saved last wins.
  useEffect(() => {
    if (!data.ownerId) return
    let cancelled = false
    edgeFetch('/api/onboarding/draft')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: any) => {
        if (cancelled) return
        const server = body?.draft
        if (!server?.data) return
        // A draft belongs to the account that wrote it — the same rule the
        // localStorage draft follows.
        if (server.data.ownerId && server.data.ownerId !== data.ownerId) return
        // Once the owner has edited on this browser, this browser's copy is
        // the live one — its own saves will win on the server going forward.
        if (userEditedRef.current) return
        if ((server.updatedAt ?? 0) <= (mountUpdatedAtRef.current ?? 0)) return
        mountUpdatedAtRef.current = server.updatedAt ?? 0
        setData(hydrate(server.data))
      })
      .catch(() => {
        /* offline / not signed in — the local draft still covers this browser */
      })
    return () => {
      cancelled = true
    }
  }, [data.ownerId])

  // Fill in what the account already knows, and make sure the local draft is
  // this account's.
  //
  // The sign-up form collected the name, the email and the restaurant name,
  // and the register route put them in the database — and then the setup flow
  // asked for all three again, empty. This reads them back so they arrive
  // filled, and every field stays editable.
  //
  // It is also the only place that can tell whose draft is in the browser: the
  // account id arrives here and nowhere earlier. A draft written by another
  // account — or one from before drafts were stamped — is discarded rather than
  // resumed, so a new account starts at step 1 with its own details instead of
  // someone else's halfway through.
  useEffect(() => {
    let cancelled = false
    edgeFetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: any) => {
        if (cancelled || !body?.authenticated) return
        const t = body.tenant
        const u = body.user
        if (!t && !u) return
        setData((prev) => {
          const mine = Boolean(prev.ownerId) && prev.ownerId === u?.id
          const base = mine ? prev : defaultData()
          return {
          ...base,
          ownerId: u?.id || prev.ownerId,
          step: mine ? base.step : 1,
          restaurant: {
            ...base.restaurant,
            ownerName: base.restaurant.ownerName || u?.name || '',
            name: base.restaurant.name || t?.name || '',
            email: base.restaurant.email || t?.email || u?.email || '',
            phone: base.restaurant.phone || t?.phone || '',
            address: base.restaurant.address || t?.address || '',
            logo: base.restaurant.logo || t?.logo || '',
            gstin: base.restaurant.gstin || t?.gstin || '',
            fssai: base.restaurant.fssai || t?.fssai || '',
          },
          customize: mine
            ? base.customize
            : {
                ...base.customize,
                // The theme the restaurant has saved. It was seeded for currency,
                // symbol, tax and service charge and not for this, so the step
                // always opened on its own default: a restaurant using the dark
                // menu was shown "Light Mode · Selected", and saving that step
                // put it back.
                theme: normaliseMenuTheme(t?.menuTheme),
                currency: t?.currency || base.customize.currency,
                currencySymbol: t?.currencySymbol || base.customize.currencySymbol,
                taxRate:
                  typeof t?.taxRate === 'number' ? t.taxRate : base.customize.taxRate,
                serviceCharge:
                  typeof t?.serviceCharge === 'number'
                    ? t.serviceCharge
                    : base.customize.serviceCharge,
              },
        }
        })
      })
      .catch(() => {
        /* the account could not be read — the form still works, just empty */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const step = data.step
  const progress = Math.round((step / TOTAL_STEPS) * 100)

  const setRestaurant = useCallback((patch: Partial<RestaurantDraft>) => {
    userEditedRef.current = true
    setData((prev) => ({
      ...prev,
      restaurant: { ...prev.restaurant, ...patch },
    }))
  }, [])

  const setCustomize = useCallback((patch: Partial<CustomizeDraft>) => {
    userEditedRef.current = true
    setData((prev) => ({
      ...prev,
      customize: { ...prev.customize, ...patch },
    }))
  }, [])

  const setQr = useCallback((patch: Partial<QrDraft>) => {
    userEditedRef.current = true
    setData((prev) => ({ ...prev, qr: { ...prev.qr, ...patch } }))
  }, [])

  const setMenu = useCallback(
    (updater: (prev: { categories: CategoryDraft[] }) => { categories: CategoryDraft[] }) => {
      userEditedRef.current = true
      setData((prev) => ({ ...prev, menu: updater(prev.menu) }))
    },
    [],
  )

  const goNext = useCallback(() => {
    userEditedRef.current = true
    setData((prev) => ({ ...prev, step: Math.min(TOTAL_STEPS, prev.step + 1) }))
  }, [])

  const goBack = useCallback(() => {
    userEditedRef.current = true
    setData((prev) => ({ ...prev, step: Math.max(1, prev.step - 1) }))
  }, [])

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* ambient gradient backdrop */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 opacity-60"
        style={{
          background:
            'radial-gradient(60rem 40rem at 15% -10%, rgba(255,126,107,0.10), transparent 60%), radial-gradient(50rem 35rem at 100% 0%, rgba(192,132,252,0.06), transparent 55%)',
        }}
      />

      {/* progress header */}
      <ProgressHeader
        step={step}
        progress={progress}
        wizardDark={wizardDark}
        onToggleTheme={toggleWizardTheme}
        isLocationMode={isLocationMode}
        onCancel={onCancel}
      />

      {/* main */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-2xl">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            >
              {step === 1 && (
                <StepRestaurant
                  restaurant={data.restaurant}
                  setRestaurant={setRestaurant}
                  onNext={goNext}
                />
              )}
              {step === 2 && (
                <StepMenu
                  menu={data.menu}
                  setMenu={setMenu}
                  currencySymbol={data.customize.currencySymbol}
                  onNext={goNext}
                  onBack={goBack}
                />
              )}
              {step === 3 && (
                <StepCustomize
                  customize={data.customize}
                  setCustomize={setCustomize}
                  onNext={goNext}
                  onBack={goBack}
                />
              )}
              {step === 4 && (
                <StepQr
                  restaurant={data.restaurant}
                  qr={data.qr}
                  setQr={setQr}
                  onNext={goNext}
                  onBack={goBack}
                />
              )}
              {step === 5 && (
                <StepGoLive
                  restaurant={data.restaurant}
                  data={data}
                  isLocationMode={isLocationMode}
                  onCompleteLocation={onCompleteLocation}
                  onRestart={() => {
                    userEditedRef.current = true
                    setData((prev) => ({ ...defaultData(), ownerId: prev.ownerId }))
                  }}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {/* footer hint */}
      <footer className="px-4 py-4 text-center text-[11px] text-muted-foreground/70">
        The Salad Onboarding · auto-saved locally
      </footer>
    </div>
  )
}

/* ================================================================== */
/* Progress header                                                     */
/* ================================================================== */

function ProgressHeader({
  step,
  progress,
  wizardDark,
  onToggleTheme,
  isLocationMode,
  onCancel,
}: {
  step: number
  progress: number
  wizardDark: boolean
  onToggleTheme: () => void
  isLocationMode?: boolean
  onCancel?: () => void
}) {
  const meta = STEP_META[step - 1] ?? STEP_META[0]
  return (
    <header className="sticky top-0 z-30 glass-strong border-b border-border">
      <div className="mx-auto max-w-3xl px-4 py-3 sm:py-4">
        <div className="flex items-center justify-between gap-3 mb-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative grid place-items-center w-8 h-8 rounded-lg bg-primary/15 border border-primary/30">
              <Store className="w-4 h-4 text-primary" />
              <span className="absolute -inset-0.5 rounded-lg pulse-ring opacity-50" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground leading-none mb-1">
                {isLocationMode ? 'The Salad · Add Location (Pro Plan)' : 'The Salad Onboarding'}
              </p>
              <h2 className="text-sm sm:text-base font-semibold truncate">
                {isLocationMode && step === 1 ? 'New Branch Details' : meta.title}{' '}
                <span className="text-muted-foreground font-normal">
                  · {isLocationMode && step === 1 ? 'Configure new restaurant location' : meta.subtitle}
                </span>
              </h2>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isLocationMode && onCancel && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onCancel}
                className="h-8 px-2.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <X className="mr-1 size-3.5" /> Cancel
              </Button>
            )}
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={wizardDark ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-pressed={wizardDark}
              title={wizardDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="grid place-items-center w-8 h-8 rounded-lg border border-border bg-secondary/40 text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground"
            >
              {wizardDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <Badge variant="secondary" className="tabular-nums">
              Step {step} / {TOTAL_STEPS}
            </Badge>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Progress value={progress} className="h-2" />
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">{progress}%</span>
        </div>

        {/* step dots */}
        <div className="hidden sm:flex items-center gap-1.5 mt-3">
          {STEP_META.map((s, i) => {
            const n = i + 1
            const done = n < step
            const active = n === step
            return (
              <div key={n} className="flex-1 group">
                <div
                  className={cn(
                    'h-1 rounded-full transition-premium',
                    done && 'bg-primary/60',
                    active && 'bg-primary shadow-glow-primary',
                    !done && !active && 'bg-border',
                  )}
                />
                <p
                  className={cn(
                    'mt-1.5 text-[10px] truncate transition-premium',
                    active ? 'text-primary font-medium' : 'text-muted-foreground',
                  )}
                >
                  {s.title}
                </p>
              </div>
            )
          })}
        </div>
      </div>
    </header>
  )
}

/* ================================================================== */
/* Card shell                                                          */
/* ================================================================== */

interface StepCardProps {
  children: React.ReactNode
  footer?: React.ReactNode
}

function StepCard({ children, footer }: StepCardProps) {
  return (
    <Card className="card-premium shadow-elevated border-border overflow-hidden">
      <div className="p-5 sm:p-6">{children}</div>
      {footer && (
        <>
          <Separator className="bg-border" />
          <div className="p-4 sm:px-6 bg-secondary/30 flex items-center justify-between gap-3">
            {footer}
          </div>
        </>
      )}
    </Card>
  )
}

/* ================================================================== */
/* Step 1 — Restaurant                                                 */
/* ================================================================== */

interface StepRestaurantProps {
  restaurant: RestaurantDraft
  setRestaurant: (patch: Partial<RestaurantDraft>) => void
  onNext: () => void
}

function StepRestaurant({ restaurant, setRestaurant, onNext }: StepRestaurantProps) {
  const nameValid = restaurant.name.trim().length > 1

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!nameValid) {
      toast.error('Restaurant name is required')
      return
    }
    onNext()
  }

  return (
    <form onSubmit={handleSubmit}>
      <StepCard
        footer={
          <>
            <span className="text-xs text-muted-foreground">Fields marked * are required</span>
            <Button type="submit" disabled={!nameValid} className="gap-2">
              Continue
              <ChevronRight className="w-4 h-4" />
            </Button>
          </>
        }
      >
        <StepHeading
          icon={<Store className="w-5 h-5" />}
          eyebrow="Step 1"
          title="Create your restaurant"
          desc="Set up the basics — you can edit any of this later from Settings."
        />

        <div className="space-y-5 mt-6">
          <ImageUpload
            label="Logo"
            value={restaurant.logo}
            onChange={(v) => setRestaurant({ logo: v })}
            shape="circle"
            size={80}
            fallback="🍴"
            accept="image/png,image/jpeg,image/webp"
          />

          <Field label="Restaurant Name" required>
            <Input
              value={restaurant.name}
              onChange={(e) => setRestaurant({ name: e.target.value })}
              placeholder="e.g. Jaegar Resto"
              autoFocus
            />
          </Field>

          <Field label="Your Name" hint="from your account">
            <Input
              value={restaurant.ownerName}
              onChange={(e) => setRestaurant({ ownerName: e.target.value })}
              placeholder="e.g. Priyanshu"
              autoComplete="name"
            />
          </Field>

          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Phone">
              <PhoneInput
                value={restaurant.phone}
                onChange={(v) => setRestaurant({ phone: v })}
                placeholder="98765 43210"
              />
            </Field>
            <Field label="Email">
              <Input
                value={restaurant.email}
                onChange={(e) => setRestaurant({ email: e.target.value })}
                placeholder="hello@jaegar.com"
                inputMode="email"
                type="email"
              />
            </Field>
          </div>

          <Field label="Address">
            <Textarea
              value={restaurant.address}
              onChange={(e) => setRestaurant({ address: e.target.value })}
              placeholder="123 Market Street, San Francisco, CA"
              rows={2}
            />
          </Field>

          <Field label="Cuisine Type">
            <Select
              value={restaurant.cuisine}
              onValueChange={(v) => setRestaurant({ cuisine: v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a cuisine" />
              </SelectTrigger>
              <SelectContent>
                {CUISINES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Separator className="bg-border my-1" />
          <p className="text-xs text-muted-foreground">
            Compliance details (optional) — required by some regions to print on receipts.
          </p>

          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="GST Number" hint="Uppercase · max 15 chars">
              <Input
                value={restaurant.gstin}
                onChange={(e) =>
                  setRestaurant({ gstin: e.target.value.toUpperCase().slice(0, 15) })
                }
                placeholder="22AAAAA0000A1Z5"
                maxLength={15}
                className="uppercase tracking-wider"
              />
            </Field>
            <Field label="FSSAI License No." hint="Max 14 chars">
              <Input
                value={restaurant.fssai}
                onChange={(e) => setRestaurant({ fssai: e.target.value.slice(0, 14) })}
                placeholder="10020065000123"
                maxLength={14}
                className="tracking-wider"
              />
            </Field>
          </div>
        </div>
      </StepCard>
    </form>
  )
}

/* ================================================================== */
/* Step 2 — Menu (AI / manual)                                         */
/* ================================================================== */

type MenuPhase = 'choose' | 'ai' | 'processing' | 'review'

interface StepMenuProps {
  menu: { categories: CategoryDraft[] }
  setMenu: (updater: (prev: { categories: CategoryDraft[] }) => { categories: CategoryDraft[] }) => void
  /** The symbol prices are shown in, from the Customize step. */
  currencySymbol: string
  onNext: () => void
  onBack: () => void
}

function StepMenu({ menu, setMenu, currencySymbol, onNext, onBack }: StepMenuProps) {
  // Resume directly to review if we already have extracted categories.
  const [phase, setPhase] = useState<MenuPhase>(
    menu.categories.length > 0 ? 'review' : 'choose',
  )

  /**
   * The running extraction, so it can be stopped.
   *
   * The controller lives here rather than in the uploader because the uploader
   * is unmounted the moment the scan starts — the processing screen replaces it
   * — while the request is still in flight. Both Back and Cancel used to be
   * dead during that window: Back handled every phase except `processing`, and
   * Cancel was disabled for exactly that phase, so a slow scan left the owner
   * with no way out at all.
   */
  const scanRef = useRef<AbortController | null>(null)

  const beginScan = useCallback(() => {
    scanRef.current?.abort()
    scanRef.current = new AbortController()
    return scanRef.current.signal
  }, [])

  const cancelScan = useCallback(() => {
    scanRef.current?.abort()
    scanRef.current = null
    setPhase('choose')
  }, [])

  const handleBack = () => {
    if (phase === 'choose') onBack()
    else if (phase === 'processing') cancelScan()
    else setPhase('choose')
  }

  return (
    <StepCard
      footer={
        <>
          <Button type="button" variant="ghost" onClick={handleBack} className="gap-2">
            <ChevronLeft className="w-4 h-4" />
            Back
          </Button>
          {phase === 'choose' && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setMenu(() => ({ categories: [] }))
                toast.success('Manual mode — you can add items later from the Menu view')
                onNext()
              }}
              className="gap-2"
            >
              Skip for now
              <ChevronRight className="w-4 h-4" />
            </Button>
          )}
          {phase === 'review' && (
            <Button type="button" onClick={onNext} className="gap-2">
              Create My Menu
              <ChevronRight className="w-4 h-4" />
            </Button>
          )}
          {(phase === 'ai' || phase === 'processing') && (
            <Button type="button" variant="ghost" onClick={cancelScan}>
              Cancel
            </Button>
          )}
        </>
      }
    >
      <StepHeading
        icon={<Utensils className="w-5 h-5" />}
        eyebrow="Step 2"
        title="Build your menu"
        desc="Import an existing menu with AI vision, or start from scratch."
      />

      <div className="mt-6">
        <AnimatePresence mode="wait">
          {phase === 'choose' && (
            <motion.div
              key="choose"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="grid sm:grid-cols-2 gap-4"
            >
              <MenuOptionCard
                highlighted
                icon={<Sparkles className="w-6 h-6" />}
                title="Import Menu with AI"
                desc="Upload photos or PDFs of your menu — our AI reads items, prices & categories automatically."
                cta="Start AI import"
                onClick={() => setPhase('ai')}
              />
              <MenuOptionCard
                icon={<Pencil className="w-6 h-6" />}
                title="Create Menu Manually"
                desc="Start with an empty menu and add items one by one from the dashboard."
                cta="Skip to dashboard"
                onClick={() => {
                  setMenu(() => ({ categories: [] }))
                  toast.success('You can add items later from the Menu view')
                  onNext()
                }}
              />
            </motion.div>
          )}

          {phase === 'ai' && (
            <motion.div
              key="ai"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <MenuAiUploader
                beginScan={beginScan}
                onProcessing={() => setPhase('processing')}
                onExtracted={(categories) => {
                  setMenu(() => ({ categories }))
                  setPhase('review')
                  const count = categories.reduce((n, c) => n + c.items.length, 0)
                  toast.success(`Extracted ${count} items across ${categories.length} categories`)
                }}
                onCancel={() => setPhase('choose')}
              />
            </motion.div>
          )}

          {phase === 'processing' && (
            <motion.div
              key="processing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <ProcessingState />
            </motion.div>
          )}

          {phase === 'review' && (
            <motion.div
              key="review"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <MenuReview menu={menu} setMenu={setMenu} currencySymbol={currencySymbol} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </StepCard>
  )
}

function MenuOptionCard({
  icon,
  title,
  desc,
  cta,
  onClick,
  highlighted,
}: {
  icon: React.ReactNode
  title: string
  desc: string
  cta: string
  onClick: () => void
  highlighted?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative text-left rounded-2xl p-5 border transition-premium overflow-hidden focus-ring',
        highlighted
          ? 'border-primary/60 bg-primary/[0.06] shadow-glow-primary'
          : 'border-border bg-secondary/30 hover:border-primary/40 hover:bg-secondary/50',
      )}
    >
      {highlighted && (
        <span className="absolute top-3 right-3">
          <Badge className="bg-primary/15 text-primary border-primary/30">
            <Sparkles className="w-3 h-3 mr-1" /> Recommended
          </Badge>
        </span>
      )}
      <div
        className={cn(
          'w-12 h-12 rounded-xl grid place-items-center mb-3 transition-premium',
          highlighted
            ? 'bg-primary/15 text-primary'
            : 'bg-secondary text-muted-foreground group-hover:text-primary',
        )}
      >
        {icon}
      </div>
      <h3 className="font-semibold text-base mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground mb-4 leading-relaxed">{desc}</p>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-sm font-medium transition-premium',
          highlighted ? 'text-primary' : 'text-foreground group-hover:text-primary',
        )}
      >
        {cta}
        <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* AI uploader                                                         */
/* ------------------------------------------------------------------ */

function MenuAiUploader({
  beginScan,
  onProcessing,
  onExtracted,
  onCancel,
}: {
  beginScan: () => AbortSignal
  onProcessing: () => void
  onExtracted: (categories: CategoryDraft[]) => void
  onCancel: () => void
}) {
  const [images, setImages] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter(
        (f) =>
          f.type.startsWith('image/') ||
          f.type === 'application/pdf' ||
          f.name.toLowerCase().endsWith('.pdf') ||
          isHeicFile(f),
      )
      if (list.length === 0) {
        toast.error('Only images and PDFs are supported')
        return
      }
      if (images.length + list.length > 10) {
        toast.error('Maximum 10 files allowed')
        return
      }
      // One stuck file must not take the batch down: convert one at a time
      // (a phone decodes big photos more reliably sequentially than ten at
      // once), keep what works, name what failed. The converting toast is a
      // loading toast with a fixed id — it is dismissed in `finally`, so it
      // can never be left behind by a slow or hanging decode.
      const heicCount = list.filter(isHeicFile).length
      if (heicCount > 0) {
        toast.loading(
          heicCount === 1 ? 'Converting iPhone photo…' : `Converting ${heicCount} iPhone photos…`,
          { id: 'heic-convert' },
        )
      }
      try {
        const added: string[] = []
        const failed: string[] = []
        for (const file of list) {
          try {
            added.push(await fileToUploadableDataUrl(file))
          } catch (err) {
            console.error('could not use upload:', file.name, err)
            failed.push(file.name)
          }
        }
        if (added.length > 0) setImages((prev) => [...prev, ...added])
        if (failed.length > 0) {
          toast.error(
            failed.length === 1
              ? `${failed[0]} could not be used`
              : `${failed.length} files could not be used`,
            {
              description:
                'On the iPhone: open the photo, tap Share, choose Options → Most Compatible (or save it as JPG), then upload that.',
            },
          )
        }
      } finally {
        toast.dismiss('heic-convert')
      }
    },
    [images.length],
  )

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files)
  }

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
  }

  const extract = async () => {
    if (images.length === 0) {
      toast.error('Upload at least one menu image first')
      return
    }
    // The signal belongs to the step, so Back and Cancel can stop this.
    const signal = beginScan()
    onProcessing()
    try {
      const res = await edgeFetch(
        '/api/ai-extract-menu',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images }),
          signal,
        },
        // Reading a menu out of photos takes far longer than a normal call.
        120_000,
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error || `Extraction failed (${res.status})`)
      }
      const json = (await res.json()) as {
        categories: Array<{
          name: string
          icon: string
          items: Array<{
            name: string
            description: string | null
            price: number | null
            priceUnreadable?: boolean
            veg: boolean | null
            confidence: Confidence
            variants: ExtractedVariant[]
            addOns: ExtractedAddOn[]
            tags: string[]
          }>
        }>
      }

      const categories: CategoryDraft[] = (json.categories || []).map((c) => ({
        id: uid(),
        name: c.name || 'Uncategorized',
        icon: c.icon || categoryIconFor(c.name || ''),
        items: (c.items || [])
          .filter((i) => i.name)
          .map((i) => ({
            id: uid(),
            name: i.name,
            description: i.description ?? null,
            // The extractor now sends null for a price it could not read,
            // and the derived minimum when portion prices exist. Both pass
            // through untouched — nothing becomes ₹0 here.
            price:
              typeof i.price === 'number' && Number.isFinite(i.price)
                ? i.price
                : null,
            priceUnreadable: i.priceUnreadable === true,
            veg: i.veg ?? null,
            confidence: i.confidence === 'low' ? 'low' : 'high',
            variants: Array.isArray(i.variants) ? i.variants : [],
            addOns: Array.isArray(i.addOns) ? i.addOns : [],
            tags: sanitizeMenuTags(i.tags),
          })),
      }))

      if (categories.length === 0) {
        throw new Error('No menu items found in the images')
      }
      onExtracted(categories)
    } catch (e: any) {
      // The owner cancelled, so there is nothing to report — and no error to
      // show them for a request they deliberately stopped.
      if (signal.aborted) return
      toast.error('AI extraction failed', { description: e?.message })
      onCancel()
    }
  }

  return (
    <div className="space-y-4">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,.heic,.heif,.pdf,application/pdf"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) handleFiles(e.target.files)
          if (inputRef.current) inputRef.current.value = ''
        }}
      />

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition-premium',
          dragOver
            ? 'border-primary bg-primary/10'
            : 'border-border bg-secondary/20 hover:border-primary/40 hover:bg-secondary/30',
        )}
      >
        <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/15 text-primary grid place-items-center mb-3">
          <ScanLine className="w-7 h-7" />
        </div>
        <p className="font-medium">Drop menu photos or PDFs here</p>
        <p className="text-xs text-muted-foreground mt-1">
          Click to browse · up to 10 files · JPG, PNG, WEBP, PDF, iPhone photos
        </p>
      </div>

      {images.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-muted-foreground">
              {images.length} file{images.length === 1 ? '' : 's'} ready
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setImages([])}
            >
              Clear all
            </Button>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5 max-h-64 overflow-y-auto scrollbar-thin pr-1">
            {images.map((src, i) => (
              <div
                key={i}
                className="relative aspect-[3/4] rounded-lg overflow-hidden border border-border bg-secondary group"
              >
                {src.startsWith('data:application/pdf') ? (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-1 p-2 text-center">
                    <FileImage className="w-7 h-7 text-primary/80" />
                    <span className="text-[10px] text-muted-foreground truncate w-full">
                      PDF {i + 1}
                    </span>
                  </div>
                ) : (
                  <img
                    src={src}
                    alt={`Menu page ${i + 1}`}
                    className="w-full h-full object-cover"
                  />
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeImage(i)
                  }}
                  className="absolute top-1 right-1 bg-background/90 backdrop-blur rounded-full p-1 text-muted-foreground hover:text-destructive transition-colors shadow"
                  aria-label="Remove file"
                >
                  <X className="w-3 h-3" />
                </button>
                <span className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent text-white text-[10px] px-2 py-1">
                  Page {i + 1}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Button
        type="button"
        onClick={extract}
        disabled={images.length === 0}
        className="w-full gap-2 shadow-glow-primary"
        size="lg"
      >
        <Wand2 className="w-4 h-4" />
        Extract Menu with AI
      </Button>
      <p className="text-[11px] text-muted-foreground text-center">
        Nothing is published yet — you will review every item before it goes live.
      </p>
    </div>
  )
}

function ProcessingState() {
  return (
    <div className="py-10 flex flex-col items-center text-center">
      <div className="relative w-20 h-20 mb-5">
        <div className="absolute inset-0 rounded-full border-2 border-primary/20" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-primary animate-spin" />
        <div className="absolute inset-3 rounded-full bg-primary/10 grid place-items-center pulse-ring">
          <Sparkles className="w-7 h-7 text-primary" />
        </div>
      </div>
      <h3 className="font-semibold text-lg mb-1">AI is reading your menu…</h3>
      <p className="text-sm text-muted-foreground max-w-sm">
        Scanning pages, identifying dishes, prices, categories and dietary tags. This usually
        takes 10–20 seconds.
      </p>
      <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Analyzing images…
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Menu review (editable)                                              */
/* ------------------------------------------------------------------ */

function MenuReview({
  menu,
  setMenu,
  currencySymbol,
}: {
  menu: { categories: CategoryDraft[] }
  setMenu: (
    updater: (prev: { categories: CategoryDraft[] }) => { categories: CategoryDraft[] },
  ) => void
  currencySymbol: string
}) {
  const totalItems = menu.categories.reduce((n, c) => n + c.items.length, 0)
  const lowConf = menu.categories.reduce(
    (n, c) => n + c.items.filter((i) => i.confidence === 'low').length,
    0,
  )

  const addCategory = () => {
    const name = `Category ${menu.categories.length + 1}`
    setMenu((prev) => ({
      categories: [
        ...prev.categories,
        { id: uid(), name, icon: categoryIconFor(name), items: [] },
      ],
    }))
    toast.success('Category added')
  }

  const removeCategory = (catId: string) => {
    setMenu((prev) => ({ categories: prev.categories.filter((c) => c.id !== catId) }))
    toast.success('Category removed')
  }

  const renameCategory = (catId: string, name: string) => {
    setMenu((prev) => ({
      categories: prev.categories.map((c) =>
        c.id === catId ? { ...c, name, icon: categoryIconFor(name) } : c,
      ),
    }))
  }

  const addItem = (catId: string) => {
    setMenu((prev) => ({
      categories: prev.categories.map((c) =>
        c.id === catId
          ? {
              ...c,
              items: [
                ...c.items,
                {
                  id: uid(),
                  name: '',
                  description: null,
                  price: null,
                  priceUnreadable: false,
                  veg: null,
                  confidence: 'high',
                  variants: [],
                  addOns: [],
                  tags: [],
                },
              ],
            }
          : c,
      ),
    }))
  }

  const updateItem = (catId: string, itemId: string, patch: Partial<MenuItemDraft>) => {
    setMenu((prev) => ({
      categories: prev.categories.map((c) =>
        c.id === catId
          ? { ...c, items: c.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) }
          : c,
      ),
    }))
  }

  const removeItem = (catId: string, itemId: string) => {
    setMenu((prev) => ({
      categories: prev.categories.map((c) =>
        c.id === catId ? { ...c, items: c.items.filter((i) => i.id !== itemId) } : c,
      ),
    }))
  }

  if (totalItems === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center">
        <ImageIcon className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground mb-4">
          No items yet. Add a category and start building your menu.
        </p>
        <Button type="button" onClick={addCategory} className="gap-2">
          <Plus className="w-4 h-4" /> Add Category
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="gap-1.5">
          <Utensils className="w-3 h-3" /> {menu.categories.length} categories
        </Badge>
        <Badge variant="secondary">{totalItems} items</Badge>
        {lowConf > 0 && (
          <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 gap-1.5">
            <ShieldAlert className="w-3 h-3" /> {lowConf} need verify
          </Badge>
        )}
      </div>

      <div className="space-y-3 max-h-[55vh] overflow-y-auto scrollbar-thin pr-1 -mr-1">
        {menu.categories.map((cat) => (
          <CategoryReviewCard
            currencySymbol={currencySymbol}
            key={cat.id}
            category={cat}
            onRename={(name) => renameCategory(cat.id, name)}
            onRemove={() => removeCategory(cat.id)}
            onAddItem={() => addItem(cat.id)}
            onUpdateItem={(itemId, patch) => updateItem(cat.id, itemId, patch)}
            onRemoveItem={(itemId) => removeItem(cat.id, itemId)}
          />
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={addCategory}
        className="w-full gap-2 border-dashed"
      >
        <Plus className="w-4 h-4" /> Add Category
      </Button>
    </div>
  )
}

function CategoryReviewCard({
  category,
  currencySymbol,
  onRename,
  onRemove,
  onAddItem,
  onUpdateItem,
  onRemoveItem,
}: {
  category: CategoryDraft
  currencySymbol: string
  onRename: (name: string) => void
  onRemove: () => void
  onAddItem: () => void
  onUpdateItem: (itemId: string, patch: Partial<MenuItemDraft>) => void
  onRemoveItem: (itemId: string) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(category.name)

  const enterRename = () => {
    // sync the local buffer with the (possibly externally updated) name
    setName(category.name)
    setRenaming(true)
  }

  return (
    <Card className="border-border bg-secondary/20 overflow-hidden">
      <div className="flex items-center gap-2.5 p-3 border-b border-border bg-secondary/30">
        <span className="text-lg leading-none">{category.icon}</span>
        {renaming ? (
          <Input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              onRename(name.trim() || 'Untitled')
              setRenaming(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRename(name.trim() || 'Untitled')
                setRenaming(false)
              }
              if (e.key === 'Escape') {
                setName(category.name)
                setRenaming(false)
              }
            }}
            className="h-8 max-w-xs"
          />
        ) : (
          <button
            type="button"
            onClick={enterRename}
            className="font-medium text-sm hover:text-primary transition-premium flex items-center gap-1.5 group"
          >
            {category.name}
            <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" />
          </button>
        )}
        <Badge variant="secondary" className="ml-auto text-[10px]">
          {category.items.length} items
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label="Delete category"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div className="p-3 space-y-2.5">
        {category.items.length === 0 && (
          <p className="text-xs text-muted-foreground py-2 text-center">
            No items in this category yet.
          </p>
        )}
        {category.items.map((item) => (
          <ItemReviewRow
            currencySymbol={currencySymbol}
            key={item.id}
            item={item}
            onUpdate={(patch) => onUpdateItem(item.id, patch)}
            onRemove={() => onRemoveItem(item.id)}
          />
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onAddItem}
          className="w-full gap-1.5 text-muted-foreground hover:text-primary"
        >
          <Plus className="w-3.5 h-3.5" /> Add item
        </Button>
      </div>
    </Card>
  )
}

function ItemReviewRow({
  item,
  currencySymbol,
  onUpdate,
  onRemove,
}: {
  item: MenuItemDraft
  /** Shown before the price: the currency chosen in the setup flow. */
  currencySymbol: string
  onUpdate: (patch: Partial<MenuItemDraft>) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(!item.name)

  const vegBadge = useMemo(() => {
    if (item.veg === true)
      return (
        <span className="inline-flex items-center gap-1 text-emerald-400 text-[11px] font-medium">
          <Leaf className="w-3 h-3" /> Veg
        </span>
      )
    if (item.veg === false)
      return (
        <span className="inline-flex items-center gap-1 text-rose-400 text-[11px] font-medium">
          <Drumstick className="w-3 h-3" /> Non-veg
        </span>
      )
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground text-[11px]">
        <span className="w-2 h-2 rounded-full bg-muted-foreground/50" /> Unknown
      </span>
    )
  }, [item.veg])

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-background/40 p-3 transition-premium',
        item.confidence === 'low' && 'ring-1 ring-amber-500/20',
      )}
    >
      {editing ? (
        <div className="space-y-2.5">
          <div className="grid grid-cols-[1fr_110px] gap-2">
            <Input
              value={item.name}
              placeholder="Item name"
              autoFocus
              onChange={(e) => onUpdate({ name: e.target.value })}
              className="h-8"
            />
            <div className="relative">
              <NumberInput
                value={item.price ?? 0}
                placeholder="0.00"
                min={0}
                step="0.01"
                // Typing a real price settles the verification flag — the
                // owner just did the verifying. Clearing the field returns
                // the dish to "no readable price" rather than ₹0.
                onChange={(price) =>
                  onUpdate({ price: price > 0 ? price : null, priceUnreadable: false })
                }
                className="h-8 pr-7"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                {currencySymbol}
              </span>
            </div>
          </div>
          <Textarea
            value={item.description || ''}
            placeholder="Short description (optional)"
            rows={2}
            onChange={(e) => onUpdate({ description: e.target.value || null })}
            className="text-xs"
          />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-2 text-xs cursor-pointer select-none">
                <Switch
                  checked={item.veg === true}
                  onCheckedChange={(checked) =>
                    onUpdate({ veg: checked ? true : item.veg === true ? false : null })
                  }
                />
                <span className="text-muted-foreground">Veg</span>
              </label>
              {item.variants.length > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {item.variants.length} variants
                </Badge>
              )}
              {item.addOns.length > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {item.addOns.length} add-ons
                </Badge>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5"
              onClick={() => {
                if (!item.name.trim()) {
                  toast.error('Item name cannot be empty')
                  return
                }
                setEditing(false)
              }}
            >
              <Check className="w-3.5 h-3.5" /> Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm truncate">{item.name || 'Untitled'}</span>
              {vegBadge}
              {item.confidence === 'low' && (
                <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px] gap-1">
                  <ShieldAlert className="w-3 h-3" /> Verify
                </Badge>
              )}
              {item.tags.slice(0, 2).map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px]">
                  {t}
                </Badge>
              ))}
            </div>
            {item.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                {item.description}
              </p>
            )}
            <div className="flex items-center gap-3 mt-1.5">
              <span
                className={cn(
                  'text-sm font-semibold',
                  item.priceUnreadable
                    ? 'text-amber-500'
                    : item.price == null
                      ? 'text-muted-foreground'
                      : 'text-primary',
                )}
              >
                {currencySymbol}
                {item.price == null ? '—' : item.price.toFixed(2)}
              </span>
              {item.priceUnreadable && (
                <span className="text-[11px] font-medium text-amber-500">
                  price not read — enter it
                </span>
              )}
            </div>
            {item.variants.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {item.variants.map((v) => (
                  <Badge
                    key={v.name}
                    variant="secondary"
                    className={cn(
                      'text-[10px]',
                      v.price == null && 'border-amber-500/40 text-amber-500',
                    )}
                  >
                    {v.name}
                    {v.price == null
                      ? ' · price?'
                      : ` · ${currencySymbol}${v.price.toFixed(2)}`}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-primary"
              onClick={() => setEditing(true)}
              aria-label="Edit item"
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              aria-label="Delete item"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ================================================================== */
/* Step 3 — Customize                                                  */
/* ================================================================== */

interface StepCustomizeProps {
  customize: CustomizeDraft
  setCustomize: (patch: Partial<CustomizeDraft>) => void
  onNext: () => void
  onBack: () => void
}

function StepCustomize({ customize, setCustomize, onNext, onBack }: StepCustomizeProps) {
  // The currency used to be a dropdown holding a single option — INR — which
  // is not a control, and on a phone it was a 36px window that could not be
  // opened at all. It is two fields now: a code and the symbol that goes
  // with it, both editable and both checked.
  const onCurrencyCode = (raw: string) => {
    const code = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)
    const known = CURRENCIES.find((x) => x.code === code)
    setCustomize({
      currency: code,
      // A known code carries its own symbol; anything else keeps the one the
      // owner already chose.
      currencySymbol: known ? known.symbol : customize.currencySymbol,
    })
  }

  const onCurrencySymbol = (raw: string) => {
    setCustomize({ currencySymbol: raw.slice(0, 3) })
  }

  return (
    <StepCard
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onBack} className="gap-2">
            <ChevronLeft className="w-4 h-4" /> Back
          </Button>
          <Button type="button" onClick={onNext} className="gap-2">
            Continue
            <ChevronRight className="w-4 h-4" />
          </Button>
        </>
      }
    >
      <StepHeading
        icon={<Settings2 className="w-5 h-5" />}
        eyebrow="Step 3"
        title="Customize the experience"
        desc="Pick how your menu looks and how customers can order."
      />

      <div className="space-y-5 mt-6">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field
            label="Menu Theme"
            hint="what your customers see"
            className="sm:col-span-2"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {MENU_THEMES.map((option) => {
                const selected = customize.theme === option.id
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setCustomize({ theme: option.id })}
                    aria-pressed={selected}
                    className={cn(
                      'group overflow-hidden rounded-xl border text-left transition',
                      selected
                        ? 'border-primary ring-2 ring-primary/25'
                        : 'border-border hover:border-primary/50',
                    )}
                  >
                    <MenuThemePreview theme={option.id} />
                    <div className="flex items-start gap-2 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold text-foreground">
                          {option.name}
                          {selected && (
                            <span className="ml-2 align-middle text-[10px] font-medium text-primary">
                              Selected
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                          {option.description}
                        </p>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </Field>
          <div className="grid grid-cols-[1fr_84px] gap-3">
            <Field label="Currency" hint="code, e.g. INR">
              <Input
                value={customize.currency}
                onChange={(e) => onCurrencyCode(e.target.value)}
                placeholder="INR"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                maxLength={3}
                className="uppercase"
              />
            </Field>
            <Field label="Symbol">
              <Input
                value={customize.currencySymbol}
                onChange={(e) => onCurrencySymbol(e.target.value)}
                placeholder="₹"
                inputMode="text"
                autoComplete="off"
                maxLength={3}
                className="text-center"
              />
            </Field>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Tax Rate (%)" hint="Applied on subtotal">
            <NumberInput
              min={0}
              max={100}
              step="0.1"
              value={customize.taxRate}
              onChange={(taxRate) => setCustomize({ taxRate })}
            />
          </Field>
          <Field label="Service Charge (%)" hint="Optional, on subtotal">
            <NumberInput
              min={0}
              max={100}
              step="0.1"
              value={customize.serviceCharge}
              onChange={(serviceCharge) => setCustomize({ serviceCharge })}
            />
          </Field>
        </div>

        <Separator className="bg-border my-1" />
        <p className="text-xs text-muted-foreground">Ordering settings</p>

        {/*
          "Online Ordering" and "Auto-Accept Orders" were removed here. Neither
          was saved — the setup flow's save writes the restaurant's name, contact,
          tax, currency and menu theme, and none of the ordering toggles — and
          nothing in the app reads the keys they would have set, so both were
          choices a new owner could make that changed nothing at all.

          The two that remain are in the same position: collected, then discarded.
          They are left in place because they were not part of this change.
        */}
        <div className="space-y-3">
          <ToggleRow
            title="Auto Accept Orders"
            desc="Automatically accept incoming table orders into the kitchen"
            checked={Boolean(customize.autoAcceptOrders)}
            onChange={(v) => setCustomize({ autoAcceptOrders: v })}
          />
          <ToggleRow
            title="Auto Bill Print"
            desc="Automatically print bill when session ends"
            checked={Boolean(customize.autoBillPrint)}
            onChange={(v) => setCustomize({ autoBillPrint: v })}
          />
        </div>
      </div>
    </StepCard>
  )
}

function ToggleRow({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-secondary/20 p-3.5">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="shrink-0" />
    </div>
  )
}

/* ================================================================== */
/* Step 4 — Generate QR                                                */
/* ================================================================== */

interface StepQrProps {
  restaurant: RestaurantDraft
  qr: QrDraft
  setQr: (patch: Partial<QrDraft>) => void
  onNext: () => void
  onBack: () => void
}

function StepQr({ restaurant, qr, setQr, onNext, onBack }: StepQrProps) {
  const count = Math.max(1, Math.min(60, qr.tableCount || 1))
  const tables = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        n: i + 1,
        name: `Table ${i + 1}`,
        token: `${restaurant.name?.slice(0, 8).toUpperCase() || 'TABLO'}-T${i + 1}`,
      })),
    [count, restaurant.name],
  )

  const generate = () => {
    setQr({ tableCount: count, generated: true })
    toast.success(`Generated ${count} QR code${count === 1 ? '' : 's'}`)
  }

  return (
    <StepCard
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onBack} className="gap-2">
            <ChevronLeft className="w-4 h-4" /> Back
          </Button>
          <Button type="button" onClick={onNext} className="gap-2">
            Continue
            <ChevronRight className="w-4 h-4" />
          </Button>
        </>
      }
    >
      <StepHeading
        icon={<QrCode className="w-5 h-5" />}
        eyebrow="Step 4"
        title="Generate QR codes"
        desc="Create a unique QR code for each dine-in table."
      />

      <div className="mt-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <Field label="Number of tables" className="flex-1">
            <NumberInput
              min={1}
              max={60}
              value={qr.tableCount}
              onChange={(tableCount) => setQr({ tableCount })}
            />
          </Field>
          <Button type="button" onClick={generate} className="gap-2 sm:w-auto w-full">
            <QrCode className="w-4 h-4" />
            {qr.generated ? 'Regenerate QR Codes' : 'Generate QR Codes'}
          </Button>
        </div>

        {qr.generated && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-3"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1.5">
                <Check className="w-3 h-3" /> {count} codes ready
              </Badge>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5 h-7"
                onClick={() =>
                  toast.success('QR codes downloaded', { description: `${count} files` })
                }
              >
                <Download className="w-3.5 h-3.5" /> Download All
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5 h-7"
                onClick={() => toast.success('Sent to print dialog')}
              >
                <Printer className="w-3.5 h-3.5" /> Print
              </Button>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 max-h-[44vh] overflow-y-auto scrollbar-thin p-1 -m-1">
              {tables.map((t) => (
                <QrPlaceholder
                  key={t.n}
                  tableName={t.name}
                  token={t.token}
                  restaurantName={restaurant.name}
                />
              ))}
            </div>
          </motion.div>
        )}

        {!qr.generated && (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            <QrCode className="w-7 h-7 mx-auto mb-2 opacity-50" />
            Click “Generate QR Codes” to preview your table codes.
          </div>
        )}
      </div>
    </StepCard>
  )
}

function QrPlaceholder({
  tableName,
  token,
  restaurantName,
}: {
  tableName: string
  token: string
  restaurantName: string
}) {
  return (
    <div className="rounded-xl bg-white p-2.5 shadow-premium text-center">
      <div className="aspect-square rounded-md bg-[repeating-conic-gradient(#000_0_25%,#fff_0_50%)] bg-[length:6px_6px] mb-2 grid place-items-center">
        <div className="bg-white p-1 rounded">
          <QrCode className="w-5 h-5 text-black" />
        </div>
      </div>
      <p className="text-[11px] font-semibold text-black truncate">{tableName}</p>
      <p className="text-[9px] text-black/60 truncate">{restaurantName || 'The Salad'}</p>
      <p className="text-[8px] text-black/40 truncate font-mono">{token}</p>
    </div>
  )
}

/* ================================================================== */
/* Step 5 — Go Live                                                    */
/* ================================================================== */

function StepGoLive({
  restaurant,
  data,
  onRestart,
  isLocationMode,
  onCompleteLocation,
}: {
  restaurant: RestaurantDraft
  data?: OnboardingData
  onRestart: () => void
  isLocationMode?: boolean
  onCompleteLocation?: (tenant: any) => void
}) {
  const [saving, setSaving] = useState(false)

  // Double-clicks race the state commit: the first click's re-render (which
  // disables the button) lands after the second click has already fired.
  // The ref is synchronous, so the second click dies here.
  const savingRef = useRef(false)

  // Auto-save when reaching Step 5
  useEffect(() => {
    if (!data) return
    const saveSetup = async () => {
      try {
        const flattenedItems = data.menu.categories.flatMap((cat) =>
          cat.items.map((item) => ({
            ...item,
            categoryId: cat.id,
            category: cat.name,
          })),
        )

        await edgeFetch('/api/onboarding/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            restaurant: {
              name: data.restaurant.name,
              tagline: data.restaurant.cuisine ? `${data.restaurant.cuisine} Restaurant` : undefined,
              phone: data.restaurant.phone,
              email: data.restaurant.email,
              address: data.restaurant.address,
              currency: data.customize.currency,
              currencySymbol: data.customize.currencySymbol,
              taxRate: data.customize.taxRate,
              serviceCharge: data.customize.serviceCharge,
              logo: data.restaurant.logo,
              // Collected on the setup form; without these the values never
              // reached the server and the bill printed with no tax IDs.
              gstin: data.restaurant.gstin || undefined,
              fssai: data.restaurant.fssai || undefined,
              // The theme the customer menu is shown in. It was collected
              // here and thrown away, so every restaurant got the same
              // menu however it was set.
              menuTheme: data.customize.theme,
              autoAcceptOrders: data.customize.autoAcceptOrders,
              autoBillPrint: data.customize.autoBillPrint,
            },
            categories: data.menu.categories.map((c) => ({ id: c.id, name: c.name })),
            menuItems: flattenedItems,
            tables: data.qr.tableCount || 8,
          }),
        })
      } catch (err) {
        console.error('Auto-save onboarding error:', err)
      }
    }
    saveSetup()
  }, [data])

  const handleOpenDashboard = async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      if (data) {
        const flattenedItems = data.menu.categories.flatMap((cat) =>
          cat.items.map((item) => ({
            ...item,
            categoryId: cat.id,
            category: cat.name,
          })),
        )

        const res = await edgeFetch('/api/onboarding/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            isLocationMode: Boolean(isLocationMode),
            restaurant: {
              name: data.restaurant.name,
              tagline: data.restaurant.cuisine ? `${data.restaurant.cuisine} Restaurant` : undefined,
              phone: data.restaurant.phone,
              email: data.restaurant.email,
              address: data.restaurant.address,
              currency: data.customize.currency,
              currencySymbol: data.customize.currencySymbol,
              taxRate: data.customize.taxRate,
              serviceCharge: data.customize.serviceCharge,
              logo: data.restaurant.logo,
              gstin: data.restaurant.gstin || undefined,
              fssai: data.restaurant.fssai || undefined,
              menuTheme: data.customize.theme,
              autoAcceptOrders: data.customize.autoAcceptOrders,
              autoBillPrint: data.customize.autoBillPrint,
            },
            categories: data.menu.categories.map((c) => ({ id: c.id, name: c.name })),
            menuItems: flattenedItems,
            tables: data.qr.tableCount || 8,
          }),
        })

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}))
          throw new Error(errData.error || 'Failed to save setup')
        }
        // Dishes whose price was never readable are skipped by the server
        // rather than saved at ₹0. Say exactly which, and where they go now.
        const result = await res.json().catch(() => ({}))
        if (Array.isArray(result?.skippedItems) && result.skippedItems.length > 0) {
          const names = result.skippedItems.slice(0, 4).join(', ')
          toast.warning(
            `${result.skippedItems.length} dish${result.skippedItems.length === 1 ? '' : 'es'} not imported — no readable price`,
            {
              description: `${names}${result.skippedItems.length > 4 ? '…' : ''}. Add them from the dashboard menu page once you know the price.`,
            },
          )
        }

        if (isLocationMode) {
          toast.success(`Location "${data.restaurant.name || 'New Branch'}" is live!`)
          if (onCompleteLocation) {
            onCompleteLocation(result?.tenant || result)
            return
          }
        }
      }

      if (!isLocationMode) removeStored('onboarding')
      toast.success('Opening dashboard…')
      setTimeout(() => {
        window.location.href = '/?view=dashboard'
      }, 500)
    } catch (e: any) {
      // A failure leaves the owner on this step — put the button back so
      // they can retry instead of watching it spin.
      savingRef.current = false
      setSaving(false)
      toast.error(e.message || 'Failed to save setup')
    }
    // On success the button deliberately stays in the saving state until
    // the navigation actually happens. Flipping it back for the ~500 ms
    // redirect delay painted "Open Dashboard" over "Saving…" and opened a
    // window where a second click re-fired the save.
  }

  const confetti = useMemo(
    () =>
      Array.from({ length: 18 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 0.6,
        duration: 2.4 + Math.random() * 1.8,
        emoji: ['🎉', '🎊', '✨', '🎈', '🌟', '🍾'][i % 6],
        size: 14 + Math.random() * 14,
      })),
    [],
  )

  return (
    <StepCard>
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        {confetti.map((c) => (
          <span
            key={c.id}
            className="absolute -top-6 select-none"
            style={{
              left: `${c.left}%`,
              fontSize: c.size,
              animation: `ob-confetti-fall ${c.duration}s linear ${c.delay}s infinite`,
            }}
          >
            {c.emoji}
          </span>
        ))}
        <style>{`
          @keyframes ob-confetti-fall {
            0%   { transform: translateY(-2rem) rotate(0deg); opacity: 0; }
            8%   { opacity: 1; }
            100% { transform: translateY(110vh) rotate(540deg); opacity: 0.2; }
          }
        `}</style>
      </div>

      <div className="relative text-center py-6">
        <div className="relative mx-auto w-20 h-20 mb-5">
          <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl" />
          <div className="relative w-20 h-20 rounded-full bg-primary/15 border border-primary/30 grid place-items-center pulse-ring">
            <PartyPopper className="w-10 h-10 text-primary" />
          </div>
        </div>

        <h2 className="text-2xl sm:text-3xl font-bold mb-2">
          Your digital restaurant is <span className="text-gradient-primary">live</span> 🎉
        </h2>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          {restaurant.name || 'Your restaurant'} is all set up. Customers can now scan, browse,
          and order — and you can manage everything from the dashboard.
        </p>

        <div className="mt-7 grid sm:grid-cols-3 gap-2.5 max-w-lg mx-auto">
          <Button
            type="button"
            variant="outline"
            className="gap-2 h-auto py-3 flex-col"
            onClick={() => {
              toast.success('Opening customer menu…')
              setTimeout(() => {
                window.location.href = '/?view=public-menu'
              }, 500)
            }}
          >
            <ShoppingBag className="w-5 h-5 mb-1 text-primary" />
            <span className="text-xs">View Customer Menu</span>
          </Button>
          <Button
            type="button"
            disabled={saving}
            className="gap-2 h-auto py-3 flex-col shadow-glow-primary"
            onClick={handleOpenDashboard}
          >
            {saving ? (
              <Loader2 className="w-5 h-5 mb-1 animate-spin" />
            ) : (
              <LayoutDashboard className="w-5 h-5 mb-1" />
            )}
            {/* The key makes React swap the node instead of mutating the
                text in place, so the old label is never painted alongside
                the new one. */}
            <span key={saving ? 'saving' : 'idle'} className="text-xs">
              {saving ? 'Saving…' : 'Open Dashboard'}
            </span>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="gap-2 h-auto py-3 flex-col"
            onClick={() => toast.success('QR codes downloaded')}
          >
            <Download className="w-5 h-5 mb-1 text-primary" />
            <span className="text-xs">Download QR</span>
          </Button>
        </div>

        <div className="mt-6 flex items-center justify-center gap-3 text-xs text-muted-foreground">
          <Rocket className="w-3.5 h-3.5 text-primary" />
          <span>Welcome aboard The Salad.</span>
          <button
            type="button"
            onClick={onRestart}
            className="underline underline-offset-2 hover:text-primary transition-premium"
          >
            Restart onboarding
          </button>
        </div>
      </div>
    </StepCard>
  )
}

/* ================================================================== */
/* Shared field components                                             */
/* ================================================================== */

function StepHeading({
  icon,
  eyebrow,
  title,
  desc,
}: {
  icon: React.ReactNode
  eyebrow: string
  title: string
  desc: string
}) {
  return (
    <div className="flex items-start gap-3.5">
      <div className="w-11 h-11 rounded-xl bg-primary/15 border border-primary/30 text-primary grid place-items-center shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wider text-primary font-semibold mb-0.5">
          {eyebrow}
        </p>
        <h2 className="text-xl sm:text-2xl font-bold leading-tight">{title}</h2>
        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{desc}</p>
      </div>
    </div>
  )
}

/**
 * A small picture of the customer menu, in the theme it would be shown in.
 *
 * It is built from the app's own tokens, so it is the real palette and not
 * a drawing of it. The wrapper carries the theme's class, which is what
 * declares the palette for everything inside it.
 */
function MenuThemePreview({ theme }: { theme: MenuTheme }) {
  return (
    <div className={cn(theme, 'w-full overflow-hidden border-b border-border')}>
      <div className="bg-background px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="size-6 rounded-md bg-primary/15" />
          <div className="h-2 w-16 rounded-full bg-foreground/70" />
        </div>
        <div className="mt-3 h-1.5 w-20 rounded-full bg-muted-foreground/40" />
        <div className="mt-2 space-y-1.5">
          <div className="h-7 rounded-lg bg-card border border-border" />
          <div className="h-7 rounded-lg bg-card border border-border" />
        </div>
        <div className="mt-2.5 flex gap-1.5">
          <div className="h-4 w-10 rounded-full bg-muted" />
          <div className="h-4 w-10 rounded-full bg-muted" />
        </div>
      </div>
      <div className="h-7 bg-card flex items-center justify-between px-3">
        <div className="h-1.5 w-12 rounded-full bg-muted-foreground/40" />
        <div className="h-5 w-8 rounded-md bg-primary" />
      </div>
    </div>
  )
}

/**
 * A number field that can actually be edited.
 *
 * The value used to be parsed on every keystroke and written straight back
 * into the field, which broke it in two ways. Clearing the field put the
 * number straight back — the table count came back as 1 the moment it was
 * emptied, so it could never be replaced. And a trailing decimal point was
 * swallowed the instant it was typed, because "12." parsed to 12 and the "."
 * was thrown away: typing "12.50" produced "1250".
 *
 * The raw text is kept here while the field has the focus, so it can be
 * empty and it can hold a half-typed decimal. The number is committed when
 * the field is left, and the limits are applied then rather than while the
 * owner is typing.
 */
function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  className,
  emptyValue = 0,
  ...rest
}: {
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
  /** The HTML step attribute is a string, so it is allowed to be one. */
  step?: number | string
  placeholder?: string
  className?: string
  /** What an empty field means. */
  emptyValue?: number
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  const [text, setText] = useState(() => (value === 0 ? '' : String(value)))
  const [focused, setFocused] = useState(false)

  // Follow the model when it changes underneath us — a reset, or the
  // prefill — but never while the owner is typing in the field.
  useEffect(() => {
    if (focused) return
    setText(value === 0 ? '' : String(value))
  }, [value, focused])

  const commit = () => {
    setFocused(false)
    const wasEmpty = text.trim() === ''
    const parsed = wasEmpty ? emptyValue : Number(text)
    let n = Number.isFinite(parsed) ? parsed : emptyValue
    if (min !== undefined && n < min) n = min
    if (max !== undefined && n > max) n = max
    onChange(n)
    setText(wasEmpty && n === 0 ? '' : String(n))
  }

  return (
    <Input
      type="number"
      inputMode="decimal"
      value={text}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      className={className}
      onFocus={() => setFocused(true)}
      onBlur={commit}
      onChange={(e) => {
        const raw = e.target.value
        setText(raw)
        // The model keeps up while typing so anything that reads it — a
        // total, a limit — is right, but an empty field stays empty.
        if (raw.trim() === '') {
          onChange(emptyValue)
          return
        }
        const parsed = Number(raw)
        if (Number.isFinite(parsed)) onChange(parsed)
      }}
      {...rest}
    />
  )
}

function Field({
  label,
  required,
  hint,
  children,
  className,
}: {
  label: string
  required?: boolean
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
        {label}
        {required && <span className="text-primary">*</span>}
        {hint && <span className="text-muted-foreground/70 font-normal">· {hint}</span>}
      </Label>
      {children}
    </div>
  )
}
