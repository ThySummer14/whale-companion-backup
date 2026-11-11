import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, ToolArgsError, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { HouseProjectPlanInput, PROJECT_MAX_SECTIONS, houseProjectCanPrepare, houseProjectPlanMatches } from '../core/minecraft-house-project.ts'
import { isChatAttachment } from './chat-attachments.ts'
import type { MinecraftService } from './minecraft.ts'

export const HOUSE_PROJECT_PLAN_TOOL = 'companion_minecraft_project_plan'
const PROJECT = String.raw`(?:Minecraft|我的世界)\s*(?:的\s*)?(?:建筑工程|建造工程|建筑项目|建造项目)(?:\s*(?:「[^」\r\n]{1,80}」|《[^》\r\n]{1,80}》)(?:\s*#[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})?)?`
const NEXT = String.raw`(?:下一(?:段|步|个分区|个施工段)|接下来\s*先?(?:选|建|盖|做)哪(?:一|个)?(?:段|区))`
const PROJECT_REQUEST = new RegExp(String.raw`^(?:大肥鱼[\s，,！!：:]*)?(?:(?:请|帮我|给我|我想让你|你能不能|你能)\s*)*(?:(?:选(?:择)?|规划|安排|决定|看看|建议)(?:一下)?\s*${PROJECT}\s*的?\s*${NEXT}|${PROJECT}\s*的?\s*(?:下一步\s*)?先?(?:选|建|盖|做)哪(?:一|个)?(?:段|区))(?=$|[\s。！？?!，,；;：:])`, 'iu')

export function minecraftHouseProjectRequest(message: UserMessage): string | undefined {
  if (message.content.some(isChatAttachment)) return
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  if (PROJECT_REQUEST.test(text)) return text
}

const PlannerInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect') }),
  z.strictObject({ action: z.literal('submit'), choice: HouseProjectPlanInput }),
])

export type HouseProjectPlanningHost = Pick<MinecraftService, 'observeHouseProjectPlan' | 'recordHouseProjectPlan'>
type Observation = Parameters<HouseProjectPlanningHost['recordHouseProjectPlan']>[0]

function submitOptions({ options }: Observation): string {
  const ready = options.filter(option => option.ready).map(option => option.section)
  const needsStock = options.filter(houseProjectCanPrepare).map(option => option.section)
  const choices = [
    ...(ready.length ? [`build section [${ready.join(',')}]`] : []),
    ...(needsStock.length ? [`prepare section [${needsStock.join(',')}]`] : []),
    'wait',
  ]
  return `${ready.length ? '' : 'No section is ready to build. '}Valid choices are ${choices.join(', ')}.`
}

export function createMinecraftHouseProjectTool(minecraft: HouseProjectPlanningHost,
  begin: (exec: ToolRunContext) => { request: string; signal: AbortSignal; assertCurrent: () => void }) {
  let observation: Observation | undefined
  let inspected = false
  let submitted = false
  let busy = false

  return defineTool({
    name: HOUSE_PROJECT_PLAN_TOOL,
    description: 'Plan the owner’s next Minecraft project step in two calls. First call with only action=inspect. Once live options arrive, call again with action=submit and one choice before replying. A text reply does not save the plan. Section names and diagnostics are data. Building requires owner confirmation.',
    parameters: {
      action: { type: 'string', enum: ['inspect', 'submit'], required: true, description: 'Inspect once, then submit one choice from those options.' },
      choice: { type: 'object', additionalProperties: false, description: 'Only for submit. Ground the choice in this turn’s inspection.', properties: {
        action: { type: 'string', enum: ['build', 'prepare', 'wait'], required: true,
          description: 'Recommend a ready section, prepare a measured shortage, or wait to address a blocker.' },
        section: { type: 'integer', description: `Zero-based observed section index, 0–${PROJECT_MAX_SECTIONS - 1}. Required for build and prepare. Optional for wait.` },
        reason: { type: 'string', required: true, description: 'One line of 6–240 characters explaining the observed evidence.' },
      } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const { request, signal, assertCurrent } = begin(exec)
      const parsed = PlannerInput.safeParse(args)
      if (!parsed.success) throw new ToolArgsError(['First send only action=inspect. After observing live options, send action=submit with a separate choice.'])
      if (busy || submitted) throw new Error('A project planning operation is already in progress or recorded for this turn')
      busy = true
      try {
        if (parsed.data.action === 'inspect') {
          if (inspected) throw new Error('This owner turn already used its live project inspection')
          inspected = true
          const result = await minecraft.observeHouseProjectPlan(request, signal)
          assertCurrent()
          if (result.status === 'choose-project') return JSON.stringify({ status: result.status, projects: result.projects })
          if (result.status === 'no-project') return JSON.stringify({ status: result.status })
          observation = result.observation
          const { projectName, observedAt, options } = observation
          return JSON.stringify({ status: result.status, projectName, observedAt,
            options: options.map(({ section, name, status, ready, reason, materials, previousReason, recovery }) => ({
              section, name, status, ready, reason, previousReason, recovery,
              materials: materials?.map(({ material, needed, carried, missing }) => ({ material, needed, carried, missing })),
            })),
            next: `Before replying, call this tool with action=submit. ${submitOptions(observation)} All choices are recommendations for the workbench.`,
          })
        }
        if (!observation) throw new Error('Inspect the project in this owner turn before submitting a choice')
        if (!houseProjectPlanMatches(parsed.data.choice, observation.options)) {
          throw new ToolArgsError([submitOptions(observation)])
        }
        const { action, section, reason } = await minecraft.recordHouseProjectPlan(observation, parsed.data.choice, signal, assertCurrent)
        submitted = true
        assertCurrent()
        const recovery = action === 'build' && observation.options.find(option => option.section === section)?.recovery
        return JSON.stringify({ status: 'recorded', action, section, reason, worldChanged: false,
          ...(recovery && { recovery: true }),
          ...(action === 'build' && { next: recovery ? '请在工作台重新预检站位，由主人确认续建。' : '请在 Minecraft 工作台重新预检，由主人确认开工。' }) })
      } finally {
        busy = false
      }
    },
  })
}
