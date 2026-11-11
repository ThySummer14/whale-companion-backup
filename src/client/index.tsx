import { useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CompanionApp } from './app.tsx'

const NS = 'dshCompanion'
const PANEL_ID = 'companion' as MainPanelId
const zh = { panel: 'Companion' }
const en = { panel: 'Companion' }

type ClientContext = Context & { sessions: ISessions }

function CompanionIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 10.5c0-3.6 3.6-6 8-6s8 2.4 8 6-3.6 6-8 6c-1.2 0-2.4-.2-3.4-.6L5 17l.7-2.7C4.7 13.4 4 12.1 4 10.5Z" />
    <path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01" strokeWidth={2.5} />
  </svg>
}

function Mounted({ ctx }: { ctx: ClientContext }) {
  const pending = useRef<AbortController | undefined>(undefined)
  const openSession = async (value: string) => {
    pending.current?.abort()
    const request = new AbortController()
    pending.current = request
    const id = value as SessionId
    let snapshot = ctx.sessions.list.getSnapshot()
    if (snapshot.phase !== 'ready' || !snapshot.byId[id]) await ctx.sessions.refresh()
    if (request.signal.aborted) return
    snapshot = ctx.sessions.list.getSnapshot()
    if (snapshot.phase !== 'ready') throw new Error('DSH 会话目录尚未就绪')
    if (!snapshot.byId[id]) throw new Error('绑定会话不在当前 DSH 会话目录中')
    ctx.uiWorkspace.openSession(id)
  }
  return <CompanionApp openSession={openSession} />
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-companion-bot: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) }, () => <Mounted ctx={ctx} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, CompanionIcon))
}
