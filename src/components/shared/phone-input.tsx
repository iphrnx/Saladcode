'use client'

import { useState, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { ChevronDown } from 'lucide-react'

// Country codes — India only (optimized for Indian restaurants)
const COUNTRIES: { code: string; dial: string; name: string; flag: string }[] = [
  { code: 'IN', dial: '+91', name: 'India', flag: '🇮🇳' },
]

interface PhoneInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

/**
 * Phone input with country code + flag selector.
 * The value stored is the full phone number including dial code (e.g. "+91 98765 43210").
 * On load, it tries to detect the dial code from the value; defaults to India (+91).
 */
export function PhoneInput({ value, onChange, placeholder = 'Phone number', className }: PhoneInputProps) {
  // Try to detect the country from the existing value
  const detected = useMemo(() => {
    if (!value) return COUNTRIES[0] // default India
    // Find the longest matching dial code
    const sorted = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length)
    for (const c of sorted) {
      if (value.startsWith(c.dial)) return c
    }
    return COUNTRIES[0]
  }, [value])

  const [selected, setSelected] = useState(detected)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  // Extract the local number (without the dial code)
  const localNumber = useMemo(() => {
    if (!value) return ''
    if (value.startsWith(selected.dial)) {
      return value.slice(selected.dial.length).trim()
    }
    // If the value starts with a different dial code, return as-is
    return value.replace(/^[\+\d]+\s?/, '').trim() || value
  }, [value, selected])

  const filtered = useMemo(() => {
    if (!search) return COUNTRIES
    const q = search.toLowerCase()
    return COUNTRIES.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.dial.includes(q) ||
      c.code.toLowerCase().includes(q)
    )
  }, [search])

  const handleSelect = (country: typeof selected) => {
    setSelected(country)
    setOpen(false)
    setSearch('')
    // Update the full value with the new dial code + existing local number
    onChange(`${country.dial} ${localNumber}`.trim())
  }

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const num = e.target.value.replace(/[^\d\s\-()]/g, '')
    onChange(`${selected.dial} ${num}`.trim())
  }

  return (
    <div className={cn('relative flex items-center', className)}>
      {/* Country selector button */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 h-10 pl-3 pr-2 rounded-l-xl bg-secondary/50 border-r border-border shrink-0 hover:bg-secondary transition-premium"
        aria-label="Select country code"
      >
        <span className="text-xl leading-none">{selected.flag}</span>
        <span className="text-sm font-medium text-foreground">{selected.dial}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {/* Phone number input */}
      <Input
        value={localNumber}
        onChange={handleNumberChange}
        placeholder={placeholder}
        className="rounded-l-none bg-secondary/50 border-0 flex-1 min-w-0"
      />

      {/* Country dropdown */}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-50 w-72 max-h-72 overflow-hidden rounded-xl bg-popover border border-border shadow-elevated">
            {/* Search */}
            <div className="p-2 border-b border-border">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search country…"
                className="w-full bg-secondary/60 rounded-lg px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
                autoFocus
              />
            </div>
            {/* Country list */}
            <div className="max-h-56 overflow-y-auto scrollbar-thin">
              {filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No countries found</p>
              ) : filtered.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => handleSelect(c)}
                  className={cn(
                    'flex items-center gap-2.5 w-full px-3 py-2 text-left text-sm hover:bg-secondary/60 transition-colors',
                    selected.code === c.code && 'bg-primary/10 text-primary'
                  )}
                >
                  <span className="text-xl leading-none">{c.flag}</span>
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="text-muted-foreground text-xs font-medium">{c.dial}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
