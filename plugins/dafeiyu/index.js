// Dafeiyu cover source: lists the Companion singing archive through the
// read-only host.companion bridge; audio stays behind device authentication.
const artist = { id: 'dafeiyu', name: '大肥鱼' }
const album = { id: 'covers', name: '大肥鱼的歌', artists: [artist], released: '2026-11-14' }

async function tracks() {
  const archive = await host.companion('singing')
  return (archive.items ?? []).map(item => ({
    id: item.id,
    name: item.title,
    artists: [artist],
    album,
    duration: Math.round((item.durationSeconds ?? 0) * 1000),
  }))
}

export async function home() {
  return { title: '大肥鱼翻唱', sections: [{ title: '她唱完的歌', tracks: await tracks() }] }
}

export async function search({ query, kind, offset }) {
  if (kind !== 'tracks') return { [kind]: [], more: false }
  const q = (query ?? '').toLowerCase()
  const found = (await tracks()).filter(track => track.name.toLowerCase().includes(q))
  return { tracks: offset > 0 ? [] : found, more: false }
}

export async function stream({ id }) {
  const found = (await tracks()).some(track => track.id === id)
  if (!found) { const e = new Error('no such cover'); e.code = 'unavailable'; throw e }
  return { url: `companion://singing/${id}`, type: 'wav' }
}