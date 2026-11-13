/**
 * The printed table card — one design, used by the on-screen preview, the PNG
 * download, "Download All", and the print sheet. Keeping a single description
 * here is what stops those four from drifting apart.
 *
 * The QR itself is untouched: the same `qrData` image the server generated for
 * the same token, so scanning behaves exactly as before. Everything added here
 * is branding drawn *around* it.
 */

export interface QrCardInput {
  /** PNG data URL of the QR code, straight from the qr function. */
  qrData: string
  restaurantName: string
  /** Data URL of the restaurant logo, or null for the monogram fallback. */
  logo?: string | null
  tableName: string
  area?: string | null
  seats?: number | null
  /** Shown in the footer. */
  poweredBy?: string
}

const BRAND = '#f97316'
const INK = '#111827'
const MUTED = '#6b7280'
const HAIRLINE = '#e5e7eb'

/** Card geometry in CSS pixels at 1x; the raster export renders it at 2x. */
const CARD_W = 520
const PAD = 40
const QR_SIZE = 340

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'T'
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    // A logo stored as a remote URL would taint the canvas and make the PNG
    // export throw; the fallback monogram keeps the card working.
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * Draw the card onto a fresh canvas and return it. Exposed so the preview can
 * show the exact pixels the download will contain.
 */
export async function drawQrCard(input: QrCardInput, scale = 2): Promise<HTMLCanvasElement | null> {
  const qr = await loadImage(input.qrData)
  if (!qr) return null

  const logo = input.logo ? await loadImage(input.logo) : null

  const meta = [input.area, input.seats ? `${input.seats} seats` : null].filter(Boolean).join(' · ')
  const LOGO = 34
  const FOOTER = 16
  // Height is the sum of the layout below, so the card ends where the content
  // ends instead of carrying a strip of white at the bottom.
  const height =
    PAD + LOGO + 18 + 34 + (meta ? 22 : 4) + 14 + 30 + QR_SIZE + 26 + 20 + FOOTER + PAD

  const canvas = document.createElement('canvas')
  canvas.width = CARD_W * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)

  // Sheet
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, CARD_W, height)

  let y = PAD

  // Brand row: logo (or monogram) + restaurant name
  const logoSize = LOGO
  const nameX = PAD + logoSize + 12
  if (logo) {
    ctx.save()
    roundRect(ctx, PAD, y, logoSize, logoSize, 9)
    ctx.clip()
    const ratio = Math.min(logoSize / logo.width, logoSize / logo.height)
    const w = logo.width * ratio
    const h = logo.height * ratio
    ctx.drawImage(logo, PAD + (logoSize - w) / 2, y + (logoSize - h) / 2, w, h)
    ctx.restore()
  } else {
    // No logo (or one that would not decode): the monogram keeps the header
    // shaped like every other restaurant's card.
    ctx.fillStyle = BRAND
    roundRect(ctx, PAD, y, logoSize, logoSize, 9)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = '600 16px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(initials(input.restaurantName), PAD + logoSize / 2, y + logoSize / 2 + 1)
  }

  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = INK
  ctx.font = '700 20px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.fillText(clip(ctx, input.restaurantName, CARD_W - nameX - PAD), nameX, y + logoSize / 2)
  y += logoSize + 18

  // Table identity — the thing staff match against when they print ten of these
  ctx.fillStyle = INK
  ctx.font = '700 26px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(clip(ctx, input.tableName, CARD_W - PAD * 2), CARD_W / 2, y + 15)
  y += 34

  if (meta) {
    ctx.fillStyle = MUTED
    ctx.font = '400 14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    ctx.fillText(clip(ctx, meta, CARD_W - PAD * 2), CARD_W / 2, y + 8)
    y += 22
  } else {
    y += 4
  }

  // "Scan to Order" sits directly above the code, where the eye lands first
  y += 14
  ctx.fillStyle = BRAND
  ctx.font = '700 15px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.fillText('SCAN TO ORDER', CARD_W / 2, y + 8)
  y += 30

  // The QR — large, centred, with quiet-zone padding so it scans from paper
  const qrX = (CARD_W - QR_SIZE) / 2
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(qr, qrX, y, QR_SIZE, QR_SIZE)
  y += QR_SIZE + 26

  // Footer
  ctx.fillStyle = HAIRLINE
  ctx.fillRect(PAD + 20, y, CARD_W - (PAD + 20) * 2, 1)
  y += 20

  ctx.fillStyle = MUTED
  ctx.font = '400 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  const poweredBy = `Powered by ${input.poweredBy ?? 'The Salad'}`
  const textW = ctx.measureText(poweredBy).width
  const dot = 5
  const groupW = dot + 7 + textW
  const startX = (CARD_W - groupW) / 2
  ctx.fillStyle = BRAND
  ctx.beginPath()
  ctx.arc(startX + dot / 2, y + 7, dot / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = MUTED
  ctx.textAlign = 'left'
  ctx.fillText(poweredBy, startX + dot + 7, y + 7)

  return canvas
}

