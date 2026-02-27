/**
 * useWsConnection – WebSocket connection lifecycle hook
 * =====================================================
 * Thin React wrapper around wsService connection state.
 * Provides reactive connState and connect/disconnect actions.
 */

import { useEffect, useState } from 'react'
import { wsService } from '../services/wsService'
import type { WsConnectionState } from '../types'

export function useWsConnection() {
  const [connState, setConnState] = useState<WsConnectionState>(wsService.getState())

  useEffect(() => wsService.onStateChange(setConnState), [])

  return {
    connState,
    connect:    () => wsService.connect(),
    disconnect: () => wsService.disconnect(),
  }
}
