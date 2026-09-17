// server.mjs
// Relays the VIP transfer form (rewards.html) to Discord, so the webhook URL
// stays on the server. Nginx serves the static site and proxies /api/* here;
// this process only listens on localhost.
//
// Setup on the VPS (once):
//   1. cp .env.example .env   and put the real DISCORD_WEBHOOK_URL in .env
//   2. pm2 start server.mjs --name big-juan-api && pm2 save
//   3. In the site's nginx server block:
//        location /api/ {
//          proxy_pass http://127.0.0.1:3002;
//          proxy_set_header X-Real-IP $remote_addr;
//        }
//      then: nginx -t && systemctl reload nginx
//
// The webhook URL must never be committed: the repo is public.
import http from 'node:http'

// Load .env from the working directory (Node >= 20.12). Harmless if the
// variables are provided another way.
try { process.loadEnvFile() } catch { /* env provided another way */ }

const PORT = Number(process.env.PORT || 3002)
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL
const MAX_BODY = 16 * 1024

// Per-field length caps, and which fields must be filled in.
const FIELDS = {
  site:    { label: 'Current rewards website',     max: 100,  required: true },
  wager:   { label: 'Monthly wager average',        max: 40,   required: true },
  help:    { label: 'Needs help setting up on Stake', max: 3,  required: true },
  current: { label: 'Current rewards / rakeback',   max: 1000, required: false },
  desired: { label: 'Desired rewards',              max: 1000, required: false },
  discord: { label: 'Discord username',             max: 40,   required: true },
}

// At most 3 submissions per IP per 10 minutes.
const WINDOW_MS = 10 * 60 * 1000
const MAX_PER_WINDOW = 3
const hits = new Map()
function rateLimited(ip) {
  const now = Date.now()
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= MAX_PER_WINDOW) return true
  recent.push(now)
  hits.set(ip, recent)
  return false
}
setInterval(() => {
  const now = Date.now()
  for (const [ip, times] of hits) if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(ip)
}, WINDOW_MS).unref()

// Resolves to the body text, or null if it's over MAX_BODY. An oversized body
// is drained rather than cut off, so the client still gets a proper 413.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size <= MAX_BODY) chunks.push(c)
    })
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Break up @everyone / @here / <@id> so a submission can never ping anyone,
// even if allowed_mentions were ignored.
const defang = (s) => s.replace(/@/g, '@\u200b')

function validate(input) {
  if (typeof input !== 'object' || input === null) return { error: 'Invalid request.' }
  if (input.website) return { spam: true }   // honeypot field, hidden from people
  const out = {}
  for (const [key, spec] of Object.entries(FIELDS)) {
    const raw = typeof input[key] === 'string' ? input[key].trim() : ''
    if (spec.required && !raw) return { error: `${spec.label} is required.` }
    if (key === 'help') {
      if (raw !== 'yes' && raw !== 'no') return { error: 'Choose yes or no for setup help.' }
    } else if (raw.length > spec.max) {
      return { error: `${spec.label} must be ${spec.max} characters or fewer.` }
    }
    out[key] = raw
  }
  if (!/^[a-zA-Z0-9_.]{2,32}$/.test(out.discord)) {
    return { error: 'Enter a valid Discord username (2–32 letters, numbers, dots or underscores).' }
  }
  return { data: out }
}

function discordPayload(d) {
  const field = (key, inline = false) => ({
    name: FIELDS[key].label,
    value: d[key] ? defang(d[key]).slice(0, 1024) : '—',
    inline,
  })
  return {
    username: 'BigJuan VIP Transfer',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: 'New VIP transfer request',
      color: 0xd4a843,
      fields: [
        field('discord', true),
        field('site', true),
        field('wager', true),
        { name: FIELDS.help.label, value: d.help === 'yes' ? 'Yes' : 'No', inline: true },
        field('current'),
        field('desired'),
      ],
      footer: { text: 'bigjuan rewards page' },
      timestamp: new Date().toISOString(),
    }],
  }
}

const server = http.createServer(async (req, res) => {
  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const { pathname } = new URL(req.url, 'http://localhost')

  if (pathname === '/api/health') return json(200, { ok: true, webhook: Boolean(WEBHOOK) })
  if (pathname !== '/api/vip-transfer') return json(404, { error: 'Not found' })
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return json(405, { error: 'Method not allowed' })
  }
  if (!WEBHOOK) return json(500, { error: "The form isn't available right now." })

  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown'
  if (rateLimited(ip)) return json(429, { error: 'Too many requests. Please try again in a few minutes.' })

  let input
  try {
    const body = await readBody(req)
    if (body === null) return json(413, { error: 'Request too large.' })
    input = JSON.parse(body)
  } catch {
    return json(400, { error: 'Invalid request.' })
  }

  const result = validate(input)
  if (result.spam) return json(200, { ok: true })   // look successful to bots
  if (result.error) return json(400, { error: result.error })

  try {
    const upstream = await fetch(`${WEBHOOK}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordPayload(result.data)),
      signal: AbortSignal.timeout(10_000),
    })
    if (!upstream.ok) {
      console.error('Discord webhook failed:', upstream.status, (await upstream.text()).slice(0, 300))
      return json(502, { error: "We couldn't send your request. Please try again in a moment." })
    }
    return json(200, { ok: true })
  } catch (err) {
    console.error('Discord webhook error:', err.message)
    return json(502, { error: "We couldn't send your request. Please try again in a moment." })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`big-juan API listening on http://127.0.0.1:${PORT}${WEBHOOK ? '' : ' (DISCORD_WEBHOOK_URL not set)'}`)
})
