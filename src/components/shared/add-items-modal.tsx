'use client'

import { useState, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  CategoryPill,
  MenuItemCard,
  CartLine,
  type CartItem,
  sameCartLine,
  formatPrice,
} from '@/components/public/public-menu'
import { type MenuPortion } from '@/lib/portions'
import type { Order, MenuItem, Category } from '@/components/app/data-context'
import { edgeFetch } from '@/lib/edge'
import { toast } from 'sonner'
import {
  Search,
  ShoppingBag,
  Utensils,
  Loader2,
  X,
  PlusCircle,
  AlertCircle,
} from 'lucide-react'

export interface AddItemsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: Order | null
  currencySymbol: string
  menuItems: MenuItem[]
  categories: Category[]
  tenantId: string
  onSuccess: (updatedOrder: Order) => void
}

export function AddItemsModal({
  open,
  onOpenChange,
  order,
  currencySymbol,
  menuItems,
  categories,
  tenantId,
  onSuccess,
}: AddItemsModalProps) {
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [cart, setCart] = useState<CartItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Filter available menu items
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    return menuItems.filter((item) => {
      if (item.available === false) return false
      if (activeCategory !== 'all' && item.categoryId !== activeCategory) return false
      if (q) {
        const matchName = item.name.toLowerCase().includes(q)
        const matchDesc = item.description?.toLowerCase().includes(q)
        const matchTags = item.tags?.toLowerCase().includes(q)
        if (!matchName && !matchDesc && !matchTags) return false
      }
      return true
    })
  }, [menuItems, activeCategory, search])

  // Cart operations
  const handleAdd = (item: MenuItem) => {
    setCart((prev) => {
      const idx = prev.findIndex((c) => sameCartLine(c, item.id, null, null))
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 }
        return next
      }
      return [
        ...prev,
        {
          menuItemId: item.id,
          name: item.name,
          portion: null,
          portionId: null,
          price: item.price,
          image: item.image,
          quantity: 1,
          prepTime: item.prepTime,
        },
      ]
    })
  }

  const handleDecrement = (item: MenuItem) => {
    setCart((prev) => {
      const idx = prev.findIndex((c) => sameCartLine(c, item.id, null, null))
      if (idx < 0) return prev
      if (prev[idx].quantity <= 1) {
        return prev.filter((_, i) => i !== idx)
      }
      const next = [...prev]
      next[idx] = { ...next[idx], quantity: next[idx].quantity - 1 }
      return next
    })
  }

  const handleAddPortion = (item: MenuItem, portion: MenuPortion) => {
    setCart((prev) => {
      const idx = prev.findIndex((c) => sameCartLine(c, item.id, portion.name, portion.id))
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 }
        return next
      }
      return [
        ...prev,
        {
          menuItemId: item.id,
          name: item.name,
          portion: portion.name,
          portionId: portion.id,
          price: portion.price,
          image: item.image,
          quantity: 1,
          prepTime: item.prepTime,
        },
      ]
    })
  }

  const handleDecrementPortion = (item: MenuItem, portion: MenuPortion) => {
    setCart((prev) => {
      const idx = prev.findIndex((c) => sameCartLine(c, item.id, portion.name, portion.id))
      if (idx < 0) return prev
      if (prev[idx].quantity <= 1) {
        return prev.filter((_, i) => i !== idx)
      }
      const next = [...prev]
      next[idx] = { ...next[idx], quantity: next[idx].quantity - 1 }
      return next
    })
  }

  const handleCartLineAdd = (index: number) => {
    setCart((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], quantity: next[index].quantity + 1 }
      return next
    })
  }

  const handleCartLineDecrement = (index: number) => {
    setCart((prev) => {
      if (prev[index].quantity <= 1) {
        return prev.filter((_, i) => i !== index)
      }
      const next = [...prev]
      next[index] = { ...next[index], quantity: next[index].quantity - 1 }
      return next
    })
  }

  const handleCartLineRemove = (index: number) => {
    setCart((prev) => prev.filter((_, i) => i !== index))
  }

  const handleNotesChange = (index: number, notes: string) => {
    setCart((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], notes }
      return next
    })
  }

  const additionalTotal = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
  }, [cart])

  const totalQuantity = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.quantity, 0)
  }, [cart])

  const handleConfirm = async () => {
    if (!order) return
    if (cart.length === 0) {
      toast.error('Please select at least one item to add')
      return
    }

    setSubmitting(true)
    setErrorMsg(null)

    const idempotencyKey = crypto.randomUUID()
    const payload = {
      items: cart.map((c) => ({
        menuItemId: c.menuItemId,
        portion: c.portion || null,
        portionId: c.portionId || null,
        quantity: c.quantity,
        notes: c.notes?.trim() || null,
      })),
      idempotencyKey,
    }

    try {
      const res = await edgeFetch(`/api/orders/${order.id}/items`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenantId,
        },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        let errText = 'Failed to add items to order'
        try {
          const errData = await res.json()
          if (errData.error) errText = errData.error
        } catch {}
        throw new Error(errText)
      }

      const updatedOrder = (await res.json()) as Order
      toast.success(`Items added to Order #${order.orderNumber}`)
      setCart([])
      onSuccess(updatedOrder)
      onOpenChange(false)
    } catch (err: any) {
      const msg = err.message || 'Failed to add items'
      setErrorMsg(msg)
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  if (!order) return null

  const orderTypeLabel = order.orderType === 'TAKEAWAY' ? 'Takeaway' : 'Delivery'
  const customerInfo = order.customerName || order.customerPhone || 'Walk-in'

  return (
    <Dialog open={open} onOpenChange={(val) => !submitting && onOpenChange(val)}>
      <DialogContent
        className="flex max-h-[92vh] w-[95vw] max-w-5xl flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-h-[88vh]"
        showCloseButton={false}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 bg-card px-4 py-3 sm:px-6 sm:py-4">
          <div className="min-w-0">
            <DialogTitle className="text-lg font-bold tracking-tight sm:text-xl">
              Adding Items to Order #{order.orderNumber}
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              <span className="font-semibold text-foreground/80">{orderTypeLabel}</span>
              {' · '}
              <span>Customer: {customerInfo}</span>
            </DialogDescription>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            aria-label="Close dialog"
            className="grid size-8 place-items-center rounded-full border border-border/80 bg-card text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Error notification banner */}
        {errorMsg && (
          <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-4 py-2.5 text-xs text-destructive sm:px-6">
            <AlertCircle className="size-4 shrink-0" />
            <span className="flex-1 font-medium">{errorMsg}</span>
            <button
              onClick={() => setErrorMsg(null)}
              className="text-xs font-semibold underline hover:opacity-80"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Main Content Area: Split 2-columns on desktop, stacked on mobile */}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[1fr_360px] lg:grid-cols-[1fr_400px]">
          {/* Menu Selection Column */}
          <div className="flex min-h-0 flex-col border-r border-border/60">
            {/* Search and Category Filter Toolbar */}
            <div className="space-y-2.5 border-b border-border/60 bg-muted/20 p-3 sm:p-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search dishes or ingredients…"
                  className="h-9.5 rounded-full bg-background pl-9 pr-8 text-xs sm:text-sm"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Categories Pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
                <CategoryPill
                  active={activeCategory === 'all'}
                  onClick={() => setActiveCategory('all')}
                  icon="🍽️"
                  label="All Items"
                />
                {categories.map((cat) => (
                  <CategoryPill
                    key={cat.id}
                    active={activeCategory === cat.id}
                    onClick={() => setActiveCategory(cat.id)}
                    icon={cat.icon || '🍲'}
                    label={cat.name}
                  />
                ))}
              </div>
            </div>

            {/* Menu Items List */}
            <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4 scrollbar-thin">
              {filteredItems.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center text-center text-muted-foreground">
                  <Utensils className="size-8 stroke-1 text-muted-foreground/60" />
                  <p className="mt-2 text-sm font-medium">No menu items found</p>
                  <p className="text-xs text-muted-foreground/80">Try adjusting your category or search term</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {filteredItems.map((item) => {
                    const itemLines = cart.filter((c) => c.menuItemId === item.id)
                    const inCartQty = itemLines.reduce((sum, c) => sum + c.quantity, 0)
                    return (
                      <MenuItemCard
                        key={item.id}
                        item={item}
                        currency={currencySymbol}
                        inCartQty={inCartQty}
                        itemLines={itemLines}
                        onAdd={() => handleAdd(item)}
                        onDecrement={() => handleDecrement(item)}
                        onAddPortion={(portion) => handleAddPortion(item, portion)}
                        onDecrementPortion={(portion) => handleDecrementPortion(item, portion)}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Cart & Review Column */}
          <div className="flex min-h-0 flex-col bg-card">
            <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
              <div className="flex items-center gap-2">
                <ShoppingBag className="size-4 text-primary" />
                <h4 className="text-sm font-bold">Newly Selected Items</h4>
              </div>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary tabular-nums">
                {totalQuantity} {totalQuantity === 1 ? 'item' : 'items'}
              </span>
            </div>

            {/* Cart Lines Scrollable List */}
            <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4 scrollbar-thin">
              {cart.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center text-center text-muted-foreground">
                  <ShoppingBag className="size-8 stroke-1 text-muted-foreground/50" />
                  <p className="mt-2 text-xs font-medium sm:text-sm">No items selected yet</p>
                  <p className="text-[11px] text-muted-foreground/80">
                    Add dishes from the menu on the left to include them in this order
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {cart.map((line, idx) => (
                    <CartLine
                      key={`${line.menuItemId}-${line.portionId ?? line.portion ?? 'standard'}`}
                      item={line}
                      currency={currencySymbol}
                      onAdd={() => handleCartLineAdd(idx)}
                      onDecrement={() => handleCartLineDecrement(idx)}
                      onRemove={() => handleCartLineRemove(idx)}
                      onNotesChange={(notes) => handleNotesChange(idx, notes)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Footer Summary & Action */}
            <div className="border-t border-border/60 bg-muted/20 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  Additional Total
                </span>
                <span className="text-base font-bold tabular-nums text-foreground">
                  {formatPrice(additionalTotal, currencySymbol)}
                </span>
              </div>

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitting}
                  onClick={() => onOpenChange(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={submitting || cart.length === 0}
                  onClick={handleConfirm}
                  className="flex-[2] bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="mr-1.5 size-4 animate-spin" />
                      Adding Items…
                    </>
                  ) : (
                    <>
                      <PlusCircle className="mr-1.5 size-4" />
                      Confirm &amp; Add Items
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
