/**
 * Orpheus TTS v2 – WebSocket Proxy Server
 * ========================================
 *
 * Architecture:
 *   Browser ←WebSocket→ Node.js Proxy ←HTTP streaming→ Baseten TRT-LLM
 *
 * Design decisions:
 * - WebSocket-only client protocol (lowest latency, binary PCM frames)
 * - HTTPS Keep-Alive agent with connection pooling to Baseten
 * - Slot-based multiplexing: each concurrent generation gets a slot number
 * - AbortController per slot for clean cancellation
 * - No voice cloning, no reference audio (uses fine-tuned named voices)
 * - WAV header construction server-side for health/test endpoint only
 *
 * Binary frame layout (server → client):
 *   Bytes 0-1  uint16 LE  slot index
 *   Bytes 2+              raw 16-bit LE PCM at 24 kHz mono
 *
 * JSON messages:
 *   Client → Server:
 *     { type: "generate", slot, voice, prompt, max_tokens?, repetition_penalty?, temperature?, top_p? }
 *     { type: "abort", slot }
 *
 *   Server → Client:
 *     { type: "connected" }
 *     { type: "ttfb", slot, ms }
 *     { type: "done", slot, totalMs, audioDurationMs }
 *     { type: "error", slot, message }
 */

import 'dotenv/config'
import { createServer } from 'http'
import express from 'express'
import { WebSocketServer } from 'ws'
import { Agent, fetch as undiciFetch } from 'undici'

// ─── Connection Pool (undici Agent) ─────────────────────────────────────────────
// Maintains a persistent pool of TCP/TLS connections to Baseten.
// This eliminates the TLS handshake overhead on every request (~200ms saved).
// undici supports HTTP/1.1 keep-alive and HTTP/2 multiplexing transparently.
const connectionPool = new Agent({
  connections: 256,          // max parallel connections per origin (matches max model concurrency)
  pipelining: 1,             // keep-alive (no HTTP/2 pipelining on Baseten edge)
  keepAliveTimeout: 60_000,  // keep idle connections alive for 60s
  keepAliveMaxTimeout: 300_000,
  headersTimeout: 0,         // no headers timeout — model may take time to start streaming
  bodyTimeout: 0,            // no body timeout — long audio streams
})

// ─── Configuration ──────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '1mb' }))

const API_KEY = process.env.BASETEN_API_KEY
const MODEL_ID = process.env.BASETEN_MODEL_ID
const PORT = parseInt(process.env.PORT ?? '3001', 10)

if (!API_KEY || !MODEL_ID) {
  console.error('Missing required environment variables: BASETEN_API_KEY, BASETEN_MODEL_ID')
  process.exit(1)
}

const BASETEN_URL = `https://model-${MODEL_ID}.api.baseten.co/environments/production/predict`
const HEALTH_URL = `https://model-${MODEL_ID}.api.baseten.co/health`

const KNOWN_VOICES = new Set(['tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'])

// ─── Health Endpoint ────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', modelId: MODEL_ID })
})

// ─── Connection Warm-up ─────────────────────────────────────────────────────────
// Pre-establish a pool of TCP/TLS connections to Baseten at startup.
// For stress tests with N concurrent requests we need N pre-warmed connections —
// TLS handshake per new connection adds ~150-200ms to the first request on each.
// We fire WARMUP_POOL_SIZE pings concurrently so undici establishes that many
// physical connections before the first real request arrives.

const WARMUP_POOL_SIZE = 24   // cover most stress-test concurrency levels

async function warmupConnection() {
  try {
    const pings = Array.from({ length: WARMUP_POOL_SIZE }, (_, i) =>
      undiciFetch(HEALTH_URL, {
        method: 'GET',
        headers: { Authorization: `Api-Key ${API_KEY}` },
        dispatcher: connectionPool,
      })
        .then((r) => { console.log(`[warmup] conn ${i + 1}: HTTP ${r.status}`) })
        .catch((e) => console.warn(`[warmup] conn ${i + 1} failed: ${e.message}`)),
    )
    await Promise.all(pings)
    console.log(`[warmup] ${WARMUP_POOL_SIZE} connections pre-established in pool`)
  } catch (err) {
    console.warn(`[warmup] Warmup failed (model may be cold): ${err.message}`)
  }
}

// ─── HTTP Server + WebSocket ────────────────────────────────────────────────────

const httpServer = createServer(app)
const wss = new WebSocketServer({
  server: httpServer,
  path: '/api/ws',
  maxPayload: 1_048_576, // 1 MB — no voice cloning, payloads are lightweight JSON
})

