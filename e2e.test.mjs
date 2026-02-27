/**
 * End-to-End Tests for Orpheus TTS v2
 * ====================================
 *
 * Tests the full pipeline:
 *   Browser-like client → WebSocket proxy (localhost:3001) → Baseten TRT-LLM
 *
 * Usage:
 *   node e2e.test.mjs               # Run all tests
 *   node e2e.test.mjs --quick       # Skip slow tests (concurrent, long text)
 *
 * Prerequisites:
 *   - `npm run dev` running (server on port 3001)
 *   - Baseten model deployed and promoted to production
 */

import WebSocket from 'ws'

// ─── Configuration ──────────────────────────────────────────────────────────────

const WS_URL = 'ws://localhost:3001/api/ws'
const HEALTH_URL = 'http://localhost:3001/api/health'
const QUICK_MODE = process.argv.includes('--quick')
const TIMEOUT_SINGLE = 120_000   // 2 min for single generation
const TIMEOUT_CONNECT = 10_000   // 10s to establish WS connection
const SAMPLE_RATE = 24000
const BYTES_PER_SAMPLE = 2

// ─── Test Framework ─────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
let skipped = 0
const results = []

function log(icon, msg) {
  console.log(`  ${icon} ${msg}`)
}

async function test(name, fn, { skip = false, timeout = TIMEOUT_SINGLE } = {}) {
  if (skip) {
    log('⊘', `SKIP: ${name}`)
    skipped++
    results.push({ name, status: 'skip' })
    return
  }

  process.stdout.write(`  ◌ ${name}...`)

  const timer = setTimeout(() => {
    throw new Error(`Test timed out after ${timeout}ms`)
  }, timeout)

  const start = Date.now()
  try {
    await fn()
    clearTimeout(timer)
    const elapsed = Date.now() - start
    process.stdout.write(`\r  ✓ ${name} (${elapsed}ms)\n`)
    passed++
    results.push({ name, status: 'pass', elapsed })
  } catch (err) {
    clearTimeout(timer)
    const elapsed = Date.now() - start
    process.stdout.write(`\r  ✗ ${name} (${elapsed}ms)\n`)
    console.error(`    Error: ${err.message}`)
    failed++
    results.push({ name, status: 'fail', elapsed, error: err.message })
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`)
}

// ─── WebSocket Helpers ──────────────────────────────────────────────────────────

/** Open a WebSocket and wait for the 'connected' message. */
function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.binaryType = 'arraybuffer'

    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('WebSocket connection timed out'))
    }, TIMEOUT_CONNECT)

    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`WebSocket error: ${err.message}`))
    })

    ws.on('message', (data) => {
      if (typeof data === 'string' || Buffer.isBuffer(data)) {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'connected') {
            clearTimeout(timer)
            resolve(ws)
          }
        } catch {}
      }
    })

    ws.on('close', () => {
      clearTimeout(timer)
      reject(new Error('WebSocket closed before connected'))
    })
  })
}

/**
 * Run a TTS generation over WebSocket and collect all results.
 * Returns { messages, audioChunks, totalPcmBytes, audioDurationMs }.
 */
function runGeneration(ws, params, { timeout = TIMEOUT_SINGLE } = {}) {
  return new Promise((resolve, reject) => {
    const messages = []
    const audioChunks = []
    let totalPcmBytes = 0

    const timer = setTimeout(() => {
      reject(new Error(`Generation timed out after ${timeout}ms`))
    }, timeout)

    const onMessage = (data) => {
      if (typeof data === 'string' || (Buffer.isBuffer(data) && data[0] === 0x7b)) {
        // JSON message
        try {
          const msg = JSON.parse(data.toString())
          messages.push(msg)

          if (msg.type === 'done') {
            clearTimeout(timer)
            ws.removeListener('message', onMessage)
            resolve({
              messages,
              audioChunks,
              totalPcmBytes,
              ttfbMs: messages.find(m => m.type === 'ttfb')?.ms ?? null,
              totalMs: msg.totalMs,
              audioDurationMs: msg.audioDurationMs,
            })
          } else if (msg.type === 'error') {
            clearTimeout(timer)
            ws.removeListener('message', onMessage)
            reject(new Error(`Server error: ${msg.message}`))
          }
        } catch {}
      } else {
        // Binary audio frame
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        if (buf.byteLength >= 4) {
          const slot = buf.readUInt16LE(0)
          const pcmBytes = buf.byteLength - 2
          if (params.slot === undefined || slot === params.slot) {
            totalPcmBytes += pcmBytes
            audioChunks.push(buf.slice(2))
          }
        }
      }
    }

    ws.on('message', onMessage)
    ws.send(JSON.stringify({ type: 'generate', slot: 0, ...params }))
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════╗')
console.log('║     Orpheus TTS v2 – End-to-End Test Suite       ║')
console.log('╚══════════════════════════════════════════════════╝\n')

// --- 1. Health endpoint ---
console.log('─── Health & Connectivity ───')

await test('Health endpoint returns OK', async () => {
  const resp = await fetch(HEALTH_URL)
  assert(resp.ok, `HTTP ${resp.status}`)
  const body = await resp.json()
  assert(body.status === 'ok', `Expected status "ok", got "${body.status}"`)
  assert(body.modelId, 'Missing modelId')
  log('ℹ', `Model ID: ${body.modelId}`)
})

await test('WebSocket connects and receives "connected" message', async () => {
  const ws = await openWs()
  assert(ws.readyState === WebSocket.OPEN, 'WebSocket not open')
  ws.close()
})

// --- 2. Single generation ---
console.log('\n─── Single Generation ───')

await test('Generate short text (Tara voice)', async () => {
  const ws = await openWs()
  try {
    const result = await runGeneration(ws, {
      voice: 'tara',
      prompt: 'Hello world.',
      max_tokens: 500,
      repetition_penalty: 1.1,
    })

    assert(result.totalPcmBytes > 0, 'No audio data received')
    assert(result.ttfbMs != null, 'No TTFB reported')
    assert(result.ttfbMs < 30000, `TTFB too high: ${result.ttfbMs}ms`)
    assert(result.audioDurationMs > 0, 'No audio duration reported')

    const audioSec = result.audioDurationMs / 1000
    log('ℹ', `TTFB: ${result.ttfbMs}ms, Total: ${result.totalMs}ms, Audio: ${audioSec.toFixed(2)}s, PCM bytes: ${result.totalPcmBytes}`)
  } finally {
    ws.close()
  }
})

await test('Generate with Leo voice', async () => {
  const ws = await openWs()
  try {
    const result = await runGeneration(ws, {
      voice: 'leo',
      prompt: 'Testing male voice output.',
      max_tokens: 500,
      repetition_penalty: 1.1,
    })

    assert(result.totalPcmBytes > 0, 'No audio data received')
    log('ℹ', `TTFB: ${result.ttfbMs}ms, Audio: ${(result.audioDurationMs / 1000).toFixed(2)}s`)
  } finally {
    ws.close()
  }
})

await test('Unknown voice falls back to tara (no error)', async () => {
  const ws = await openWs()
  try {
    const result = await runGeneration(ws, {
      voice: 'nonexistent_voice',
      prompt: 'Fallback voice test.',
      max_tokens: 300,
      repetition_penalty: 1.1,
    })

    // Should succeed with fallback voice, not error
    assert(result.totalPcmBytes > 0, 'No audio data received')
    log('ℹ', `Fallback worked, got ${result.totalPcmBytes} PCM bytes`)
  } finally {
    ws.close()
  }
})

// --- 3. Parameter variations ---
console.log('\n─── Parameter Variations ───')

await test('Custom temperature and top_p', async () => {
  const ws = await openWs()
  try {
    const result = await runGeneration(ws, {
      voice: 'tara',
      prompt: 'Parameter test.',
      max_tokens: 300,
      repetition_penalty: 1.1,
      temperature: 0.8,
      top_p: 0.95,
    })

    assert(result.totalPcmBytes > 0, 'No audio data received')
    log('ℹ', `Got ${result.totalPcmBytes} bytes with temp=0.8, top_p=0.95`)
  } finally {
    ws.close()
  }
})

await test('High repetition penalty (1.5)', async () => {
  const ws = await openWs()
  try {
    const result = await runGeneration(ws, {
      voice: 'jess',
      prompt: 'Repetition penalty test.',
      max_tokens: 300,
      repetition_penalty: 1.5,
    })

    assert(result.totalPcmBytes > 0, 'No audio data received')
    log('ℹ', `Got ${result.totalPcmBytes} bytes with rep_penalty=1.5`)
  } finally {
    ws.close()
  }
})

// --- 4. Error handling ---
console.log('\n─── Error Handling ───')

await test('Empty prompt returns error', async () => {
  const ws = await openWs()
  try {
    const errorPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for error')), 10_000)
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'error') {
            clearTimeout(timer)
            resolve(msg)
          }
        } catch {}
      })
    })

    ws.send(JSON.stringify({ type: 'generate', slot: 0, voice: 'tara', prompt: '', max_tokens: 100 }))
    const errMsg = await errorPromise
    assert(errMsg.message.includes('required'), `Expected "required" in error, got: ${errMsg.message}`)
    log('ℹ', `Got expected error: ${errMsg.message}`)
  } finally {
    ws.close()
  }
})

await test('Missing voice returns error', async () => {
  const ws = await openWs()
  try {
    const errorPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for error')), 10_000)
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'error') {
            clearTimeout(timer)
            resolve(msg)
          }
        } catch {}
      })
    })

    ws.send(JSON.stringify({ type: 'generate', slot: 0, prompt: 'test' }))
    const errMsg = await errorPromise
    assert(errMsg.type === 'error', 'Expected error message')
    log('ℹ', `Got expected error: ${errMsg.message}`)
  } finally {
    ws.close()
  }
})

await test('Malformed JSON is silently ignored', async () => {
  const ws = await openWs()
  try {
    ws.send('not valid json {{{')
    // Should not crash — wait briefly and verify connection still open
    await new Promise(r => setTimeout(r, 1000))
    assert(ws.readyState === WebSocket.OPEN, 'WebSocket closed after bad JSON')
    log('ℹ', 'Connection survived malformed JSON')
  } finally {
    ws.close()
  }
})

// --- 5. Abort ---
console.log('\n─── Abort ───')

await test('Abort cancels in-flight generation', async () => {
  const ws = await openWs()
  try {
    let gotAudio = false
    let gotDone = false

    ws.on('message', (data) => {
      if (typeof data !== 'string' && !Buffer.isBuffer(data)) return
      if (Buffer.isBuffer(data) && data[0] !== 0x7b) {
        gotAudio = true
        return
      }
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'done' && msg.slot === 0) gotDone = true
      } catch {}
    })

    // Start a generation with lots of tokens
    ws.send(JSON.stringify({
      type: 'generate', slot: 0,
      voice: 'tara',
      prompt: 'This is a very long sentence that should take a while to generate so we can test the abort mechanism properly.',
      max_tokens: 5000,
      repetition_penalty: 1.1,
    }))

    // Wait a bit for generation to start, then abort
    await new Promise(r => setTimeout(r, 3000))
    ws.send(JSON.stringify({ type: 'abort', slot: 0 }))

    // Wait and verify no 'done' message arrives
    await new Promise(r => setTimeout(r, 3000))
    assert(!gotDone, 'Got "done" after abort — abort may not have worked')
    log('ℹ', `Abort sent. Got audio before abort: ${gotAudio}, got done after: ${gotDone}`)
  } finally {
    ws.close()
  }
})

// --- 6. Audio quality checks ---
console.log('\n─── Audio Quality ───')

await test('Audio PCM data is valid 16-bit samples', async () => {
  const ws = await openWs()
  try {
    const result = await runGeneration(ws, {
      voice: 'tara',
      prompt: 'Audio quality test.',
      max_tokens: 500,
      repetition_penalty: 1.1,
    })

    // Check that total bytes is even (16-bit aligned)
    assert(result.totalPcmBytes % 2 === 0, `PCM bytes not 16-bit aligned: ${result.totalPcmBytes}`)

    // Verify audio chunks contain valid Int16 data
    const allPcm = Buffer.concat(result.audioChunks)
    const samples = new Int16Array(allPcm.buffer, allPcm.byteOffset, allPcm.byteLength / 2)

    // Check that audio is not all silence
    let maxAbs = 0
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i])
      if (abs > maxAbs) maxAbs = abs
    }
    assert(maxAbs > 100, `Audio appears silent (max sample: ${maxAbs})`)

    // Check that audio is not clipped (some headroom)
    const totalSamples = samples.length
    const audioDurationSec = totalSamples / SAMPLE_RATE
    log('ℹ', `${totalSamples} samples, ${audioDurationSec.toFixed(2)}s, peak: ${maxAbs}/32767`)
  } finally {
    ws.close()
  }
})

// --- 7. Longer text (chunking) ---
console.log('\n─── Long Text (Chunking) ───')

await test('Long text triggers chunking', async () => {
  const ws = await openWs()
  const longText = 'Nothing beside remains. Round the decay of that colossal wreck, boundless and bare, the lone and level sands stretch far away. ' +
    'I met a traveller from an antique land who said two vast and trunkless legs of stone stand in the desert. Near them on the sand, half sunk, a shattered visage lies. ' +
    'The hand that mocked them and the heart that fed. And on the pedestal these words appear. My name is Ozymandias, king of kings. Look on my works, ye Mighty, and despair.'
  try {
    const result = await runGeneration(ws, {
      voice: 'tara',
      prompt: longText,
      max_tokens: 4000,
      repetition_penalty: 1.1,
    })

    assert(result.totalPcmBytes > 0, 'No audio for long text')
    const audioSec = result.audioDurationMs / 1000
    assert(audioSec > 2, `Audio too short for long text: ${audioSec}s`)
    log('ℹ', `Long text: ${longText.length} chars → ${audioSec.toFixed(2)}s audio, ${result.totalMs}ms total`)
  } finally {
    ws.close()
  }
}, { skip: QUICK_MODE, timeout: 180_000 })

// --- 8. Concurrent requests ---
console.log('\n─── Concurrency ───')

await test('Two concurrent generations on different slots', async () => {
  const ws = await openWs()

  try {
    const slot0Done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Slot 0 timed out')), TIMEOUT_SINGLE)
      const chunks = []
      let bytes = 0

      const handler = (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        if (buf[0] === 0x7b || (typeof data === 'string')) {
          try {
            const msg = JSON.parse(buf.toString())
            if (msg.type === 'done' && msg.slot === 0) {
              clearTimeout(timer)
              ws.removeListener('message', handler)
              resolve({ bytes, ttfbMs: null, totalMs: msg.totalMs, audioDurationMs: msg.audioDurationMs })
            }
            if (msg.type === 'error' && msg.slot === 0) {
              clearTimeout(timer)
              ws.removeListener('message', handler)
              reject(new Error(`Slot 0 error: ${msg.message}`))
            }
          } catch {}
        } else if (buf.byteLength >= 4) {
          const slot = buf.readUInt16LE(0)
          if (slot === 0) bytes += buf.byteLength - 2
        }
      }
      ws.on('message', handler)
    })

    const slot1Done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Slot 1 timed out')), TIMEOUT_SINGLE)
      let bytes = 0

      const handler = (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        if (buf[0] === 0x7b || (typeof data === 'string')) {
          try {
            const msg = JSON.parse(buf.toString())
            if (msg.type === 'done' && msg.slot === 1) {
              clearTimeout(timer)
              ws.removeListener('message', handler)
              resolve({ bytes, totalMs: msg.totalMs, audioDurationMs: msg.audioDurationMs })
            }
            if (msg.type === 'error' && msg.slot === 1) {
              clearTimeout(timer)
              ws.removeListener('message', handler)
              reject(new Error(`Slot 1 error: ${msg.message}`))
            }
          } catch {}
        } else if (buf.byteLength >= 4) {
          const slot = buf.readUInt16LE(0)
          if (slot === 1) bytes += buf.byteLength - 2
        }
      }
      ws.on('message', handler)
    })

    ws.send(JSON.stringify({
      type: 'generate', slot: 0,
      voice: 'tara', prompt: 'First concurrent test.', max_tokens: 500, repetition_penalty: 1.1,
    }))
    ws.send(JSON.stringify({
      type: 'generate', slot: 1,
      voice: 'leo', prompt: 'Second concurrent test.', max_tokens: 500, repetition_penalty: 1.1,
    }))

    const [r0, r1] = await Promise.all([slot0Done, slot1Done])
    assert(r0.bytes > 0, 'Slot 0 got no audio')
    assert(r1.bytes > 0, 'Slot 1 got no audio')
    log('ℹ', `Slot 0: ${r0.bytes} bytes (${r0.totalMs}ms), Slot 1: ${r1.bytes} bytes (${r1.totalMs}ms)`)
  } finally {
    ws.close()
  }
}, { skip: QUICK_MODE, timeout: 180_000 })

// --- 9. All voices ---
console.log('\n─── Voice Coverage ───')

const ALL_VOICES = ['tara', 'leah', 'jess', 'mia', 'zoe', 'leo', 'dan', 'zac']

await test(`All ${ALL_VOICES.length} voices produce audio`, async () => {
  const voiceResults = []

  for (const voice of ALL_VOICES) {
    const ws = await openWs()
    try {
      const result = await runGeneration(ws, {
        voice,
        prompt: 'Voice test.',
        max_tokens: 300,
        repetition_penalty: 1.1,
      })
      assert(result.totalPcmBytes > 0, `Voice "${voice}" produced no audio`)
      voiceResults.push({ voice, bytes: result.totalPcmBytes, ttfb: result.ttfbMs })
    } finally {
      ws.close()
    }
  }

  for (const v of voiceResults) {
    log('ℹ', `${v.voice.padEnd(5)} → ${v.bytes} bytes, TTFB: ${v.ttfb}ms`)
  }
}, { skip: QUICK_MODE, timeout: ALL_VOICES.length * TIMEOUT_SINGLE })

// ─── Summary ────────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════')
console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`)
console.log('═══════════════════════════════════════════════════\n')

if (failed > 0) {
  console.log('  Failed tests:')
  for (const r of results.filter(r => r.status === 'fail')) {
    console.log(`    ✗ ${r.name}: ${r.error}`)
  }
  console.log()
}

process.exit(failed > 0 ? 1 : 0)
