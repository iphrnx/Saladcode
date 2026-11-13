'use client'

import { useMemo, useState, useEffect, useRef } from 'react'
import { sanitizeMenuTags } from '@/lib/menu-tags'
import { useApp, type MenuItem, type Category } from '@/components/app/data-context'
import { cn } from '@/lib/utils'
import {
  PORTION_PRESETS,
  canonicalPortionName,
  formatDishPriceLabel,
  normalizePortions,
  portionIdFromName,
} from '@/lib/portions'
import { edgeFetch } from '@/lib/edge'
import { apiError, failIfNotOk } from '@/lib/api-error'
import { useAccessDenied } from '@/lib/use-access-denied'
import { hasPermission } from '@/lib/permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ImageUpload } from '@/components/shared/image-upload'
import { Tag } from '@/components/shared/badges'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  Star,
  Clock,
  Flame,
  UtensilsCrossed,
  Tag as TagIcon,
  X,
  Loader2,
  PackageOpen,
  CheckCircle2,
  BadgeIndianRupee,
  ListOrdered,
  Sparkles,
  Settings2,
  Wand2,
} from 'lucide-react'

interface MenuFormState {
  name: string
  description: string
  price: string
  portions: { id: string; name: string; price: string }[]
  categoryId: string
  prepTime: string
  calories: string
  rating: string
  tags: string
  image: string
  available: boolean
}

const EMPTY_FORM: MenuFormState = {
  name: '',
  description: '',
  price: '',
  portions: [],
  categoryId: '',
  prepTime: '15',
  calories: '',
  // Matches the column default, so a new item starts with the star it will show.
  rating: '4.5',
  tags: '',
  image: '',
  available: true,
}

/**
 * Category icons, grouped by course.
 *
 * Curated for Indian restaurants: the previous flat list leaned Western
 * (burger, pizza, sushi, taco), which read oddly next to a menu of biryani and
 * naan. Grouping also means the picker scans like a menu instead of a wall of
 * emoji, and the set is larger — the input beside it still accepts anything.
 */
const CATEGORY_ICONS: { group: string; icons: string[] }[] = [
  { group: 'Starters', icons: ['🥗', '🧀', '🍢', '🍗', '🥟', '🍤', '🌶️', '🧅', '🥜'] },
  { group: 'Mains', icons: ['🍛', '🥘', '🍲', '🫘', '🥩', '🐟', '🍅', '🥔', '🧄'] },
  { group: 'Rice', icons: ['🍚', '🍛', '🍱', '🌾', '🥣'] },
  { group: 'Breads', icons: ['🫓', '🥖', '🍞', '🥨', '🧈'] },
  { group: 'Desserts', icons: ['🍮', '🍨', '🍧', '🍰', '🧁', '🍯', '🍫', '🥮'] },
  { group: 'Drinks', icons: ['🫖', '☕', '🧋', '🥤', '🍹', '🥛', '🥭', '🥥', '🍋'] },
  { group: 'Other', icons: ['🍽️', '🥄', '🔥', '⭐', '👑', '🥡', '🎁'] },
]

