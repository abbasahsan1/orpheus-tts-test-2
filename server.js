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
import https from 'https'
import express from 'express'
import { WebSocketServer } from 'ws'

// ─── HTTPS Agent with Connection Pooling ────────────────────────────────────────
// Reuses TCP/TLS connections across all upstream Baseten requests.
// Critical for low TTFB under high concurrency – avoids repeated TLS handshakes.
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: Infinity,
  maxFreeSockets: 64,
  timeout: 120_000,
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
// Pre-establish TCP/TLS connection to Baseten at startup to avoid cold-start
// latency on the first real request.

async function warmupConnection() {
  try {
    const resp = await fetch(HEALTH_URL, {
      method: 'GET',
      headers: { Authorization: `Api-Key ${API_KEY}` },
    })
    console.log(`[warmup] Baseten health check: ${resp.status}`)
  } catch (err) {
    console.warn(`[warmup] Baseten health check failed (model may be cold): ${err.message}`)
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
      upstream = await fetch(BASETEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Api-Key ${API_KEY}`,
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
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
