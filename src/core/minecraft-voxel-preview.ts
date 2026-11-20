import { voxelPreviewColor } from './minecraft-magica-voxel.ts'
import type { compileVoxelCells } from './minecraft-voxel.ts'
import { encodePng } from './png.ts'

export function renderVoxelPreview({ size: [width, height, depth], entries, materials, info }: ReturnType<typeof compileVoxelCells>): Buffer {
  const spanX = width + depth
  const spanY = height + (width + depth) / 2
  const scale = Math.min(12, 704 / spanX, 600 / spanY)
  const margin = 16
  const canvasWidth = Math.ceil(spanX * scale) + 2 * margin
  const canvasHeight = Math.ceil(spanY * scale) + 2 * margin
  const stride = 3 * canvasWidth + 1
  const pixels = Buffer.alloc(stride * canvasHeight)
  for (let row = 0; row < canvasHeight; row++) pixels.fill(0xec, row * stride + 1, (row + 1) * stride)

  const layer = width * depth
  const cells = new Uint8Array(info.totalVolume)
  const colors = materials.map(voxelPreviewColor)
  for (const { index, material } of entries) cells[index] = material ? 1 : 0

  function face(sx: number, sy: number, ax: number, ay: number, bx: number, by: number, color: number, shade: number) {
    const left = Math.max(0, Math.floor(sx + Math.min(ax, 0) + Math.min(bx, 0)))
    const right = Math.min(canvasWidth, Math.ceil(sx + Math.max(ax, 0) + Math.max(bx, 0)))
    const top = Math.max(0, Math.floor(sy + Math.min(ay, 0) + Math.min(by, 0)))
    const bottom = Math.min(canvasHeight, Math.ceil(sy + Math.max(ay, 0) + Math.max(by, 0)))
    const inverse = 1 / (ax * by - ay * bx)
    const red = (color >>> 16) * shade
    const green = (color >>> 8 & 255) * shade
    const blue = (color & 255) * shade
    for (let y = top; y < bottom; y++) {
      const py = y + 0.5 - sy
      for (let x = left; x < right; x++) {
        const px = x + 0.5 - sx
        const u = (px * by - py * bx) * inverse
        const v = (ax * py - ay * px) * inverse
        if (u < -1e-7 || u > 1.0000001 || v < -1e-7 || v > 1.0000001) continue
        const offset = y * stride + 3 * x + 1
        pixels[offset] = red
        pixels[offset + 1] = green
        pixels[offset + 2] = blue
      }
    }
  }

  const half = scale / 2
  // Along any view ray, X, Y and Z increase toward the eye. Sorted cell indices draw back to front.
  for (const { index, position: [x, y, z], material } of entries) {
    if (!material) continue
    const screenX = margin + (x - z + depth) * scale
    const screenY = margin + (x + z) * half + (height - y) * scale
    const color = colors[material]!
    if (x + 1 === width || !cells[index + 1]) face(screenX + scale, screenY + half, -scale, half, 0, -scale, color, 0.65)
    if (z + 1 === depth || !cells[index + width]) face(screenX - scale, screenY + half, scale, half, 0, -scale, color, 0.83)
    if (y + 1 === height || !cells[index + layer]) face(screenX, screenY - scale, scale, half, -scale, half, color, 1)
  }
  return encodePng(canvasWidth, canvasHeight, pixels)
}
