/**
 * WebSocket Service – Singleton Client
 * ======================================
 *
 * A single persistent WebSocket connection shared across all hooks.
 * Audio arrives as binary frames; control messages as JSON text frames.
 *
 * Binary frame layout (server → client):
 *   Bytes 0-1  uint16 LE  slot index (0 = single gen, N = stress-test slot)
 *   Bytes 2+              raw 16-bit LE PCM at 24 kHz, mono
 *
 * This is a pure infrastructure service with no React dependency.
 * It uses an event bus pattern with typed handler sets.
 */

import type { WsConnectionState, WsInboundMessage } from '../types'

type MsgHandler   = (msg: WsInboundMessage) => void
type AudioHandler = (slot: number, pcm: Int16Array) => void
type StateHandler = (state: WsConnectionState) => void

class WsService {
  private ws: WebSocket | null = null
  private _state: WsConnectionState = 'disconnected'
  private _intentionalDisconnect = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _reconnectAttempts = 0
  private static MAX_RECONNECT_DELAY = 8000

  private msgHandlers   = new Set<MsgHandler>()
  private audioHandlers = new Set<AudioHandler>()
  private stateHandlers = new Set<StateHandler>()

  // ── State ──────────────────────────────────────────────────────────────────

  private setState(s: WsConnectionState) {
    this._state = s
    this.stateHandlers.forEach((h) => h(s))
  }

  getState(): WsConnectionState {
    return this._state
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  connect() {
    if (this._state === 'connected' || this._state === 'connecting') return
    this._intentionalDisconnect = false
    this._clearReconnectTimer()

    this.setState('connecting')

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as WsInboundMessage
          if (msg.type === 'connected') {
            this._reconnectAttempts = 0
            this.setState('connected')
          }
          this.msgHandlers.forEach((h) => h(msg))
        } catch {
          // Ignore malformed frames
        }
      } else {
        // Binary audio frame
        try {
          const buf = event.data as ArrayBuffer
          if (buf.byteLength < 4) return // need at least slot + 1 sample
          const pcmByteLen = buf.byteLength - 2
          const usableLen  = pcmByteLen - (pcmByteLen % 2)
          if (usableLen === 0) return
          const slot = new DataView(buf).getUint16(0, true)
          const pcm  = new Int16Array(buf, 2, usableLen / 2)
          console.log(`[ws] binary: ${buf.byteLength}B slot=${slot} samples=${pcm.length} handlers=${this.audioHandlers.size}`)
          this.audioHandlers.forEach((h) => h(slot, pcm))
        } catch {
          // Skip malformed binary frames
        }
      }
    }

    ws.onerror = () => {
      this.setState('error')
    }

    ws.onclose = () => {
      this.ws = null
      if (this._intentionalDisconnect) {
        this.setState('disconnected')
      } else {
        // Auto-reconnect with exponential backoff
        this.setState('disconnected')
        this._scheduleReconnect()
      }
    }
  }

  private _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  private _scheduleReconnect() {
    this._clearReconnectTimer()
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), WsService.MAX_RECONNECT_DELAY)
    this._reconnectAttempts++
    console.log(`[ws] reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this.connect()
    }, delay)
  }

  disconnect() {
    this._intentionalDisconnect = true
    this._clearReconnectTimer()
    this.ws?.close()
    this.ws = null
    this.setState('disconnected')
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  send(payload: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  // ── Subscriptions (return unsubscribe function) ────────────────────────────

  onMessage(h: MsgHandler): () => void {
    this.msgHandlers.add(h)
    return () => { this.msgHandlers.delete(h) }
  }

  onAudio(h: AudioHandler): () => void {
    this.audioHandlers.add(h)
    return () => { this.audioHandlers.delete(h) }
  }

  onStateChange(h: StateHandler): () => void {
    this.stateHandlers.add(h)
    return () => { this.stateHandlers.delete(h) }
  }
}

/** Singleton – import everywhere instead of creating new instances. */
export const wsService = new WsService()
