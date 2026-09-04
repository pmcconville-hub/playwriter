// Verifies the remote-control tunnel protocol with real workerd WebSockets.

import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import { routeRemoteControlRequest } from './remote-control-tunnel.ts'

function requireWebSocket(response: Response): WebSocket {
  const socket = response.webSocket
  if (!socket) {
    throw new Error(`Expected WebSocket upgrade, got ${response.status}`)
  }
  socket.accept()
  return socket
}

function waitForMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
    }
    const onMessage = (event: MessageEvent) => {
      cleanup()
      if (typeof event.data !== 'string') {
        reject(new Error('Expected a text WebSocket frame'))
        return
      }
      resolve(event.data)
    }
    const onError = () => {
      cleanup()
      reject(new Error('WebSocket error before message'))
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
  })
}

function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('close', onClose)
      socket.removeEventListener('error', onError)
    }
    const onClose = (event: CloseEvent) => {
      cleanup()
      resolve(event)
    }
    const onError = () => {
      cleanup()
      reject(new Error('WebSocket error before close'))
    }
    socket.addEventListener('close', onClose)
    socket.addEventListener('error', onError)
  })
}

async function openTunnelSocket({
  stub,
  path,
}: {
  stub: DurableObjectStub
  path: string
}): Promise<WebSocket> {
  const response = await stub.fetch(`https://remote-control.test${path}`, {
    headers: { Upgrade: 'websocket' },
  })
  return requireWebSocket(response)
}

async function openRoutedTunnelSocket({
  tunnelId,
  path,
}: {
  tunnelId: string
  path: string
}): Promise<WebSocket> {
  const response = await routeRemoteControlRequest({
    request: new Request(`https://${tunnelId}-tunnel.playwriter.dev${path}`, {
      headers: { Upgrade: 'websocket' },
    }),
    env,
  })
  if (!response) {
    throw new Error('Expected the remote-control request to be routed')
  }
  return requireWebSocket(response)
}

describe('remote control tunnel', () => {
  test('relays extension protocol frames in both directions', async () => {
    const tunnelId = crypto.randomUUID()
    const upstream = await openRoutedTunnelSocket({ tunnelId, path: '/traforo-upstream' })

    expect(JSON.parse(await waitForMessage(upstream))).toEqual({ type: 'upstream_accepted' })

    const openMessagePromise = waitForMessage(upstream)
    const downstream = await openRoutedTunnelSocket({ tunnelId, path: '/extension' })
    const openMessage = JSON.parse(await openMessagePromise) as {
      type: string
      connId: string
      path: string
    }
    expect(openMessage).toMatchObject({ type: 'ws_open', path: '/extension' })

    upstream.send(JSON.stringify({ type: 'ws_opened', connId: openMessage.connId }))

    const upstreamFramePromise = waitForMessage(upstream)
    downstream.send('{"id":1,"method":"ping"}')
    expect(JSON.parse(await upstreamFramePromise)).toEqual({
      type: 'ws_frame',
      connId: openMessage.connId,
      data: '{"id":1,"method":"ping"}',
      binary: false,
    })

    const downstreamFramePromise = waitForMessage(downstream)
    upstream.send(
      JSON.stringify({
        type: 'ws_frame',
        connId: openMessage.connId,
        data: '{"id":1,"result":"pong"}',
        binary: false,
      }),
    )
    expect(await downstreamFramePromise).toBe('{"id":1,"result":"pong"}')

    const closeMessagePromise = waitForMessage(upstream)
    downstream.close(1000, 'agent disconnected')
    expect(JSON.parse(await closeMessagePromise)).toEqual({
      type: 'ws_close',
      connId: openMessage.connId,
      code: 1000,
      reason: 'agent disconnected',
    })

    upstream.close(1000, 'done')
  })

  test('rejects a second upstream and drops downstreams when sharing stops', async () => {
    const id = env.REMOTE_CONTROL_TUNNEL.idFromName(crypto.randomUUID())
    const stub = env.REMOTE_CONTROL_TUNNEL.get(id)
    const upstream = await openTunnelSocket({ stub, path: '/traforo-upstream' })
    await waitForMessage(upstream)

    const rejectedResponse = await stub.fetch('https://remote-control.test/traforo-upstream', {
      headers: { Upgrade: 'websocket' },
    })
    if (!rejectedResponse.webSocket) {
      throw new Error(`Expected rejected WebSocket upgrade, got ${rejectedResponse.status}`)
    }
    const rejected = rejectedResponse.webSocket
    const rejectedClosePromise = waitForClose(rejected)
    rejected.accept()
    await expect(rejectedClosePromise).resolves.toMatchObject({ code: 4409 })

    const openMessagePromise = waitForMessage(upstream)
    const downstream = await openTunnelSocket({ stub, path: '/extension' })
    const openMessage = JSON.parse(await openMessagePromise) as { connId: string }
    upstream.send(JSON.stringify({ type: 'ws_opened', connId: openMessage.connId }))

    const downstreamClosePromise = waitForClose(downstream)
    upstream.close(1000, 'sharing stopped')
    await expect(downstreamClosePromise).resolves.toMatchObject({ code: 1012 })
  })
})
