/**
 * useWebSocketStressTest – True parallel stress testing
 * =====================================================
 * Fires N concurrent generation requests simultaneously via WebSocket.
 *
 * Key design: ZERO client-side stagger.
 * The TRT-LLM engine builder uses max_utilization batch scheduler which
 * natively handles concurrent prefills. Client-side staggering would
 * artificially serialize requests and undercount true concurrency.
 *
 * Each request is assigned a unique slot number. The server multiplexes
 * all N streams over the single WebSocket connection using binary frames
 * with a 2-byte slot prefix.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { wsService } from '../services/wsService'
import { buildWavFromChunks } from '../utils/audioExport'
import type { TTSParams, StreamingSession, StreamingMetrics } from '../types'

// ─── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_METRICS: StreamingMetrics = {
  timeToFirstByteMs: null,
  totalTimeMs: null,
  audioDurationMs: null,
  bytesReceived: 0,
  tokensPerSecond: null,
}

function int16ToFloat32(buf: Int16Array): Float32Array {
  const out = new Float32Array(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] / 32768.0
  return out
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useWebSocketStressTest() {
  const [sessions, setSessions]     = useState<StreamingSession[]>([])
  const [isRunning, setIsRunning]   = useState(false)
  const [concurrency, setConcurrency] = useState(4)

  const urlsRef    = useRef<string[]>([])
  const runIdRef   = useRef('')
  const unsubRefs  = useRef<Array<() => void>>([])

  const _cleanup = () => {
    unsubRefs.current.forEach((fn) => fn())
    unsubRefs.current = []
  }

  const run = useCallback((params: TTSParams) => {
    const runId = `wsrun-${Date.now()}`
    runIdRef.current = runId

    _cleanup()
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u))
    urlsRef.current = []

    setIsRunning(true)

    const ids = Array.from({ length: concurrency }, (_, i) => `wss-${Date.now()}-${i + 1}`)
    const pcmChunks: Float32Array[][] = Array.from({ length: concurrency }, () => [])
    const bytesReceived: number[] = Array.from({ length: concurrency }, () => 0)
    const startTimes: number[] = Array.from({ length: concurrency }, () => Date.now())
    let completedCount = 0

    setSessions(
      ids.map((id) => ({
        id,
        state: 'connecting' as const,
        metrics: DEFAULT_METRICS,
        audioUrl: null,
        error: null,
      })),
    )

    // ── Audio handler (all slots) ──────────────────────────────────────────
    unsubRefs.current.push(
      wsService.onAudio((slot, pcmInt16) => {
        if (runIdRef.current !== runId || slot >= concurrency) return
        const samples = int16ToFloat32(pcmInt16)
        pcmChunks[slot].push(samples)
        bytesReceived[slot] += samples.length * 2
        setSessions((prev) =>
          prev.map((s, i) =>
            i === slot
              ? { ...s, state: 'playing', metrics: { ...s.metrics, bytesReceived: bytesReceived[slot] } }
              : s,
          ),
        )
      }),
    )

    // ── Control message handler ──────────────────────────────────────────────
    unsubRefs.current.push(
      wsService.onMessage((msg) => {
        if (runIdRef.current !== runId) return

        if (msg.type === 'ttfb') {
          if (msg.slot >= concurrency) return
          setSessions((prev) =>
            prev.map((s, i) =>
              i === msg.slot
                ? { ...s, metrics: { ...s.metrics, timeToFirstByteMs: msg.ms } }
                : s,
            ),
          )
        } else if (msg.type === 'done') {
          const { slot, totalMs, audioDurationMs } = msg
          if (slot >= concurrency) return
          const blob = buildWavFromChunks(pcmChunks[slot])
          const url  = URL.createObjectURL(blob)
          urlsRef.current.push(url)
          const tpsMs = totalMs > 0 ? totalMs : (Date.now() - startTimes[slot])
          const tokensPerSecond = bytesReceived[slot] > 0 && tpsMs > 0
            ? Math.round((bytesReceived[slot] / 8192 * 7) / (tpsMs / 1000) * 10) / 10
            : null
          setSessions((prev) =>
            prev.map((s, i) =>
              i === slot
                ? {
                    ...s,
                    state: 'done',
                    audioUrl: url,
                    metrics: {
                      timeToFirstByteMs: s.metrics.timeToFirstByteMs,
                      totalTimeMs: totalMs,
                      audioDurationMs,
                      bytesReceived: s.metrics.bytesReceived,
                      tokensPerSecond,
                    },
                  }
                : s,
            ),
          )
          completedCount++
          if (completedCount >= concurrency) { _cleanup(); setIsRunning(false) }
        } else if (msg.type === 'error') {
          if (msg.slot >= concurrency) return
          setSessions((prev) =>
            prev.map((s, i) =>
              i === msg.slot ? { ...s, state: 'error', error: msg.message } : s,
            ),
          )
          completedCount++
          if (completedCount >= concurrency) { _cleanup(); setIsRunning(false) }
        }
      }),
    )

    // ── Fire all requests simultaneously (true parallel) ─────────────────────
    // No stagger — TRT-LLM max_utilization scheduler handles concurrent batching
    for (let slot = 0; slot < concurrency; slot++) {
      startTimes[slot] = Date.now()
      wsService.send({ type: 'generate', slot, ...params })
    }
  }, [concurrency])

  const stopAll = useCallback(() => {
    runIdRef.current = ''
    _cleanup()
    for (let slot = 0; slot < Math.max(concurrency, 1); slot++) wsService.send({ type: 'abort', slot })
    setIsRunning(false)
    setSessions((prev) =>
      prev.map((s) =>
        s.state === 'playing' || s.state === 'connecting' ? { ...s, state: 'stopped' } : s,
      ),
    )
  }, [concurrency])

  const clear = useCallback(() => {
    runIdRef.current = ''
    _cleanup()
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u))
    urlsRef.current = []
    setSessions([])
  }, [])

  useEffect(() => () => { _cleanup() }, [])

  return { sessions, isRunning, concurrency, setConcurrency, run, stopAll, clear }
}
