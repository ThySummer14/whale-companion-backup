import type { DatabaseSync } from 'node:sqlite'
import type { ActivityInput, GameLesson, GameLessonTarget, GameLessonStatus, MemorySourceRef } from './model.ts'

interface FailureInput {
  action: string
  errorCode: string
  target?: GameLessonTarget
  sourceRefs?: MemorySourceRef[]
}

interface LessonRow {
  signature: string
  action: string
  error_code: string
  target_key: string
  target_json: string | null
  lesson: string
  status: GameLessonStatus
  occurrences: number
  source_refs_json: string
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
}

export function gameTargetKey(target: GameLessonTarget | undefined): string {
  return target ? `${target.block ?? 'block'}:${target.x},${target.y},${target.z}` : 'world'
}

function lessonFor(action: string, errorCode: string): string {
  if (action === 'dig' && ['dig-failed', 'dig-timeout', 'dig-unconfirmed'].includes(errorCode)) return '这个坐标的原木曾接近失败；下次优先其他有自然树叶证据的低处目标，不反复撞同一路径。'
  if (errorCode === 'dig-pickup-unconfirmed') return '方块消失不等于采集完成；先收同种掉落物并核对背包，再开始新动作。'
  if (errorCode === 'safe-natural-log-not-found') return '目标超出范围或证据不足时不挖；先合法靠近并重新扫描，不扩大采集半径。'
  if (['move-timeout', 'move-ended-without-arrival', 'move-unconfirmed'].includes(errorCode)) return '这个目标曾无法到达；先重读地形并选择中间安全点，不直接重复同一路径。'
  if (errorCode === 'stop-unconfirmed') return '停止请求后仍有位移；先脱离威胁并确认寻路和反射都停止，再报告停止结果。'
  if (errorCode === 'owner-not-visible') return '主人不在线或不可见时不私聊、不跟随；等主人上线后重新观察。'
  if (errorCode === 'minecraft-offline') return '假人离线时不继续世界动作；先恢复连接并重新应用安全配置。'
  if (action === 'return' && ['return-no-safe-route', 'return-no-materials', 'return-column-blocked', 'return-exit-changed'].includes(errorCode)) return '回程先核对完整立柱空间、相邻安全出口和廉价方块；条件不满足时不挖头顶、不动保留原木。'
  if (action === 'return' && ['return-placement-unconfirmed', 'return-inventory-unconfirmed', 'return-dismount-failed', 'return-dismount-timeout'].includes(errorCode)) return '放置或下台未被真实回读确认时不记成功；停止后续动作并重新观察，不继续盲目垫高。'
  if (errorCode === 'return-threat') return '回程遇到战斗威胁会中断；先由本地生存反射处理威胁，再重新评估出口。'
  if (action === 'survey' && ['survey-terrain-changed', 'survey-off-course', 'survey-unsafe-player', 'survey-timeout'].includes(errorCode)) {
    return '往返勘察中断后先确认当前站位、血量和路线。下一次勘察需要重新授权，并从营地中心重新预检。'
  }
  if (action === 'survey' && ['survey-return-unconfirmed', 'survey-receipt-unconfirmed'].includes(errorCode)) {
    return '到达远端后仍要回读营地中心和维度。缺少同一次往返的完整回执时，先核对位置再报告结果。'
  }
  if (errorCode === 'craft-missing-materials') return '合成前先按真实配方核对材料；材料不足不开始扣减，先补料或改选可行配方。'
  if (errorCode === 'craft-table-required') return '镐和盾牌需要三格内可交互的已有工作台；先靠近工作台，不直接假设可以远程合成。'
  if (errorCode === 'craft-inventory-unconfirmed') return '合成产物未通过背包回读时不记成功；事务应恢复原材料，先核对背包再继续。'
  if (errorCode === 'craft-threat') return '战斗威胁中不开始新的合成；先由本地反射处理威胁，再检查材料和周围工作台。'
  if (['build-zone-not-found', 'build-zone-violation'].includes(errorCode)) return '建造只能使用主人当前有效的授权区；区域撤销或越界时停止，不自行扩大范围。'
  if (['build-no-site', 'build-obstructed', 'build-out-of-reach'].includes(errorCode)) return '营地位置必须完整、可达且目标是空气；先换到授权区内其他位置，不覆盖已有方块或强行塞入实体。'
  if (errorCode === 'build-materials') return '营地需要 8 块同种地板和 1 个已有工作台；材料不足时先补给，不开始放置。'
  if (['build-placement-unconfirmed', 'build-inventory-unconfirmed', 'build-world-unconfirmed'].includes(errorCode)) return '建造必须同时通过逐块世界回读和背包扣减；回读不一致不记成功，先停止并重新观察。'
  if (errorCode === 'prepare-materials') return '营地目标按真实背包计算缺口；原木不足时先继续合法采集，不能消耗两根保留原木或跳过配方直接建造。'
  if (errorCode === 'prepare-timeout') return '营地目标有采集、配方和总时限预算；超时后先停止并重新评估位置与资源，不无界重试。'
  if (errorCode === 'prepare-unsupported-material') return '营地目标准备链只使用已知树种的原木与对应木板，不能拿不支持的方块冒充。'
  return `${action} 曾出现 ${errorCode}；先重新观察并调整方案，不盲目重复。`
}

