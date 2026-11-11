import { useEffect, useState } from 'react'
import type { ToolPolicyView, WorkbenchView } from '../protocol/api.ts'
import { getToolPolicy } from './api.ts'

export function ToolPolicyPanel({ bindings, notify }: { bindings: WorkbenchView['bindings']; notify: (error: unknown) => void }) {
  const [contextId, setContextId] = useState(bindings[0]?.contextId ?? '')
  const [policy, setPolicy] = useState<ToolPolicyView>()
  useEffect(() => { if (contextId) void getToolPolicy(contextId).then(setPolicy).catch(notify) }, [contextId])
  return <section className="cp-card">
    <div className="cp-row cp-between"><h2>场景工具索引</h2><span className="cp-label">由宿主在 Session 创建与恢复时应用</span></div>
    <select className="cp-select" value={contextId} onChange={event => setContextId(event.target.value)}>{bindings.map(binding => <option key={binding.contextId} value={binding.contextId}>{binding.label}（{binding.contextId}）</option>)}</select>
    {policy && <><p className="cp-hint">策略：{policy.profile}。此场景可见 {policy.allowed.length} 个 Companion 工具，未注入 {policy.denied.length} 个；DSH 其他工具仍由宿主配置决定。</p><div className="cp-table-wrap"><table className="cp-table"><thead><tr><th>工具</th><th>用途</th><th>权限</th></tr></thead><tbody>{policy.allowed.map(tool => <tr key={tool.name}><td className="cp-code">{tool.name}</td><td>{tool.summary}</td><td className="cp-code">{tool.permission}</td></tr>)}</tbody></table></div></>}
  </section>
}
