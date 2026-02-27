/**
 * useWebSocketTTS – Single generation via WebSocket
 * ===================================================
 * Manages a single TTS streaming session:
 * - Subscribes to wsService audio + control messages for slot 0
 * - Schedules audio playback via AudioContext with jitter buffer
 * - Builds downloadable WAV after completion
 *
 * Architecture:
 *   wsService.onAudio → jitter buffer → AudioBufferSourceNode → speakers
 *   wsService.onMessage → metrics + state updates
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
}

function int16ToFloat32(buf: Int16Array): Float32Array {
  const out = new Float32Array(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] / 32768.0
  return out
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useWebSocketTTS() {
  const [session, setSession] = useState<StreamingSession>({
    id: '', state: 'idle', metrics: DEFAULT_METRICS, audioUrl: null, error: null,
  })

  const audioCtxRef     = useRef<AudioContext | null>(null)
  const nextTimeRef     = useRef(0)
  const pcmChunksRef    = useRef<Float32Array[]>([])
  const bytesRef        = useRef(0)
  const prevUrlRef      = useRef<string | null>(null)
  const sessionIdRef    = useRef('')
  const unsubRefs       = useRef<Array<() => void>>([])
  const jitterBufRef    = useRef<Float32Array[]>([])
  const jitterLenRef    = useRef(0)
  const playbackRateRef = useRef(1.0)

  // 200ms at 24kHz — flush threshold for jitter buffer
  const JITTER_MIN = 4800

  const _flushJitterBuf = () => {
    const ctx = audioCtxRef.current
    if (!ctx || jitterLenRef.current === 0) return

    const merged = new Float32Array(jitterLenRef.current)
    let offset = 0
    for (const chunk of jitterBufRef.current) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    jitterBufRef.current = []
    jitterLenRef.current = 0

    const audioBuffer = ctx.createBuffer(1, merged.length, 24000)
    audioBuffer.copyToChannel(merged as Float32Array<ArrayBuffer>, 0)
    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.playbackRate.value = playbackRateRef.current
    source.connect(ctx.destination)

    const now = ctx.currentTime
    const startAt = nextTimeRef.current > now ? nextTimeRef.current : now + 0.050
    source.start(startAt)
    nextTimeRef.current = startAt + audioBuffer.duration / playbackRateRef.current
  }

  const _cleanup = () => {
    _flushJitterBuf()
    jitterBufRef.current = []
    jitterLenRef.current = 0
    unsubRefs.current.forEach((fn) => fn())
    unsubRefs.current = []
  }

  const start = useCallback((params: TTSParams, playbackRate = 1.0) => {
    const id = `ws-${Date.now()}`
    sessionIdRef.current = id
    playbackRateRef.current = playbackRate

    _cleanup()
    audioCtxRef.current?.close().catch(() => {})
    if (prevUrlRef.current) { URL.revokeObjectURL(prevUrlRef.current); prevUrlRef.current = null }

    const ctx = new AudioContext({ sampleRate: 24000 })
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    audioCtxRef.current = ctx
    nextTimeRef.current = 0
    pcmChunksRef.current = []
    bytesRef.current = 0
    jitterBufRef.current = []
    jitterLenRef.current = 0

    setSession({ id, state: 'connecting', metrics: DEFAULT_METRICS, audioUrl: null, error: null })

    // Audio handler (slot 0)
    unsubRefs.current.push(
      wsService.onAudio((slot, pcmInt16) => {
        if (slot !== 0 || sessionIdRef.current !== id) return
        const samples = int16ToFloat32(pcmInt16)

        pcmChunksRef.current.push(samples)
        bytesRef.current += samples.length * 2

        jitterBufRef.current.push(samples)
        jitterLenRef.current += samples.length
        if (jitterLenRef.current >= JITTER_MIN) {
          _flushJitterBuf()
        }

        setSession((prev) => ({
          ...prev,
          state: 'playing',
          metrics: { ...prev.metrics, bytesReceived: bytesRef.current },
        }))
      }),
    )

    // Control message handler
    unsubRefs.current.push(
      wsService.onMessage((msg) => {
        if (sessionIdRef.current !== id) return

        if (msg.type === 'ttfb' && msg.slot === 0) {
          setSession((prev) => ({
            ...prev,
            metrics: { ...prev.metrics, timeToFirstByteMs: msg.ms },
          }))
        } else if (msg.type === 'done' && msg.slot === 0) {
          _flushJitterBuf()
          _cleanup()
          const blob = buildWavFromChunks(pcmChunksRef.current)
          const url = URL.createObjectURL(blob)
          prevUrlRef.current = url
          setSession((prev) => ({
            ...prev,
            state: 'done',
            audioUrl: url,
            metrics: {
              timeToFirstByteMs: prev.metrics.timeToFirstByteMs,
              totalTimeMs: msg.totalMs,
              audioDurationMs: msg.audioDurationMs,
              bytesReceived: prev.metrics.bytesReceived,
            },
          }))
        } else if (msg.type === 'error' && msg.slot === 0) {
          _cleanup()
          setSession((prev) => ({ ...prev, state: 'error', error: msg.message }))
        }
      }),
    )

    // Send generate command
    wsService.send({ type: 'generate', slot: 0, ...params })
  }, [])

  const stop = useCallback(() => {
    const id = sessionIdRef.current
    sessionIdRef.current = ''
    _cleanup()
    wsService.send({ type: 'abort', slot: 0 })
    audioCtxRef.current?.close().catch(() => {})
    setSession((prev) => (prev.id === id ? { ...prev, state: 'stopped' } : prev))
  }, [])

  const clear = useCallback(() => {
    sessionIdRef.current = ''
    _cleanup()
    wsService.send({ type: 'abort', slot: 0 })
    audioCtxRef.current?.close().catch(() => {})
    if (prevUrlRef.current) { URL.revokeObjectURL(prevUrlRef.current); prevUrlRef.current = null }
    setSession({ id: '', state: 'idle', metrics: DEFAULT_METRICS, audioUrl: null, error: null })
  }, [])

  useEffect(() => {
    return () => {
      _cleanup()
      audioCtxRef.current?.close().catch(() => {})
      if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current)
    }
  }, [])

  return { session, start, stop, clear }
}
