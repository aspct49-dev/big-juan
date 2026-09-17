// Regenerates slots.json (the catalog behind slots.html) from Stake's public
// GraphQL API. No login needed.
//
//   node scripts/update-slots.mjs               # full refresh, ~3 minutes
//   node scripts/update-slots.mjs --max 200 --out test.json
//
// Notes from building this:
// - Requests go through curl, not fetch: Cloudflare rejects Node's TLS
//   fingerprint with a 403 but lets curl through.
// - The API caps page size at 50.
// - `game.provider.name` is an internal key, not a display name, and some keys
//   are aggregators ("hub88" spans many studios; "hacksaw" includes Bullshark
//   and Backseat). The real studio is the game's group with type "provider",
//   so that's what we read. A handful of games have no provider group; those
//   fall back to a title-cased key.
// - Games in the "Only on Stake" group get a trailing 1 in their row, which
//   drives the picker's Only on Stake filter.
// - What Stake returns can vary by region; this reflects wherever it's run.
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const MAX = Number(opt('--max', Infinity))
const OUT = opt('--out', fileURLToPath(new URL('../slots.json', import.meta.url)))
const PAGE = 50
const IMGIX = 'https://mediumrare.imgix.net/'

const QUERY = `query ($limit: Int!, $offset: Int!) {
  slugKuratorGroup(slug: "slots") {
    gameCount
    groupGamesList(limit: $limit, offset: $offset) {
      game { id name slug thumbnailUrl provider { name } groupGames { group { name slug type } } }
    }
  }
}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchPage(offset) {
  for (let attempt = 1; ; attempt++) {
    let body, status = 0
    try {
      const out = execFileSync('curl', ['-s', '--max-time', '40', '-w', '\n%{http_code}',
        '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        '-H', 'content-type: application/json', '-H', 'x-language: en',
        '-X', 'POST', 'https://stake.com/_api/graphql', '--data-binary', '@-'],
        { input: JSON.stringify({ query: QUERY, variables: { limit: PAGE, offset } }), maxBuffer: 1 << 26 }).toString()
      const i = out.lastIndexOf('\n')
      status = Number(out.slice(i + 1))
      body = JSON.parse(out.slice(0, i))
    } catch {}
    const group = body?.data?.slugKuratorGroup
    if (status === 200 && group) return group
    if (attempt >= 4) {
      throw new Error(`offset ${offset}: HTTP ${status} ${JSON.stringify(body?.errors ?? '').slice(0, 300)}`)
    }
    await sleep(2000 * attempt)
  }
}

const titleCase = (key) => key.split('-')
  .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
  .join(' ')

const byId = new Map()
let total = Infinity
for (let offset = 0; offset < Math.min(total, MAX); offset += PAGE) {
  const group = await fetchPage(offset)
  total = group.gameCount
  for (const { game } of group.groupGamesList) {
    if (!byId.has(game.id)) byId.set(game.id, game)
  }
  if (offset % 1000 === 0) console.log(`${offset} / ${total}`)
  await sleep(250)
}

const rows = [...byId.values()].slice(0, MAX).map((g) => {
  const key = g.provider?.name || ''
  const studio = g.groupGames?.find((x) => x.group.type === 'provider')?.group.name
  const thumb = g.thumbnailUrl || ''
  return {
    name: g.name.trim(),
    slug: g.slug,
    img: thumb.startsWith(IMGIX) ? thumb.slice(IMGIX.length) : thumb,
    provider: studio || (key ? titleCase(key) : 'Other'),
    exclusive: g.groupGames?.some((x) => x.group.slug === 'only-on-stake'),
  }
})

// Providers are ordered by game count, so the page's default chips are the
// biggest studios.
const counts = new Map()
for (const r of rows) counts.set(r.provider, (counts.get(r.provider) || 0) + 1)
const providers = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b))
const index = new Map(providers.map((p, i) => [p, i]))

writeFileSync(OUT, JSON.stringify({
  updated: new Date().toISOString().slice(0, 10),
  providers,
  games: rows.map((r) => {
    const row = [r.name, r.slug, r.img, index.get(r.provider)]
    if (r.exclusive) row.push(1)
    return row
  }),
}))
console.log(`Wrote ${rows.length} slots (${rows.filter((r) => r.exclusive).length} only on Stake) from ${providers.length} providers to ${OUT} (Stake lists ${total})`)
