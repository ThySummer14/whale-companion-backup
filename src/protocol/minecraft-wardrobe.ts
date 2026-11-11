import { z } from 'zod'

export const MinecraftWardrobeId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u)
const MinecraftWardrobeLabel = z.string().trim().min(1).max(80).regex(/^[^\p{C}]+$/u)
const providerId = z.string().max(96).regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.:+/()（） -]*$/u)
  .refine(value => value === value.trim())
export const MinecraftWardrobeConfigSchema = z.array(z.strictObject({
  id: MinecraftWardrobeId,
  label: MinecraftWardrobeLabel,
  modelId: providerId,
})).min(1).max(32).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length)

export const MinecraftWardrobeViewSchema = z.strictObject({
  available: z.boolean(),
  options: z.array(z.strictObject({ id: MinecraftWardrobeId, label: MinecraftWardrobeLabel })).max(32),
  last: z.strictObject({ id: MinecraftWardrobeId, confirmedAt: z.iso.datetime() }).optional(),
}).refine(view => !view.last || view.options.some(option => option.id === view.last?.id))

export type MinecraftWardrobeView = z.infer<typeof MinecraftWardrobeViewSchema>
