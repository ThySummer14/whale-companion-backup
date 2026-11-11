import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CompanionRuntime } from './runtime.ts'

const output = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] } as const
const LOGS = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'] as const

export function registerMinecraftTools(ctx: Context, runtime: CompanionRuntime): () => void {
  const authority = (exec: ToolRunContext) => {
    exec.signal.throwIfAborted()
    const agent = exec.agent ?? ctx.agents.currentInitiator()
    const binding = agent && runtime.store.bindingBySession(agent.id)
    if (!agent || !binding || binding.contextId !== 'game.minecraft') throw new Error('Minecraft tools require the game.minecraft session')
    return binding
  }
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'mc_status',
      description: 'Read confirmed Minecraft connection and action state, or one specific detail: authorized build zones, wardrobe choices or game lessons.',
      parameters: {
        section: { type: 'string', enum: ['overview', 'build_zones', 'wardrobe', 'lessons', 'places'], description: 'Defaults to overview. Use places to read or name verified building locations.' },
        offset: { type: 'number', description: 'For build_zones, use nextOffset when returned.' },
      }, output,
      async execute(args, exec) {
        authority(exec)
        return JSON.stringify(await runtime.minecraft.modelStatus(args.section ?? 'overview', args.offset ?? 0, exec.signal))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_name_place',
      description: 'Name or rename a fully verified Minecraft building from mc_status section places. Saves the exact authorized-zone center, not an entrance or current position. Does not move, teleport or build.',
      parameters: {
        projectId: { type: 'string', description: 'The verified project ID from mc_status section places.', required: true },
        name: { type: 'string', description: 'A unique 1–40 character place name.', required: true },
      }, output,
      async execute(args, exec) {
        const binding = authority(exec)
        const agent = exec.agent
        if (binding.kind !== 'game' || !agent || ctx.agents.get(agent.id) !== agent ||
          agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) > 0) {
          throw new Error('Place naming requires the live Minecraft root session')
        }
        return JSON.stringify(runtime.minecraft.nameHouseProjectPlace(args.projectId, args.name, 'companion', exec.signal))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_storage',
      description: 'Use the optional OVO skill library to deposit or withdraw 1–16 items in an owner-authorized zone. Both backpack and chest deltas are verified; no commands, breaking or placement are allowed.',
      parameters: {
        zoneId: { type: 'string', description: 'An active owner-authorized zone ID.', required: true },
        operation: { type: 'string', enum: ['deposit', 'withdraw'], required: true },
        itemName: { type: 'string', enum: ['oak_log', 'spruce_log', 'oak_planks', 'spruce_planks', 'cobblestone', 'sand', 'raw_iron', 'iron_ingot', 'coal', 'charcoal', 'glass'], required: true },
        count: { type: 'number', description: 'Whole items, 1–16.', required: true },
      }, output,
      async execute(args, exec) {
        const binding = authority(exec)
        const agent = exec.agent
        if (binding.kind !== 'game' || !agent || ctx.agents.get(agent.id) !== agent ||
          agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) > 0) {
          throw new Error('OVO storage requires the live Minecraft root session')
        }
        const { task, result } = await runtime.minecraft.ovoStorage(args.zoneId, args.operation, args.itemName, args.count, exec.signal)
        return JSON.stringify({ taskId: task.id, receipt: result })
      },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_smelt',
      description: 'Use the optional OVO skill library to start a small furnace job or collect its exact output later. Requires an authorized zone, existing furnace, coal/charcoal and real inventory receipts.',
      parameters: {
        zoneId: { type: 'string', description: 'An active owner-authorized zone ID.', required: true },
        phase: { type: 'string', enum: ['start', 'collect'], description: 'Start inputs first; collect only the same furnace output later.', required: true },
        itemName: { type: 'string', enum: ['sand', 'raw_iron', 'beef', 'cobblestone'], required: true },
        count: { type: 'number', description: 'Whole items, 1–4.', required: true },
      }, output,
      async execute(args, exec) {
        const binding = authority(exec)
        const agent = exec.agent
        if (binding.kind !== 'game' || !agent || ctx.agents.get(agent.id) !== agent ||
          agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) > 0) {
          throw new Error('OVO smelting requires the live Minecraft root session')
        }
        const { task, result } = await runtime.minecraft.ovoSmelt(args.zoneId, args.phase, args.itemName, args.count, exec.signal)
        return JSON.stringify({ taskId: task.id, receipt: result })
      },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_observe',
      description: 'Observe real server data: position, health, hunger, players, inventory, local combat reflex threat, shield state, tool durability and return-resource policy.',
      parameters: {}, output,
      async execute(_args, exec) { authority(exec); return JSON.stringify(await runtime.minecraft.observe()) },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_chat',
      description: 'Privately send a short ordinary message to the online owner as the companion. Slash commands and operator commands are not allowed.',
      parameters: { text: { type: 'string', description: 'A message from 1 to 256 characters, without a leading slash.', required: true } }, output,
      async execute(args, exec) { authority(exec); return JSON.stringify(await runtime.minecraft.modelChat(args.text, exec.signal)) },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_follow',
      description: 'Follow the real online owner using server-side CBI pathfinding. Follow continues until mc_stop; it does not teleport or grant OP.',
      parameters: {}, output,
      async execute(_args, exec) { authority(exec); return JSON.stringify(await runtime.minecraft.follow()) },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_move',
      description: 'Move to nearby coordinates using CBI. Limited to 32 horizontal blocks and 8 vertical blocks; placement and general breaking are disabled.',
      parameters: {
        x: { type: 'number', description: 'Integer X coordinate.', required: true },
        y: { type: 'number', description: 'Integer Y coordinate.', required: true },
        z: { type: 'number', description: 'Integer Z coordinate.', required: true },
      }, output,
      async execute(args, exec) { authority(exec); return JSON.stringify(await runtime.minecraft.move(args, exec.signal)) },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_dig',
      description: 'Collect one verified natural log with nearby leaves using precise CBI break and pickup. No player buildings or arbitrary breaking. The block becoming air and the inventory are read back.',
      parameters: { name: { type: 'string', enum: LOGS, description: 'Natural log species, default oak_log.' } }, output,
      async execute(args, exec) { authority(exec); return JSON.stringify(await runtime.minecraft.dig(args.name, exec.signal)) },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_return',
      description: 'Escape a short vertical shaft to an adjacent verified ledge. Limited to 16 blocks; uses only cheap blocks or planks, never reserved logs, breaking, fluids or arbitrary building. Succeeds only after the actual exit and placement receipts are confirmed.',
      parameters: {}, output,
      async execute(_args, exec) { authority(exec); return JSON.stringify(await runtime.minecraft.returnToSafety(exec.signal)) },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_craft',
      description: 'Craft one exact allowlisted survival recipe using real Minecraft recipes and a rollback-safe inventory transaction. Wooden/stone pickaxes and shields require an existing reachable crafting table. Output inventory delta is independently verified.',
      parameters: { name: { type: 'string', enum: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'shield'], description: 'One recipe to craft once.', required: true } }, output,
      async execute(args, exec) { authority(exec); return JSON.stringify(await runtime.minecraft.craft(args.name, exec.signal)) },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_shield',
      description: 'Raise an owned shield for 1 to 5 seconds without steering or attacking. The server verifies actual blocking and release. Emergency avoidance can interrupt. Older servers return unavailable.',
      parameters: {
        seconds: { type: 'number', description: 'Whole seconds, 1 to 5. Defaults to 2.' },
      }, output,
      async execute(args, exec) {
        const binding = authority(exec)
        const agent = exec.agent
        if (binding.kind !== 'game' || !agent || ctx.agents.get(agent.id) !== agent ||
          agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) > 0) {
          throw new Error('Shield actions require the live Minecraft root session')
        }
        const { task, result } = await runtime.minecraft.holdShield(args, exec.signal)
        return JSON.stringify({ taskId: task.id, receipt: result })
      },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_build_camp',
      description: 'Build a small 3x3 camp inside an existing owner-authorized build zone. Places at most 8 floor blocks and 1 crafting table without overwriting anything. The model cannot create or expand zones. World state and exact inventory consumption are verified.',
      parameters: {
        zoneId: { type: 'string', description: 'An active zone created by the owner in the workbench.', required: true },
        material: { type: 'string', enum: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'cobblestone', 'dirt', 'stone'], description: 'Floor material; exactly 8 are required plus one existing crafting table.', required: true },
      }, output,
      async execute(args, exec) { authority(exec); return JSON.stringify(await runtime.minecraft.buildCamp(args.zoneId, args.material, exec.signal)) },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_prepare_camp',
      description: 'Prepare resources and build one owner-authorized 3x3 camp through real gather, recipe and build actions. Re-reads inventory between steps, preserves two logs, and stops on the first failed action. Limited to 6 gathers, 5 crafts and 1 build; partial progress is not rolled back.',
      parameters: {
        zoneId: { type: 'string', description: 'An active owner-authorized zone ID.', required: true },
        material: { type: 'string', enum: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks'], description: 'Wood species for the camp, default oak_planks.' },
      }, output,
      async execute(args, exec) { authority(exec); return JSON.stringify(await runtime.minecraft.prepareCamp(args.zoneId, args.material, exec.signal)) },
    })),
    ctx.tools.register(defineTool({
      name: 'mc_stop',
      description: 'Stop CBI actions and all local survival reflexes, including combat, avoidance, eating and resource crafting. A new explicit action resumes reflexes; does not disconnect the fake player.',
      parameters: {}, output,
      async execute(_args, exec) { authority(exec); return JSON.stringify(await runtime.minecraft.stop()) },
    })),
  ]
  if (runtime.minecraft.wardrobeConfigured) disposers.push(ctx.tools.register(defineTool({
    name: 'mc_change_appearance',
    description: 'Choose your own appearance from mc_status section wardrobe when wardrobe.available is true. Only the configured Carpet character is changed. A receipt confirms the server accepted the setting. Visual rendering depends on the game client.',
    parameters: { id: { type: 'string', description: 'An appearance ID from mc_status section wardrobe.', required: true } },
    output,
    async execute(args, exec) {
      const binding = authority(exec)
      const agent = exec.agent
      if (binding.kind !== 'game' || !agent || ctx.agents.get(agent.id) !== agent ||
        agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) > 0) {
        throw new Error('Appearance changes require the live Minecraft root session')
      }
      return JSON.stringify(await runtime.minecraft.changeAppearance(args.id, exec.signal))
    },
  })))
  return () => { for (const dispose of disposers) dispose() }
}
