// ─── Voice ────────────────────────────────────────────────────────────────────

export type VoiceId = 'tara' | 'leah' | 'jess' | 'leo' | 'dan' | 'mia' | 'zac' | 'zoe'

export interface VoiceOption {
  id: VoiceId
  label: string
  gender: 'Female' | 'Male'
}

// ─── TTS Parameters ──────────────────────────────────────────────────────────

export interface TTSParams {
  voice: VoiceId
  prompt: string
  max_tokens: number
  repetition_penalty: number
  temperature?: number
  top_p?: number
}

// ─── WebSocket Message Types ─────────────────────────────────────────────────

export type WsConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export type WsInboundMessage =
  | { type: 'connected' }
  | { type: 'ttfb'; slot: number; ms: number }
  | { type: 'done'; slot: number; totalMs: number; audioDurationMs: number }
  | { type: 'error'; slot: number; message: string }

// ─── Streaming Session ──────────────────────────────────────────────────────

export type StreamingPlaybackState = 'idle' | 'connecting' | 'playing' | 'done' | 'error' | 'stopped'

export interface StreamingMetrics {
  timeToFirstByteMs: number | null
  totalTimeMs: number | null
  audioDurationMs: number | null
  bytesReceived: number
}

export interface StreamingSession {
  id: string
  state: StreamingPlaybackState
  metrics: StreamingMetrics
  audioUrl: string | null
  error: string | null
}

// ─── Stress Test ────────────────────────────────────────────────────────────

export interface StressTestStats {
  total: number
  succeeded: number
  failed: number
  avgTotalTimeMs: number
  minTotalTimeMs: number
  maxTotalTimeMs: number
  avgTtfbMs: number
  avgAudioDurationMs: number
}