export class GameLearningRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly recordActivity: (input: ActivityInput) => number,
    private readonly transaction: <T>(operation: () => T) => T,
  ) {}

  recordFailure(input: FailureInput): GameLesson {
    const action = input.action.trim().toLowerCase()
    const errorCode = input.errorCode.trim().toLowerCase().slice(0, 120) || 'unknown'
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(action)) throw new Error('Invalid game learning action')
    const targetKey = gameTargetKey(input.target)
    const signature = `${action}:${errorCode}:${targetKey}`
    const now = new Date().toISOString()
    return this.transaction(() => {
      const current = this.get(signature)
      if (current && Date.now() - Date.parse(current.lastSeenAt) < 2000) return current
      const lesson: GameLesson = {
        signature,
        action,
        errorCode,
        targetKey,
        target: input.target,
        lesson: lessonFor(action, errorCode),
        status: 'learning',
        occurrences: (current?.occurrences ?? 0) + 1,
        sourceRefs: (input.sourceRefs ?? current?.sourceRefs ?? []).slice(-20),
        firstSeenAt: current?.firstSeenAt ?? now,
        lastSeenAt: now,
      }
      this.db.prepare(`INSERT INTO game_lesson
        (signature,action,error_code,target_key,target_json,lesson,status,occurrences,source_refs_json,first_seen_at,last_seen_at,resolved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(signature) DO UPDATE SET lesson=excluded.lesson,status='learning',occurrences=excluded.occurrences,source_refs_json=excluded.source_refs_json,last_seen_at=excluded.last_seen_at,resolved_at=NULL`)
        .run(signature, action, errorCode, targetKey, input.target ? JSON.stringify(input.target) : null, lesson.lesson, lesson.status, lesson.occurrences, JSON.stringify(lesson.sourceRefs), lesson.firstSeenAt, now)
      this.recordActivity({
        contextId: 'game.minecraft', source: 'game.learning', kind: 'game.lesson.updated',
        summary: lesson.lesson, status: 'warning',
        data: { signature, occurrences: lesson.occurrences, targetKey },
      })
      return this.get(signature)!
    })
  }

  recordSuccess(input: { action: string; target?: GameLessonTarget; sourceRefs?: MemorySourceRef[] }): void {
    const action = input.action.trim().toLowerCase()
    const targetKey = gameTargetKey(input.target)
    const now = new Date().toISOString()
    this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM game_lesson WHERE action=? AND target_key=? AND status=?').get(action, targetKey, 'learning') as LessonRow | undefined
      if (!current) return
      this.db.prepare('UPDATE game_lesson SET status=?,resolved_at=?,last_seen_at=?,source_refs_json=? WHERE signature=?')
        .run('resolved', now, now, JSON.stringify((input.sourceRefs ?? []).slice(-20)), current.signature)
      this.recordActivity({
        contextId: 'game.minecraft', source: 'game.learning', kind: 'game.lesson.resolved',
        summary: '后续真实动作已验证这条经验可以跨过。', status: 'success', data: { signature: current.signature },
      })
    })
  }

  avoidTargets(action: string): GameLessonTarget[] {
    return this.list({ status: 'learning', limit: 64 }).filter(lesson => lesson.action === action && ['dig-failed', 'dig-timeout', 'dig-unconfirmed'].includes(lesson.errorCode) && lesson.target).map(lesson => lesson.target!)
  }

  list(options: { status?: GameLessonStatus | 'all'; limit?: number } = {}): GameLesson[] {
    const status = options.status ?? 'all'
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)))
    const rows = status === 'all'
      ? this.db.prepare(`SELECT * FROM game_lesson ORDER BY CASE status WHEN 'learning' THEN 0 ELSE 1 END,last_seen_at DESC LIMIT ?`).all(limit)
      : this.db.prepare('SELECT * FROM game_lesson WHERE status=? ORDER BY last_seen_at DESC LIMIT ?').all(status, limit)
    return rows.map(row => this.fromRow(row))
  }

  forPrompt(action?: string, limit = 3): string[] {
    return this.list({ limit: 50 }).filter(lesson => !action || lesson.action === action).slice(0, Math.max(1, Math.min(6, limit))).map(lesson => `${lesson.lesson}（${lesson.action}/${lesson.errorCode}，出现 ${lesson.occurrences} 次，${lesson.status === 'resolved' ? '已验证' : '学习中'}）`)
  }

  private get(signature: string): GameLesson | undefined {
    const row = this.db.prepare('SELECT * FROM game_lesson WHERE signature=?').get(signature)
    return row ? this.fromRow(row) : undefined
  }

  private fromRow(row: unknown): GameLesson {
    const value = row as LessonRow
    return {
      signature: value.signature,
      action: value.action,
      errorCode: value.error_code,
      targetKey: value.target_key,
      target: value.target_json ? JSON.parse(value.target_json) as GameLessonTarget : undefined,
      lesson: value.lesson,
      status: value.status,
      occurrences: Number(value.occurrences),
      sourceRefs: JSON.parse(value.source_refs_json) as MemorySourceRef[],
      firstSeenAt: value.first_seen_at,
      lastSeenAt: value.last_seen_at,
      resolvedAt: value.resolved_at ?? undefined,
    }
  }
}