wss.on('connection', (ws) => {
  /** @type {Map<number, AbortController>} One per in-flight slot */
  const active = new Map()

  /**
   * Per-slot buffer for trailing odd byte that can't form a complete Int16 sample.
   * Flushing an odd-length Buffer to the browser would cause
   * `new Int16Array(buf, 2)` to throw a RangeError.
   */
  const pendingOddByte = new Map()

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  }

  const sendAudio = (slot, pcmBuffer) => {
    if (ws.readyState !== ws.OPEN) return

    let toSend = pcmBuffer
    const pending = pendingOddByte.get(slot)
    if (pending) {
      toSend = Buffer.concat([pending, pcmBuffer])
      pendingOddByte.delete(slot)
    }

    if (toSend.length % 2 !== 0) {
      pendingOddByte.set(slot, toSend.slice(-1))
      toSend = toSend.slice(0, -1)
    }

    if (toSend.length === 0) return

    const slotBuf = Buffer.alloc(2)
    slotBuf.writeUInt16LE(slot, 0)
    ws.send(Buffer.concat([slotBuf, toSend]), { binary: true })
  }

  send({ type: 'connected' })

  ws.on('message', async (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }

    const { type, slot = 0 } = msg

    if (type === 'abort') {
      active.get(slot)?.abort()
      active.delete(slot)
      pendingOddByte.delete(slot)
      return
    }

    if (type !== 'generate') return

    const { voice, prompt, max_tokens, repetition_penalty, temperature, top_p } = msg

    if (!prompt || !voice) {
      send({ type: 'error', slot, message: 'Fields "prompt" and "voice" are required.' })
      return
    }

    // Abort any existing request on this slot
    active.get(slot)?.abort()
    const controller = new AbortController()
    active.set(slot, controller)
    pendingOddByte.delete(slot)

    // Validate voice — fall back to 'tara' for unknown voices
    const safeVoice = KNOWN_VOICES.has(voice) ? voice : 'tara'

    const payload = {
      voice: safeVoice,
      prompt,
      max_tokens: max_tokens ?? 2000,
      repetition_penalty: repetition_penalty ?? 1.1,
      ...(temperature != null ? { temperature } : {}),
      ...(top_p != null ? { top_p } : {}),
    }

    const startTime = Date.now()
    let ttfbSent = false
    let bytesReceived = 0
    let upstream = null

    console.log(`[ws] slot ${slot} → POST ${BASETEN_URL} voice=${safeVoice} prompt="${prompt.slice(0, 60)}"`)

    try {
      upstream = await undiciFetch(BASETEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Api-Key ${API_KEY}`,
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        dispatcher: connectionPool,
      })

      console.log(`[ws] slot ${slot} ← HTTP ${upstream.status} (${Date.now() - startTime}ms)`)

      if (!upstream.ok) {
        const text = await upstream.text()
        console.error(`[ws] slot ${slot} upstream error: ${upstream.status} ${text}`)
        send({ type: 'error', slot, message: `Upstream ${upstream.status}: ${text}` })
        active.delete(slot)
        return
      }

      let chunkCount = 0
      for await (const chunk of upstream.body) {
        if (controller.signal.aborted) break

        chunkCount++
        if (!ttfbSent) {
          const ttfb = Date.now() - startTime
          console.log(`[ws] slot ${slot} first chunk: ${chunk.length} bytes (TTFB ${ttfb}ms)`)
          send({ type: 'ttfb', slot, ms: ttfb })
          ttfbSent = true
        }

        bytesReceived += chunk.length
        sendAudio(slot, chunk)
      }
      console.log(`[ws] slot ${slot} stream ended: ${chunkCount} chunks, ${bytesReceived} bytes total`)

      if (!controller.signal.aborted) {
        pendingOddByte.delete(slot)
        const totalMs = Date.now() - startTime
        const audioDurationMs = Math.round((bytesReceived / (24000 * 2)) * 1000)
        send({ type: 'done', slot, totalMs, audioDurationMs })
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(`[ws] slot ${slot} error:`, err.message, err.cause ? `cause: ${err.cause.message || err.cause}` : '')
        send({ type: 'error', slot, message: String(err.message) })
      }
    } finally {
      // Destroy upstream body stream to prevent half-open TCP sockets
      if (upstream?.body && typeof upstream.body[Symbol.asyncIterator] === 'function') {
        try { await upstream.body.cancel?.() } catch {}
      }
      if (active.get(slot) === controller) {
        active.delete(slot)
      }
    }
  })

  ws.on('close', () => {
    active.forEach((c) => c.abort())
    active.clear()
    pendingOddByte.clear()
  })
})

// ─── Start Server ───────────────────────────────────────────────────────────────

httpServer.listen(PORT, async () => {
  console.log(`[server] Proxy running on http://localhost:${PORT}`)
  console.log(`[server] WebSocket endpoint: ws://localhost:${PORT}/api/ws`)
  console.log(`[server] Model ID: ${MODEL_ID}`)
  await warmupConnection()
})
