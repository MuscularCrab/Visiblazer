export function hexToRgb(h) {
  h = (h || '#000').replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// h,s,l in 0..1 -> linear-ish rgb 0..1
export function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l)
  const f = (k) => {
    const x = (k + h * 12) % 12
    return l - a * Math.max(-1, Math.min(Math.min(x - 3, 9 - x), 1))
  }
  return [f(0), f(8), f(4)]
}
