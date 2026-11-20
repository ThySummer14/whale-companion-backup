#!/usr/bin/env node
import { closeSync, openSync, readSync, writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { parseArgs } from 'node:util'
import { exportLitematica, inspectLitematica } from '../src/core/litematica.ts'
import { compileMagicaVoxel } from '../src/core/minecraft-magica-voxel.ts'
import { renderVoxelPreview } from '../src/core/minecraft-voxel-preview.ts'
import { compileMinecraftVoxels, exportVoxelSchematic, exportVoxelStructure } from '../src/core/minecraft-voxel.ts'

const help = `dsh-litematica [--json] doctor
dsh-litematica [--json] inspect <layout.json|->
dsh-litematica [--json] export <layout.json|-> --out <file.litematic> [--name <title>]
dsh-litematica [--json] voxel <voxel-blueprint.json|-> [--out <file.schem|file.nbt>]
dsh-litematica [--json] vox <model.vox|-> [--palette <colors.json>] [--depth-as-z] [--out <file.schem> [--preview <file.png>]]

Accepts a Companion layout or a draft with a layout field. Use - for stdin.
Export writes a new file. Copy it into the client's .minecraft/schematics.
Voxel blueprints use version 1, size [x,y,z], palette { alias: "namespace:block[state=value]" },
and voxels [[x,y,z,alias], ...]. Omit --out to inspect. .schem opens in Axiom;
.nbt is a Minecraft structure template that writes only explicitly listed coordinates.
The vox command accepts a single MagicaVoxel model without scene transforms. Colors map to
vanilla blocks, with optional overrides { "#rrggbb": "namespace:block" }. The depth axis is
reflected by default. Use --depth-as-z for exporters that already store positive Minecraft Z.
`
function readBytes(file: string, limit: number): Buffer {
  const fd = file === '-' ? 0 : openSync(file, 'r')
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const bytes = Buffer.allocUnsafe(Math.min(65_536, limit + 1 - size))
      const count = readSync(fd, bytes)
      if (!count) break
      size += count
      if (size > limit) throw new Error('input-too-large')
      chunks.push(bytes.subarray(0, count))
    }
  } finally {
    if (file !== '-') closeSync(fd)
  }
  return Buffer.concat(chunks, size)
}

function readInput(file: string, limit: number): unknown {
  return JSON.parse(readBytes(file, limit).toString('utf8'))
}

const args = process.argv.slice(2)
let voxel = false
try {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, out: { type: 'string' }, name: { type: 'string' },
    palette: { type: 'string' }, 'depth-as-z': { type: 'boolean' }, preview: { type: 'string' },
  } })
  const [command, file, ...extra] = positionals
  if (values.help || !command) {
    process.stdout.write(values.json ? JSON.stringify({ ok: true, help }) + '\n' : help)
  } else if (command === 'vox') {
    if (!file || extra.length || values.name || (values.out !== undefined && extname(values.out) !== '.schem') ||
        (values.preview !== undefined && (!values.out || extname(values.preview) !== '.png')) ||
        (file === '-' && values.palette === '-')) throw new Error('invalid-command')
    const { blueprint, source } = compileMagicaVoxel(readBytes(file, 65 * 1024 * 1024), {
      ...(values.palette && { palette: readInput(values.palette, 256 * 1024) }),
      ...(values['depth-as-z'] && { depthAsZ: true }),
    })
    if (values.out) writeFileSync(values.out, exportVoxelSchematic(blueprint), { flag: 'wx' })
    if (values.preview) writeFileSync(values.preview, renderVoxelPreview(blueprint), { flag: 'wx' })
    const format = values.out ? 'sponge-schematic-v3' : 'magica-voxel'
    console.log(JSON.stringify({ ok: true, format, ...blueprint.info, source, ...(values.out && { file: values.out }) }, null, values.json ? 0 : 2))
  } else if (values.palette !== undefined || values['depth-as-z'] !== undefined || values.preview !== undefined) {
    throw new Error('invalid-command')
  } else if (command === 'doctor' && !file && !values.out && !values.name) {
    console.log(JSON.stringify({ ok: true, mode: 'offline', authRequired: false, target: 'Minecraft 1.21.1 / Litematica v7' }, null, values.json ? 0 : 2))
  } else if (command === 'voxel') {
    voxel = true
    const extension = values.out && extname(values.out)
    if (!file || extra.length || values.name || values.out && extension !== '.nbt' && extension !== '.schem') throw new Error('invalid-command')
    const blueprint = compileMinecraftVoxels(readInput(file, 16 * 1024 * 1024))
    const format = extension === '.schem' ? 'sponge-schematic-v3' : extension === '.nbt' ? 'minecraft-structure' : 'voxel-blueprint-v1'
    if (values.out) {
      const encoded = extension === '.schem' ? exportVoxelSchematic(blueprint) : exportVoxelStructure(blueprint)
      writeFileSync(values.out, encoded, { flag: 'wx' })
    }
    console.log(JSON.stringify({ ok: true, format, ...blueprint.info, ...(values.out && { file: values.out }) }, null, values.json ? 0 : 2))
  } else {
    if (!file || extra.length || command !== 'inspect' && command !== 'export' ||
        command === 'inspect' && (values.out || values.name) ||
        command === 'export' && (!values.out || extname(values.out) !== '.litematic')) throw new Error('invalid-command')
    const input = readInput(file, 65_536) as { layout?: unknown; name?: unknown } | null
    const layout = input?.layout ?? input
    const info = inspectLitematica(layout)
    if (values.out) {
      const name = values.name ?? (typeof input?.name === 'string' ? input.name : 'Companion')
      writeFileSync(values.out, exportLitematica(layout, name), { flag: 'wx' })
    }
    console.log(JSON.stringify({ ok: true, ...info, ...(values.out && { file: values.out }) }, null, values.json ? 0 : 2))
  }
} catch (error) {
  const code = error instanceof Error && error.name === 'ZodError' ? (voxel ? 'invalid-voxel-blueprint' : 'invalid-layout')
    : error instanceof SyntaxError ? 'invalid-json'
    : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
    : error instanceof Error && ['invalid-command', 'input-too-large'].includes(error.message) ? error.message
    : 'invalid-command'
  console.error(args.includes('--json') ? JSON.stringify({ ok: false, code }) : `dsh-litematica: ${code}`)
  process.exitCode = 1
}