function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1)
  return `${out}…`
}

/** PNG bytes of the branded card, or null when the QR image failed to decode. */
export async function qrCardBlob(input: QrCardInput): Promise<Blob | null> {
  const canvas = await drawQrCard(input, 2)
  if (!canvas) return null
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png')
    } catch {
      resolve(null) // tainted canvas — a remote logo we could not copy
    }
  })
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * The print sheet. Same content as the PNG, laid out in millimetres so the QR
 * keeps a real, scannable physical size on A5/A6 paper regardless of DPI.
 */
export function qrCardPrintHtml(input: QrCardInput): string {
  const esc = (v: string) =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const meta = [input.area, input.seats ? `${input.seats} seats` : null].filter(Boolean).join(' · ')
  const logo = input.logo
    ? `<img class="logo" src="${esc(input.logo)}" alt="" />`
    : `<div class="logo mono">${esc(initials(input.restaurantName))}</div>`

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(input.tableName)} — QR Code</title>
<style>
  @page { size: auto; margin: 12mm; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: #fff; color: ${INK};
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex; align-items: center; justify-content: center;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .card { width: 120mm; padding: 8mm 6mm; text-align: center; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 3mm; }
  .logo { width: 11mm; height: 11mm; border-radius: 2.5mm; object-fit: cover; }
  .logo.mono {
    background: ${BRAND}; color: #fff; font-weight: 700; font-size: 5mm;
    display: flex; align-items: center; justify-content: center;
  }
  .restaurant { font-size: 5mm; font-weight: 700; letter-spacing: -0.01em; max-width: 82mm; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .table { font-size: 8mm; font-weight: 800; margin-top: 7mm; letter-spacing: -0.02em; }
  .meta { font-size: 3.6mm; color: ${MUTED}; margin-top: 1.5mm; }
  .scan { font-size: 3.8mm; font-weight: 700; color: ${BRAND}; letter-spacing: .14em; margin-top: 6mm; }
  .qr { width: 88mm; height: 88mm; margin: 3mm auto 0; display: block; image-rendering: pixelated; }
  .rule { border: 0; border-top: 1px solid ${HAIRLINE}; width: 60mm; margin: 7mm auto 4mm; }
  .powered { font-size: 3.2mm; color: ${MUTED}; display: flex; align-items: center; justify-content: center; gap: 1.6mm; }
  .dot { width: 1.6mm; height: 1.6mm; border-radius: 50%; background: ${BRAND}; display: inline-block; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">${logo}<div class="restaurant">${esc(input.restaurantName)}</div></div>
    <div class="table">${esc(input.tableName)}</div>
    ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
    <div class="scan">SCAN TO ORDER</div>
    <img class="qr" src="${esc(input.qrData)}" alt="QR code for ${esc(input.tableName)}" />
    <hr class="rule" />
    <div class="powered"><span class="dot"></span>Powered by ${esc(input.poweredBy ?? 'The Salad')}</div>
  </div>
</body>
</html>`
}
