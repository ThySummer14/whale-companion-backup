import { useEffect, useState, type FormEvent } from 'react'
import { createDeviceOffer, getDevices, revokeDevice, type DeviceView } from './device-api.ts'

export function DevicesPage({ reload, notify }: { reload: () => Promise<void>; notify: (error: unknown) => void }) {
  const [items, setItems] = useState<DeviceView[]>([])
  const [name, setName] = useState('我的手机')
  const [hostName, setHostName] = useState('Mac mini Companion')
  const [routes, setRoutes] = useState('')
  const [offer, setOffer] = useState<{ link: string; expiresAt: string }>()
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const value = await getDevices()
    setItems(value.items)
  }
  useEffect(() => { void load().catch(notify) }, [])
  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      const value = await createDeviceOffer({ name, hostName, routes: routes.split('\n').map(route => route.trim()).filter(Boolean) })
      setOffer(value)
    } catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  const revoke = async (id: string) => {
    setBusy(true)
    try { await revokeDevice(id); await Promise.all([load(), reload()]) }
    catch (error) { notify(error) }
    finally { setBusy(false) }
  }
  return <>
    <form className="cp-card" onSubmit={event => void create(event)}>
      <h2>配对新设备</h2>
      <div className="cp-grid">
        <div className="cp-field"><label className="cp-label" htmlFor="cp-device-name">设备名称</label><input id="cp-device-name" className="cp-input" required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></div>
        <div className="cp-field"><label className="cp-label" htmlFor="cp-host-name">Host 显示名称</label><input id="cp-host-name" className="cp-input" maxLength={80} value={hostName} onChange={event => setHostName(event.target.value)} /></div>
      </div>
      <div className="cp-field"><label className="cp-label" htmlFor="cp-device-routes">候选地址（每行一个，可留空使用本机地址）</label><textarea id="cp-device-routes" className="cp-textarea" style={{ minHeight: 80 }} placeholder="https://your-mac-mini.tailnet-name.ts.net" value={routes} onChange={event => setRoutes(event.target.value)} /></div>
      <div className="cp-actions"><button className="cp-button" data-primary type="submit" disabled={busy || !name.trim()}>生成一次性配对链接</button></div>
      <p className="cp-hint cp-small">配对码 5 分钟内有效，只能使用一次。Tailscale 地址必须使用 HTTPS；本机开发地址仅用于模拟器或本机调试。</p>
    </form>
    {offer && <section className="cp-card"><h2>配对链接已生成</h2><p className="cp-hint">在手机 Companion App 中粘贴此链接。链接包含一次性凭据，不要公开发送或写入日志。</p><textarea className="cp-textarea" readOnly value={offer.link} onFocus={event => event.currentTarget.select()} /><div className="cp-label">过期时间：{new Date(offer.expiresAt).toLocaleString('zh-CN', { hour12: false })}</div></section>}
    <section className="cp-card"><div className="cp-row cp-between"><h2>已配对设备</h2><span className="cp-label">{items.length} 台</span></div>
      {items.length ? items.map(device => <div className="cp-session" key={device.id}>
        <div className="cp-row cp-between"><div><strong>{device.name}</strong><div className="cp-code">{device.id}</div><div className="cp-label">最近活动：{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString('zh-CN', { hour12: false }) : '尚未活动'}</div></div><span className="cp-status" data-state={device.revokedAt ? 'forgotten' : 'active'}>{device.revokedAt ? '已撤销' : '已配对'}</span></div>
        {!device.revokedAt && <div className="cp-actions"><button className="cp-button" disabled={busy} onClick={() => void revoke(device.id)}>立即撤销</button></div>}
      </div>) : <div className="cp-empty">还没有已配对设备。</div>}
    </section>
  </>
}
