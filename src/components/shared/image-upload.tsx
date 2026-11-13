'use client'

import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { Upload, X, Image as ImageIcon, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface ImageUploadProps {
  value: string
  onChange: (value: string) => void
  label?: string
  /** shape of the preview */
  shape?: 'circle' | 'square'
  /** size in px */
  size?: number
  /** fallback emoji/icon when empty */
  fallback?: React.ReactNode
  className?: string
  /** accept hint */
  accept?: string
  /** max file size in MB */
  maxSizeMB?: number
}

/**
 * Image upload component — file upload only (drag/drop or click).
 * Converts the selected file to a base64 data URL stored in the parent's string field.
 */
export function ImageUpload({
  value,
  onChange,
  label = 'Image',
  shape = 'circle',
  size = 80,
  fallback,
  className,
  accept = 'image/png,image/jpeg,image/webp,image/gif',
  maxSizeMB = 2,
}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file')
      return
    }
    if (file.size > maxSizeMB * 1024 * 1024) {
      toast.error(`Image too large (max ${maxSizeMB}MB)`)
      return
    }
    setLoading(true)
    const reader = new FileReader()
    reader.onload = () => {
      // The flag clears in `finally` so a throw in the caller's onChange —
      // which is where the value is parsed and stored — cannot leave the
      // upload tile spinning for ever.
      try {
        onChange(reader.result as string)
        toast.success('Image uploaded', { description: file.name })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not use that image')
      } finally {
        setLoading(false)
      }
    }
    reader.onerror = () => {
      setLoading(false)
      toast.error('Failed to read image')
    }
    reader.readAsDataURL(file)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  const clear = () => {
    onChange('')
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <Label className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
          <ImageIcon className="h-3.5 w-3.5" />
          {label}
        </Label>
      )}
      <div className="flex items-start gap-4">
        {/* Preview */}
        <div
          className="relative shrink-0 border-2 border-border bg-secondary flex items-center justify-center overflow-hidden"
          style={{ width: size, height: size, borderRadius: shape === 'circle' ? '9999px' : '1rem' }}
        >
          {value ? (
            <>
              <img src={value} alt="Preview" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={clear}
                className="absolute top-1 right-1 bg-background/90 backdrop-blur rounded-full p-1 text-muted-foreground hover:text-destructive transition-colors shadow"
                aria-label="Remove image"
              >
                <X className="h-3 w-3" />
              </button>
            </>
          ) : (
            <span className="text-2xl">{fallback || '🖼️'}</span>
          )}
        </div>

        {/* Upload zone */}
        <div className="flex-1 min-w-0">
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleFile(file)
            }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              'w-full flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed py-4 px-3 text-center transition-premium',
              dragOver
                ? 'border-primary bg-primary/10'
                : 'border-border bg-secondary/30 hover:border-primary/40 hover:bg-secondary/50'
            )}
          >
            {loading ? (
              <><Loader2 className="h-5 w-5 animate-spin text-primary" /><span className="text-xs text-muted-foreground">Uploading…</span></>
            ) : value ? (
              <>
                <Upload className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs font-medium">Change image</span>
                <span className="text-[10px] text-muted-foreground">Click or drop a new file</span>
              </>
            ) : (
              <>
                <Upload className="h-5 w-5 text-muted-foreground" />
                <span className="text-xs font-medium">Click to upload or drag & drop</span>
                <span className="text-[10px] text-muted-foreground">PNG, JPG, WebP · max {maxSizeMB}MB</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