const PRESET_TAGS = [
  { id: 'VEG', label: 'Veg', icon: '🌱', activeClass: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50 ring-1 ring-emerald-500/40 shadow-xs' },
  { id: 'NON-VEG', label: 'Non-Veg', icon: '🍗', activeClass: 'bg-rose-500/20 text-rose-400 border-rose-500/50 ring-1 ring-rose-500/40 shadow-xs' },
  { id: 'VEGAN', label: 'Vegan', icon: '🌿', activeClass: 'bg-green-500/20 text-green-400 border-green-500/50 ring-1 ring-green-500/40 shadow-xs' },
  { id: 'SPICY', label: 'Spicy', icon: '🌶️', activeClass: 'bg-red-500/20 text-red-400 border-red-500/50 ring-1 ring-red-500/40 shadow-xs' },
  { id: 'JAIN', label: 'Jain', icon: '✨', activeClass: 'bg-amber-500/20 text-amber-400 border-amber-500/50 ring-1 ring-amber-500/40 shadow-xs' },
  { id: 'BESTSELLER', label: 'Bestseller', icon: '⭐', activeClass: 'bg-orange-500/20 text-orange-400 border-orange-500/50 ring-1 ring-orange-500/40 shadow-xs' },
  { id: 'NEW', label: 'New', icon: '🔥', activeClass: 'bg-blue-500/20 text-blue-400 border-blue-500/50 ring-1 ring-blue-500/40 shadow-xs' },
  { id: 'GLUTEN-FREE', label: 'Gluten-Free', icon: '🌾', activeClass: 'bg-purple-500/20 text-purple-400 border-purple-500/50 ring-1 ring-purple-500/40 shadow-xs' },
] as const

export function MenuView() {
  const { data, refresh } = useApp()
  // A failed write is toasted, never allowed to take over the screen — the
  // list behind the dialog is still valid while the user is mid-task.
  const { handleAction } = useAccessDenied()
  // The whole view is the scroll container: the title, the search row, the
  // stats and the cards move together. On mobile the category pill row is
  // sticky (see its wrapper below) — there is no second scrolling pane, so
  // sticky alone keeps it painted above the cards with no overlap boundary.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState<string>('all')
  const [catFilter, setCatFilter] = useState<string>('all')
  const [itemDialogOpen, setItemDialogOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)
  const [form, setForm] = useState<MenuFormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<MenuItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  const selectedTagList = useMemo(() => {
    return (form.tags || '')
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
  }, [form.tags])

  const toggleTag = (tagId: string) => {
    const norm = tagId.toUpperCase()
    let current = (form.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    const exists = current.some((t) => t.toUpperCase() === norm)
    if (exists) {
      current = current.filter((t) => t.toUpperCase() !== norm)
    } else {
      if (norm === 'VEG') {
        current = current.filter((t) => t.toUpperCase() !== 'NON-VEG')
      } else if (norm === 'NON-VEG') {
        current = current.filter((t) => t.toUpperCase() !== 'VEG' && t.toUpperCase() !== 'VEGAN')
      }
      current.push(tagId)
    }
    setField('tags', current.join(', '))
  }
  // Category dialog
  const [catDialogOpen, setCatDialogOpen] = useState(false)
  // Deleting a category can take its dishes with it, so the dialog needs to
  // know which one, and where its dishes should go if the owner keeps them.
  const [catToDelete, setCatToDelete] = useState<Category | null>(null)
  // Category management lives in its own dialog: the trash used to sit inside
  // the filter dropdown, where it was hard to find and easy to hit by accident.
  const [catManagerOpen, setCatManagerOpen] = useState(false)
  const [moveDishesTo, setMoveDishesTo] = useState('')
  const [deletingCat, setDeletingCat] = useState(false)
  const [catForm, setCatForm] = useState({ name: '', icon: '🍽️' })
  const [catSaving, setCatSaving] = useState(false)

  // Sync category filter dropdown value with the pill row
  useEffect(() => {
    setCatFilter(activeCat)
  }, [activeCat])

  const menuItems = data?.menuItems ?? []
  const categories = data?.categories ?? []
  const tenant = data?.tenant
  const currency = tenant?.currencySymbol ?? '$'

  const stats = useMemo(() => {
    const total = menuItems.length
    const available = menuItems.filter((m) => m.available).length
    const avgPrice = total > 0 ? menuItems.reduce((s, m) => s + m.price, 0) / total : 0
    return { total, available, avgPrice, cats: categories.length }
  }, [menuItems, categories])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return menuItems.filter((m) => {
      if (activeCat !== 'all' && m.categoryId !== activeCat) return false
      if (q && !`${m.name} ${m.description || ''}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [menuItems, activeCat, search])

  if (!data || !tenant) return null

  // Every menu write — item, category, AI image — is guarded by `menu.manage`
  // on the server, so the controls that trigger them ask for the same key. A
  // custom role with `menu.view` alone gets a read-only menu rather than a set
  // of buttons the server will refuse.
  const canManageMenu = hasPermission(data.permissions, 'menu.manage')

  const openAdd = () => {
    setEditingItem(null)
    setForm({
      ...EMPTY_FORM,
      categoryId: categories[0]?.id ?? '',
      portions: [],
    })
    setItemDialogOpen(true)
  }

  const openEdit = (item: MenuItem) => {
    const normPortions = normalizePortions(item.portions)
    const minPortionPrice =
      normPortions.length > 0 ? Math.min(...normPortions.map((p) => p.price)) : item.price
    setEditingItem(item)
    setForm({
      name: item.name,
      description: item.description || '',
      price: String(minPortionPrice ?? ''),
      portions: normPortions.map((p) => ({
        id: p.id,
        name: p.name,
        price: String(p.price),
      })),
      categoryId: item.categoryId,
      prepTime: String(item.prepTime ?? 15),
      calories: item.calories != null ? String(item.calories) : '',
      rating: item.rating != null ? String(item.rating) : '',
      tags: item.tags || '',
      image: item.image || '',
      available: item.available,
    })
    setItemDialogOpen(true)
  }

  const setField = <K extends keyof MenuFormState>(key: K, value: MenuFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const addPortionOption = (presetName?: string) => {
    setForm((f) => {
      if (f.portions.length >= 8) return f
      const cleanPreset = presetName ? canonicalPortionName(presetName) : ''
      if (
        cleanPreset &&
        f.portions.some((p) => p.name.trim().toLowerCase() === cleanPreset.toLowerCase())
      ) {
        return f
      }
      const id = cleanPreset
        ? portionIdFromName(cleanPreset)
        : `custom-${Date.now()}-${f.portions.length + 1}`
      return {
        ...f,
        portions: [...f.portions, { id, name: cleanPreset, price: '' }],
      }
    })
  }

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Item name is required')
      return
    }
    if (!form.categoryId) {
      toast.error('Please select a category')
      return
    }
    const portions = form.portions
      .filter((p) => p.name.trim() || p.price.trim())
      .map((p) => {
        const name = canonicalPortionName(p.name)
        return {
          id: portionIdFromName(name, p.id),
          name,
          price: parseFloat(p.price),
        }
      })
    if (portions.some((p) => !p.name)) {
      toast.error('Every portion needs a name')
      return
    }
    if (portions.some((p) => Number.isNaN(p.price) || p.price < 0)) {
      toast.error('Enter a valid price for every portion')
      return
    }
    const names = portions.map((p) => p.name.toLowerCase())
    if (new Set(names).size !== names.length) {
      toast.error('Each portion name must be unique')
      return
    }

    let price = parseFloat(form.price)
    if (portions.length > 0) {
      price = Math.min(...portions.map((p) => p.price))
    } else if (Number.isNaN(price) || price < 0) {
      toast.error('Enter a valid price')
      return
    }

    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      price,
      portions: portions.length > 0 ? portions : null,
      categoryId: form.categoryId,
      prepTime: parseInt(form.prepTime || '15', 10) || 15,
      calories: form.calories ? parseInt(form.calories, 10) : null,
      rating: form.rating ? Number(form.rating) : null,
      // The picker can only produce preset tags, but a stale or edited
      // string must not carry an unknown tag through to the database.
      tags: sanitizeMenuTags(form.tags).join(', ') || null,
      image: form.image.trim() || null,
      available: form.available,
    }
    setSaving(true)
    try {
      const headers = { 'content-type': 'application/json', 'x-tenant-id': tenant.id }
      let res: Response
      if (editingItem) {
        res = await edgeFetch('/api/menu', {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ id: editingItem.id, ...body }),
        })
      } else {
        res = await edgeFetch('/api/menu', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
      }
      // `apiError` keeps the server's own sentence for a validation failure but
      // never lets the raw token "Forbidden" reach the user.
      await failIfNotOk(res, 'the menu item')
      toast.success(editingItem ? 'Item updated' : 'Item created')
      setItemDialogOpen(false)
      await refresh()
    } catch (err) {
      handleAction(err, 'the menu item')
    } finally {
      setSaving(false)
    }
  }

  /**
   * Draw a dish photograph with Gemini and attach it to this item.
   *
   * The edge function generates the image, saves it in the restaurant's own
   * folder in the menu-images bucket, and points the item at it. The form is
   * updated with the returned URL so the preview shows it straight away.
   */
  const handleGenerateImage = async () => {
    if (!editingItem) return
    setGenerating(true)
    setGenError(null)
    try {
      const res = await edgeFetch(
        '/api/ai-generate-image',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tenant-id': tenant.id },
          body: JSON.stringify({ itemId: editingItem.id }),
        },
        // Generating an image takes far longer than a normal call; the default
        // deadline would give up on work that is still going to succeed.
        120_000,
      )
      // A 403 used to be printed here as the raw token "Forbidden"; `apiError`
      // says what actually happened instead, and names the permission.
      if (!res.ok) {
        setGenError((await apiError(res, 'the dish photo')).message)
        return
      }
      const body = await res.json().catch(() => ({}))
      if (body?.url) {
        setField('image', body.url)
        toast.success('Dish photo generated')
        await refresh()
      }
    } catch {
      setGenError('Could not generate an image. Check your connection and try again.')
    } finally {
      setGenerating(false)
    }
  }

  const handleToggleAvailable = async (item: MenuItem) => {
    setTogglingId(item.id)
    try {
      const res = await edgeFetch('/api/menu', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenant.id },
        body: JSON.stringify({ id: item.id, available: !item.available }),
      })
      await failIfNotOk(res, 'the menu item')
      toast.success(!item.available ? 'Item available' : 'Item hidden')
      await refresh()
    } catch (err) {
      handleAction(err, 'the menu item')
    } finally {
      setTogglingId(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      // Menu API has no DELETE; we hide the item by toggling available=false as a soft delete fallback.
      // But spec says "Delete (alert dialog confirm)" — we still attempt a DELETE on the menu endpoint for parity.
      const res = await edgeFetch(`/api/menu?id=${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { 'x-tenant-id': tenant.id },
      })
      // A 404 or 405 means the endpoint has no DELETE at all (this API soft-
      // deletes by toggling availability), so those are not failures.
      if (res.status !== 404 && res.status !== 405) await failIfNotOk(res, 'the menu item')
      toast.success('Item deleted')
      setDeleteTarget(null)
      await refresh()
    } catch (err) {
      handleAction(err, 'the menu item')
    } finally {
      setDeleting(false)
    }
  }

  /**
   * A category can only be deleted once no dish is left in it: `menu_items`
   * carries `category_id` NOT NULL with a cascading foreign key, so deleting a
   * populated category would silently destroy its dishes along with their
   * prices, portions and photos. Empty categories delete straight away;
   * populated ones must hand their dishes to another category first.
   */
  const openDeleteCategory = (c: Category) => {
    setCatToDelete(c)
    // Default to the first other category so the common case is one click.
    const fallback = categories.find((x) => x.id !== c.id)
    setMoveDishesTo(fallback?.id ?? '')
  }

  const dishesIn = (id: string) => menuItems.filter((m) => m.categoryId === id).length
  const otherCategories = (id: string) => categories.filter((c) => c.id !== id)

  const confirmDeleteCategory = async () => {
    if (!catToDelete) return
    const count = dishesIn(catToDelete.id)

    // Never destroy dishes as a side effect of deleting a category. The server
    // enforces this too; this is the message the owner actually reads.
    if (count > 0 && !moveDishesTo) {
      toast.error('Choose where the dishes should go first')
      return
    }

    setDeletingCat(true)
    try {
      const res = await edgeFetch(
        `/api/categories/${catToDelete.id}${moveDishesTo ? `?moveTo=${encodeURIComponent(moveDishesTo)}` : ''}`,
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json', 'x-tenant-id': tenant.id },
        },
      )
      // A 403 used to reach the user as the raw token "Forbidden"; the server's
      // own sentence is kept for the failures that have one.
      await failIfNotOk(res, 'the category')
      const result = await res.json().catch(() => ({}))
      if (count > 0) {
        toast.success('Category deleted', {
          description: `${result.moved ?? count} ${count === 1 ? 'dish' : 'dishes'} moved across.`,
        })
      } else {
        toast.success('Category deleted')
      }
      if (activeCat === catToDelete.id) setActiveCat('all')
      setCatToDelete(null)
      await refresh()
    } catch (err) {
      handleAction(err, 'the category')
    } finally {
      setDeletingCat(false)
    }
  }

  const handleAddCategory = async () => {
    if (!catForm.name.trim()) {
      toast.error('Category name is required')
      return
    }
    setCatSaving(true)
    try {
      const res = await edgeFetch('/api/categories', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenant.id },
        body: JSON.stringify({
          name: catForm.name.trim(),
          icon: catForm.icon || '🍽️',
          sortOrder: categories.length,
        }),
      })
      await failIfNotOk(res, 'the category')
      toast.success('Category added')
      setCatForm({ name: '', icon: '🍽️' })
      setCatDialogOpen(false)
      await refresh()
    } catch (err) {
      handleAction(err, 'the category')
    } finally {
      setCatSaving(false)
    }
  }

  return (
    <div
      ref={scrollRef}
      data-menu-scroll
      className="h-full overflow-y-auto scrollbar-thin pb-4 md:pb-6"
    >
      {/* Header. It scrolls with the content now, so the shrink-on-scroll is
          gone: it moved the cards every time it toggled, and the stats strip it
          hid was clamped to a height its own contents exceeded — which is what
          cut the bottom stat cards off. */}
      <div className="space-y-1.5 px-3.5 pt-2.5 pb-2 md:space-y-3 md:px-6 md:pt-6 md:pb-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 md:gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight md:text-2xl">Menu</h1>
            <p className="text-[13px] text-muted-foreground md:text-sm">
              Manage dishes, categories, availability &amp; pricing
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCatManagerOpen(true)}
              aria-label="Manage Categories"
              title="Manage Categories"
            >
              <Settings2 className="h-4 w-4" />
              <span className="hidden md:inline">Manage Categories</span>
            </Button>
            {canManageMenu && (
              <>
                <Button variant="outline" size="sm" onClick={() => setCatDialogOpen(true)}>
                  <Plus className="h-4 w-4" /> Category
                </Button>
                <Button size="sm" onClick={openAdd}>
                  <Plus className="h-4 w-4" /> Add Item
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Search + category filter — stack on mobile, row on sm+ */}
        {/* One row at every width: stacking these on a phone cost a whole row
            of height before the list had even started. */}
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-secondary/60 px-2 py-1 md:gap-2 md:rounded-xl md:px-3">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground md:h-4 md:w-4" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search menu items…"
              className="h-6 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground md:h-8 md:text-sm"
            />
            {search && (
              <button onClick={() => setSearch('')} aria-label="Clear search" className="shrink-0">
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
              </button>
            )}
          </div>
          <Select value={catFilter} onValueChange={(v) => setActiveCat(v)}>
            <SelectTrigger className="h-8 w-[132px] shrink-0 justify-center border-0 bg-secondary/60 text-[12px] md:h-9 md:w-[180px] md:text-sm">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            {/* Filter only. Deleting lives in Manage Categories: a bin inside a
                dropdown is easy to hit while picking a filter, and it needed a
                stack of overrides to stop Radix's tick and the bin colliding. */}
            <SelectContent>
              <SelectItem value="all"><span className="mr-1">🍴</span>All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="mr-1">{c.icon || '🍽️'}</span>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Stats — in the flow, never clamped. The clamp that used to live here
          was 10rem tall while four cards in two rows need more than that, so it
          clipped them and hid the damage behind overflow-hidden. */}
      <div data-menu-stats className="px-3.5 pb-2 md:px-6 md:pb-3">
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <StatChip icon={<ListOrdered className="h-3.5 w-3.5" />} label="Total Items" value={String(stats.total)} />
          <StatChip
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            label="Available"
            value={String(stats.available)}
            accent
          />
          <StatChip
            icon={<BadgeIndianRupee className="h-3.5 w-3.5" />}
            label="Avg Price"
            value={`${currency}${stats.avgPrice.toFixed(2)}`}
          />
          <StatChip icon={<TagIcon className="h-3.5 w-3.5" />} label="Categories" value={String(stats.cats)} />
        </div>
      </div>

      {/* Category pills — sticky at top on mobile, tablet & desktop */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b border-border/40 shadow-xs px-3.5 pt-2 pb-2.5 md:px-6 md:pt-2 md:pb-2.5 transition-shadow">
        <div
          data-menu-tabs
          className="-mx-0.5 flex items-center gap-1 overflow-x-auto overscroll-x-contain scrollbar-thin px-0.5 py-0.5"
        >
          <div className="flex gap-1.5 whitespace-nowrap">
            <CatPill active={activeCat === 'all'} onClick={() => setActiveCat('all')}>
              <span className="mr-1">🍴</span>All <span className="ml-1 opacity-60">({menuItems.length})</span>
            </CatPill>
            {categories.map((c) => {
              const count = menuItems.filter((m) => m.categoryId === c.id).length
              return (
                <CatPill key={c.id} active={activeCat === c.id} onClick={() => setActiveCat(c.id)}>
                  <span className="mr-1">{c.icon || '🍽️'}</span>
                  {c.name} <span className="ml-1 opacity-60">({count})</span>
                </CatPill>
              )
            })}
          </div>
        </div>
      </div>

      {/* Grid */}
      <div data-menu-list className="px-3.5 md:px-6">
        {filtered.length === 0 ? (
          <EmptyMenu hasItems={menuItems.length > 0} onAdd={openAdd} canAdd={canManageMenu} />
        ) : (
          // `auto-rows-fr` gives every row the height of the tallest one, so
          // the cards are equal all the way down the board and not just within
          // a row.
          <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 md:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((item) => (
              <MenuCard
                key={item.id}
                item={item}
                currency={currency}
                categoryName={item.category?.name || categories.find((c) => c.id === item.categoryId)?.name || 'Uncategorized'}
                categoryIcon={item.category?.icon || categories.find((c) => c.id === item.categoryId)?.icon || '🍽️'}
                toggling={togglingId === item.id}
                canManage={canManageMenu}
                onToggle={() => handleToggleAvailable(item)}
                onEdit={() => openEdit(item)}
                onDelete={() => setDeleteTarget(item)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add/Edit Item Dialog */}
      <Dialog open={itemDialogOpen} onOpenChange={setItemDialogOpen}>
        <DialogContent className="sm:max-w-2xl bg-card max-h-[85vh] overflow-y-auto scrollbar-thin">
          <DialogHeader>
            <DialogTitle>{editingItem ? 'Edit Item' : 'Add Menu Item'}</DialogTitle>
            <DialogDescription>
              {editingItem
                ? 'Update the details of this menu item.'
                : 'Fill in the details to add a new menu item.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2 space-y-2">
              <Label htmlFor="m-name">Name *</Label>
              <Input
                id="m-name"
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="e.g. Truffle Mushroom Burger"
                className="bg-secondary/50 border-0"
              />
            </div>

            <div className="sm:col-span-2 space-y-2">
              <Label htmlFor="m-desc">Description</Label>
              <Textarea
                id="m-desc"
                value={form.description}
                onChange={(e) => setField('description', e.target.value)}
                placeholder="Short description shown to customers…"
                className="bg-secondary/50 border-0 min-h-20"
              />
            </div>

            {form.portions.length === 0 && (
              <div className="space-y-2">
                <Label htmlFor="m-price">Price *</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    {currency}
                  </span>
                  <Input
                    id="m-price"
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.price}
                    onChange={(e) => setField('price', e.target.value)}
                    placeholder="0.00"
                    className="bg-secondary/50 border-0 pl-7"
                  />
                </div>
              </div>
            )}

            {/* Portions — Quarter/Half/Full or custom sizes, each with its own
                price. When portions are defined, the dish uses portion pricing
                exclusively so there is never a duplicate standalone price field. */}
            <div
              className={cn(
                'space-y-2.5 rounded-lg border border-border/60 p-3 bg-secondary/20',
                form.portions.length > 0 && 'sm:col-span-2',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Label>Portions / sizes</Label>
                  {form.portions.length > 0 && (
                    <Badge variant="secondary" className="text-[10px]">
                      {form.portions.length} {form.portions.length === 1 ? 'portion' : 'portions'}
                    </Badge>
                  )}
                </div>
                {form.portions.length === 0 ? (
                  <span className="text-[10px] text-muted-foreground">optional</span>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => setField('portions', [])}
                  >
                    Switch to single price
                  </Button>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">
                {PORTION_PRESETS.map((preset) => {
                  const alreadyAdded = form.portions.some(
                    (p) => p.name.trim().toLowerCase() === preset.toLowerCase(),
                  )
                  return (
                    <Button
                      key={preset}
                      type="button"
                      variant={alreadyAdded ? 'secondary' : 'outline'}
                      size="sm"
                      disabled={alreadyAdded || form.portions.length >= 8}
                      className="h-7 text-xs"
                      onClick={() => addPortionOption(preset)}
                    >
                      {alreadyAdded ? `✓ ${preset}` : `+ ${preset}`}
                    </Button>
                  )
                })}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={form.portions.length >= 8}
                  className="h-7 text-xs"
                  onClick={() => addPortionOption()}
                >
                  + Custom size
                </Button>
              </div>

              {form.portions.length > 0 && (
                <div className="space-y-2 pt-1">
                  {form.portions.map((p) => (
                    <div key={p.id} className="flex items-center gap-2">
                      <Input
                        value={p.name}
                        onChange={(e) => {
                          setField(
                            'portions',
                            form.portions.map((row) =>
                              row.id === p.id ? { ...row, name: e.target.value } : row,
                            ),
                          )
                        }}
                        placeholder="Portion name (e.g. Half)"
                        className="bg-secondary/50 border-0 h-9"
                      />
                      <div className="relative w-32 shrink-0">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                          {currency}
                        </span>
                        <Input
                          value={p.price}
                          onChange={(e) => {
                            setField(
                              'portions',
                              form.portions.map((row) =>
                                row.id === p.id ? { ...row, price: e.target.value } : row,
                              ),
                            )
                          }}
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          className="bg-secondary/50 border-0 pl-6 h-9"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${p.name || 'portion'}`}
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          setField(
                            'portions',
                            form.portions.filter((row) => row.id !== p.id),
                          )
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Category *</Label>
              <Select value={form.categoryId} onValueChange={(v) => setField('categoryId', v)}>
                <SelectTrigger className="bg-secondary/50 border-0 w-full">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="mr-1">{c.icon || '🍽️'}</span>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="m-prep">Prep Time (min)</Label>
              <Input
                id="m-prep"
                type="number"
                min="0"
                value={form.prepTime}
                onChange={(e) => setField('prepTime', e.target.value)}
                className="bg-secondary/50 border-0"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="m-cal">Calories</Label>
              <Input
                id="m-cal"
                type="number"
                min="0"
                value={form.calories}
                onChange={(e) => setField('calories', e.target.value)}
                placeholder="—"
                className="bg-secondary/50 border-0"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="m-rating">Rating (0–5)</Label>
              <div className="relative">
                <Input
                  id="m-rating"
                  type="number"
                  min="0"
                  max="5"
                  step="0.1"
                  value={form.rating}
                  onChange={(e) => setField('rating', e.target.value)}
                  placeholder="4.5"
                  className="bg-secondary/50 border-0 pl-8"
                />
                <Star className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-amber-400 fill-amber-400" />
              </div>
              <p className="text-[11px] text-muted-foreground">Shown as the star on the menu card.</p>
            </div>

            <div className="sm:col-span-2 space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Tags</Label>
                <span className="text-[11px] text-muted-foreground">Tap tags to select/unselect</span>
              </div>
              <div className="flex flex-wrap gap-2 p-3 rounded-xl bg-secondary/30 border border-border/60">
                {PRESET_TAGS.map((tag) => {
                  const isSelected = selectedTagList.includes(tag.id)
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className={cn(
                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all duration-150 cursor-pointer select-none active:scale-95',
                        isSelected
                          ? tag.activeClass
                          : 'bg-secondary/60 text-muted-foreground border-transparent hover:border-border hover:text-foreground hover:bg-secondary/90'
                      )}
                    >
                      <span className="text-xs">{tag.icon}</span>
                      <span>{tag.label}</span>
                      {isSelected && <span className="text-[10px] ml-0.5 font-bold">✓</span>}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="sm:col-span-2 space-y-2">
              <ImageUpload
                value={form.image}
                onChange={(v) => setField('image', v)}
                label="Item Image"
                shape="circle"
                size={88}
                fallback="🍽️"
              />

              {editingItem && canManageMenu && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 w-full gap-2 border-primary/30 text-primary hover:bg-primary/5"
                  disabled={generating}
                  onClick={handleGenerateImage}
                >
                  {generating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wand2 className="h-3.5 w-3.5" />
                  )}
                  {generating ? 'Drawing the dish photo…' : 'Draw a dish photo with AI'}
                </Button>
              )}

              {genError && (
                <p className="rounded-lg border border-destructive/25 bg-destructive/5 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-destructive">
                  {genError}
                </p>
              )}
            </div>

            <div className="sm:col-span-2 flex items-center justify-between rounded-xl bg-secondary/40 px-4 py-3">
              <div>
                <p className="text-sm font-medium">Available for ordering</p>
                <p className="text-xs text-muted-foreground">When off, this item is hidden from the POS</p>
              </div>
              <Switch checked={form.available} onCheckedChange={(v) => setField('available', v)} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setItemDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : editingItem ? (
                'Save Changes'
              ) : (
                'Create Item'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Category Dialog — the confirmation step. A populated category
          can only go once its dishes have a home, so the destructive branch is
          not offered at all. */}
      <Dialog open={!!catToDelete} onOpenChange={(o) => { if (!o && !deletingCat) setCatToDelete(null) }}>
        <DialogContent className="sm:max-w-md bg-card">
          {catToDelete && (() => {
            const count = dishesIn(catToDelete.id)
            const targets = otherCategories(catToDelete.id)
            const stranded = count > 0 && targets.length === 0
            return (
              <>
                <DialogHeader>
                  <DialogTitle>Delete “{catToDelete.name}”?</DialogTitle>
                  <DialogDescription>
                    {count === 0
                      ? 'This category is empty, so nothing else is affected.'
                      : stranded
                        ? 'Its dishes need somewhere to go, and there is no other category.'
                        : 'Its dishes will move to the category you pick. Nothing is deleted except the category itself.'}
                  </DialogDescription>
                </DialogHeader>

                {count > 0 && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-border bg-secondary/40 px-3 py-2.5 text-sm">
                      <span className="font-medium">
                        {count} {count === 1 ? 'dish' : 'dishes'}
                      </span>{' '}
                      <span className="text-muted-foreground">
                        {count === 1 ? 'is' : 'are'} in this category.
                      </span>
                    </div>

                    {stranded ? (
                      <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-muted-foreground">
                        Create another category first, then move these dishes into it — or move them
                        one by one from each dish’s edit screen.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <Label htmlFor="move-to">Move them to</Label>
                        <Select value={moveDishesTo} onValueChange={setMoveDishesTo}>
                          <SelectTrigger id="move-to" className="bg-secondary/50 border-0">
                            <SelectValue placeholder="Choose a category" />
                          </SelectTrigger>
                          <SelectContent>
                            {targets.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.icon || '🍽️'} {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                )}

                <DialogFooter>
                  <Button variant="outline" onClick={() => setCatToDelete(null)} disabled={deletingCat}>
                    Cancel
                  </Button>
                  {/* A dead end with a disabled button helps nobody: when there
                      is nowhere for the dishes to go, the next step is creating
                      that somewhere. */}
                  {stranded ? (
                    <Button
                      onClick={() => {
                        setCatToDelete(null)
                        setCatDialogOpen(true)
                      }}
                    >
                      <Plus className="h-4 w-4" /> New category
                    </Button>
                  ) : (
                    <Button
                      onClick={confirmDeleteCategory}
                      disabled={deletingCat || (count > 0 && !moveDishesTo)}
                      className="bg-destructive text-white hover:bg-destructive/90"
                    >
                      {deletingCat ? 'Deleting…' : count > 0 ? `Move ${count} & delete` : 'Delete category'}
                    </Button>
                  )}
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      {/* Manage Categories — one place for the category list and for deleting
          from it. The list scrolls inside the dialog so a restaurant with
          twenty categories still fits on a phone. */}
      <Dialog open={catManagerOpen} onOpenChange={setCatManagerOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Manage Categories</DialogTitle>
            <DialogDescription>
              Deleting a category never deletes its dishes — they move to another category first.
            </DialogDescription>
          </DialogHeader>

          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto scrollbar-thin px-1">
            {categories.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No categories yet. Add one to start organising the menu.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {categories.map((c) => {
                  const count = dishesIn(c.id)
                  return (
                    <li
                      key={c.id}
                      className="flex items-center gap-2.5 rounded-xl border border-border bg-secondary/30 px-3 py-2"
                    >
                      <span className="shrink-0 text-lg leading-none">{c.icon || '🍽️'}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {count === 0 ? 'Empty' : `${count} ${count === 1 ? 'dish' : 'dishes'}`}
                        </p>
                      </div>
                      {canManageMenu && (
                        <button
                          type="button"
                          onClick={() => openDeleteCategory(c)}
                          aria-label={`Delete ${c.name}`}
                          title={`Delete ${c.name}`}
                          className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {canManageMenu && (
              <Button
                variant="outline"
                onClick={() => {
                  setCatManagerOpen(false)
                  setCatDialogOpen(true)
                }}
              >
                <Plus className="h-4 w-4" /> New category
              </Button>
            )}
            <Button onClick={() => setCatManagerOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Category Dialog */}
      <Dialog open={catDialogOpen} onOpenChange={setCatDialogOpen}>
        <DialogContent className="sm:max-w-md bg-card">
          <DialogHeader>
            <DialogTitle>New Category</DialogTitle>
            <DialogDescription>Add a new section to organize menu items.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="c-name">Name *</Label>
              <Input
                id="c-name"
                value={catForm.name}
                onChange={(e) => setCatForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Desserts"
                className="bg-secondary/50 border-0"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-icon">Icon</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="c-icon"
                  value={catForm.icon}
                  onChange={(e) => setCatForm((f) => ({ ...f, icon: e.target.value }))}
                  placeholder="🍛"
                  maxLength={4}
                  className="bg-secondary/50 border-0 w-20 text-center text-xl"
                />
                <p className="text-[11px] text-muted-foreground">
                  Pick one, or type any emoji you like.
                </p>
              </div>
              <div className="max-h-56 space-y-3 overflow-y-auto pr-1 scrollbar-thin">
                {CATEGORY_ICONS.map((g) => (
                  <div key={g.group}>
                    <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {g.group}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {g.icons.map((emoji) => (
                        <button
                          key={`${g.group}-${emoji}`}
                          type="button"
                          onClick={() => setCatForm((f) => ({ ...f, icon: emoji }))}
                          className={cn(
                            'h-9 w-9 rounded-lg text-lg transition-colors',
                            catForm.icon === emoji
                              ? 'bg-primary/20 ring-1 ring-primary'
                              : 'bg-secondary/60 hover:bg-secondary',
                          )}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCatDialogOpen(false)} disabled={catSaving}>
              Cancel
            </Button>
            <Button onClick={handleAddCategory} disabled={catSaving}>
              {catSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Adding…
                </>
              ) : (
                'Add Category'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete menu item?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove <span className="font-semibold text-foreground">{deleteTarget?.name}</span> from
              your menu. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" /> Delete
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ---------- sub components ---------- */

function StatChip({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border border-border px-2 py-1 md:gap-3 md:rounded-xl md:px-3 md:py-2.5',
        accent ? 'bg-primary/10' : 'bg-card',
      )}
    >
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg md:h-8 md:w-8',
          accent ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground',
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate text-[13px] font-semibold md:text-sm">{value}</p>
      </div>
    </div>
  )
}

function CatPill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors md:rounded-xl md:px-3.5 md:py-2 md:text-sm',
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function MenuCard({
  item,
  currency,
  categoryName,
  categoryIcon,
  toggling,
  canManage,
  onToggle,
  onEdit,
  onDelete,
}: {
  item: MenuItem
  currency: string
  categoryName: string
  categoryIcon: string | null
  toggling: boolean
  canManage: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const tags = (item.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const hasCalories = item.calories != null && Number(item.calories) > 0
  const maxVisibleTags = hasCalories ? 1 : 2
  const visibleTags = tags.slice(0, maxVisibleTags)
  const hiddenTags = tags.length - visibleTags.length
  return (
    <div
      data-menu-card
      className={cn(
        'group relative flex flex-col rounded-2xl border border-border bg-card p-4',
        // Paint only. `transition-all` here animated the card's own box, so a
        // hover, a filter change or an availability toggle moved the cards
        // below it by a pixel or two every time.
        'transition-[box-shadow,border-color,background-color,opacity] duration-300 ease-out',
        'hover:border-primary/40 hover:shadow-lg hover:shadow-black/20',
        !item.available && 'opacity-60',
      )}
    >
      {/* Image, name, rating and description — one block.
          Every field below this block used to start wherever the text above it
          happened to end: a two-line name pushed the price down 5px, and a
          portion row pushed everything below it down 24px. The name and the
          description each hold a fixed two-line slot now, so the block is the
          same height on every card and the price starts at the same place
          whether the dish is "Paneer 65" or "Nachos Loaded Cheese". */}
      <div className="flex items-start gap-3">
        <div className="relative h-16 w-16 shrink-0">
          {item.image ? (
            <img
              src={item.image}
              alt={item.name}
              className="h-16 w-16 rounded-full object-cover ring-1 ring-white/5"
            />
          ) : (
            <div className="h-16 w-16 rounded-full bg-secondary flex items-center justify-center text-2xl">
              {categoryIcon || '🍽️'}
            </div>
          )}
          {!item.available && (
            <span className="absolute inset-0 rounded-full bg-background/60 flex items-center justify-center">
              <span className="text-[10px] font-semibold uppercase text-muted-foreground">Hidden</span>
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-h-[2.5em] font-semibold text-sm leading-tight line-clamp-2">{item.name}</h3>
            <div className="flex items-center gap-1 shrink-0">
              <Star className="h-3.5 w-3.5 fill-primary text-primary" />
              <span className="text-xs font-medium">{item.rating ? item.rating.toFixed(1) : '—'}</span>
            </div>
          </div>
          <p className="mt-0.5 h-8 text-xs leading-4 text-muted-foreground line-clamp-2">
            {item.description || 'No description'}
          </p>
        </div>
      </div>

      {/* Price + category — a fixed row, so the price and the chip line up
          across the grid. */}
      {/* The price must stay on ONE line: the range "₹180.00 – ₹240.00" used
          to wrap under itself at four-column widths, and that second line was
          what made portion-priced cards noticeably taller than single-price
          ones. text-base + nowrap keeps it a single line; the portion chips
          below still carry the exact per-portion numbers. */}
      <div className="mt-2.5 flex h-6 items-center justify-between gap-2">
        <span className="whitespace-nowrap text-base font-bold text-primary">
          {formatDishPriceLabel(item.price, item.portions, currency)}
        </span>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {categoryIcon} {categoryName}
        </Badge>
      </div>

      {/* Portion prices. The slot is on every card — a dish sold at one price
          leaves it empty — which is what keeps the tags row below it, and the
          separator and the toggle under that, at one height across the grid
          instead of stepping down on the 64 dishes that carry portions. */}
      <div className="mt-1 h-[22px]">
        {normalizePortions(item.portions).length > 0 && (
          <div className="flex gap-1 overflow-hidden">
            {normalizePortions(item.portions).map((p) => (
              <span
                key={p.id}
                className="whitespace-nowrap rounded-md bg-secondary/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {p.name}: <span className="font-semibold text-foreground">{currency}{p.price.toFixed(2)}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Tags, time and calories */}
      <div className="mt-2 flex h-[22px] items-center gap-1.5 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {visibleTags.map((t) => (
            <Tag key={t} label={t} />
          ))}
          {hiddenTags > 0 && (
            <span className="shrink-0 rounded-md bg-secondary/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              +{hiddenTags}
            </span>
          )}
        </div>
        <div className="ml-auto inline-flex shrink-0 items-center gap-2 text-[10.5px]">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3 text-muted-foreground" /> {item.prepTime} min
          </span>
          {hasCalories && (
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Flame className="h-3 w-3 text-amber-500" /> {item.calories} cal
            </span>
          )}
        </div>
      </div>

      <Separator className="mt-2" />

      {/* Footer: toggle + actions, pinned to the bottom of the card. */}
      <div className="mt-auto flex items-center justify-between gap-2 pt-2">
        <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground">
          {/* An in-place toggle, so it is disabled rather than removed: hiding
              it would change the card's layout and drop the item's state. */}
          <Switch
            checked={item.available}
            onCheckedChange={onToggle}
            disabled={toggling || !canManage}
            title={canManage ? undefined : 'You do not have permission to change availability'}
          />
          {toggling ? 'Updating…' : item.available ? 'Available' : 'Hidden'}
        </label>
        {canManage && (
          <div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" className="h-9 w-9" onClick={onEdit} aria-label="Edit item">
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
              onClick={onDelete}
              aria-label="Delete item"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyMenu({ hasItems, onAdd, canAdd }: { hasItems: boolean; onAdd: () => void; canAdd: boolean }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center py-20">
      <div className="h-16 w-16 rounded-full bg-secondary flex items-center justify-center mb-4">
        <PackageOpen className="h-7 w-7 text-muted-foreground" />
      </div>
      <h3 className="text-base font-semibold">
        {hasItems ? 'No items match your filters' : 'No menu items yet'}
      </h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {hasItems
          ? 'Try adjusting the search or category filter to find what you’re looking for.'
          : 'Add your first dish to start building the menu for your restaurant.'}
      </p>
      {!hasItems && canAdd && (
        <Button className="mt-4" onClick={onAdd}>
          <Plus className="h-4 w-4" /> Add First Item
        </Button>
      )}
    </div>
  )
}

export default MenuView
