/**
 * Offscreen document for screen recording and extension-owned clipboard writes.
 *
 * WHY OFFSCREEN DOCUMENT?
 * Manifest V3 service workers cannot use MediaRecorder or getUserMedia directly.
 * This hidden document provides media and clipboard Web APIs while the service worker orchestrates.
 *
 * RECORDING FLOW:
 *
 * ┌─────────────────┐     HTTP      ┌─────────────────┐    WebSocket    ┌─────────────────┐
 * │  User Code      │ ────────────► │  Relay Server   │ ───────────────►│  Extension      │
 * │  startRecording │               │  /recording/*   │                 │  background.ts  │
 * └─────────────────┘               └─────────────────┘                 └────────┬────────┘
 *                                                                                │
 *                                          ┌─────────────────────────────────────┘
 *                                          ▼
 *                                   ┌─────────────────┐
 *                                   │  Offscreen Doc  │  ◄── MediaRecorder
 *                                   │  (this file)    │
 *                                   └─────────────────┘
 *
 * STEP BY STEP:
 * 1. User calls startRecording() → HTTP POST to relay server
 * 2. Relay server forwards to extension via WebSocket
 * 3. Extension calls chrome.tabCapture.getMediaStreamId() to get capture permission
 *    - Requires --allowlisted-extension-id flag OR user clicking extension icon
 * 4. Extension creates this offscreen document via chrome.offscreen.createDocument()
 * 5. Extension sends streamId to offscreen document
 * 6. Offscreen calls navigator.mediaDevices.getUserMedia() with streamId
 * 7. Offscreen creates MediaRecorder and starts encoding to mp4
 * 8. Chunks are sent back to extension → relay server → written to output file
 *
 * KEY APIS:
 * - chrome.tabCapture.getMediaStreamId() - Extension API, gets capture permission
 * - chrome.offscreen.createDocument()    - Extension API, creates this document
 * - navigator.mediaDevices.getUserMedia() - Web API, gets MediaStream from streamId
 * - MediaRecorder                         - Web API, encodes video to mp4
 */

import type {
  OffscreenMessage,
  OffscreenStartRecordingMessage,
  OffscreenStopRecordingMessage,
  OffscreenIsRecordingMessage,
  OffscreenCancelRecordingMessage,
  OffscreenCopyTextMessage,
  OffscreenStartRecordingResult,
  OffscreenStopRecordingResult,
  OffscreenIsRecordingResult,
  OffscreenCancelRecordingResult,
  OffscreenCopyTextResult,
  ChromeTabCaptureAudioConstraints,
  ChromeTabCaptureVideoConstraints,
} from './offscreen-types'

interface OffscreenRecordingState {
  recorder: MediaRecorder
  stream: MediaStream
  startedAt: number
  tabId: number
  chunkChain: Promise<void>
  cancelled: boolean
}

// Map of tabId -> recording state for concurrent recording support
const recordings = new Map<number, OffscreenRecordingState>()
const OFFSCREEN_ACTIONS = new Set<OffscreenMessage['action']>([
  'startRecording',
  'stopRecording',
  'isRecording',
  'cancelRecording',
  'copyText',
])

type OffscreenResult =
  | OffscreenStartRecordingResult
  | OffscreenStopRecordingResult
  | OffscreenIsRecordingResult
  | OffscreenCancelRecordingResult
  | OffscreenCopyTextResult

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  if (!OFFSCREEN_ACTIONS.has(message.action)) {
    return false
  }
  void handleMessage(message).then(sendResponse)
  return true // Keep channel open for async response
})

async function handleMessage(message: OffscreenMessage): Promise<OffscreenResult> {
  switch (message.action) {
    case 'startRecording':
      return handleStartRecording(message)
    case 'stopRecording':
      return handleStopRecording(message)
    case 'isRecording':
      return handleIsRecording(message)
    case 'cancelRecording':
      return handleCancelRecording(message)
    case 'copyText':
      return handleCopyText(message)
  }
}

async function handleCopyText(message: OffscreenCopyTextMessage): Promise<OffscreenCopyTextResult> {
  try {
    const textarea = document.querySelector<HTMLTextAreaElement>('#clipboard-text')
    if (!textarea) {
      return { success: false, error: 'Clipboard textarea is missing' }
    }
    textarea.value = message.text
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.value = ''
    if (!copied) {
      return { success: false, error: 'Clipboard copy command failed' }
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function handleStartRecording(params: OffscreenStartRecordingMessage): Promise<OffscreenStartRecordingResult> {
  const { tabId } = params
  let stream: MediaStream | null = null

  if (recordings.has(tabId)) {
    return { success: false, error: `Recording already in progress for tab ${tabId}` }
  }

  try {
    // Build Chrome-specific tabCapture constraints
    // These use Chrome's proprietary API that TypeScript doesn't have built-in types for
    const audioConstraints: ChromeTabCaptureAudioConstraints | false = params.audio
      ? {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: params.streamId,
          },
        }
      : false

    const videoConstraints: ChromeTabCaptureVideoConstraints = {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: params.streamId,
        minFrameRate: params.frameRate || 30,
        maxFrameRate: params.frameRate || 30,
      },
    }

    // Get media stream from the streamId provided by tabCapture.getMediaStreamId
    // Cast to MediaStreamConstraints since Chrome accepts the extended constraints
    stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: videoConstraints,
    } as MediaStreamConstraints)

    const recorder = new MediaRecorder(stream, {
      mimeType: 'video/mp4',
      videoBitsPerSecond: params.videoBitsPerSecond || 2500000,
      audioBitsPerSecond: params.audioBitsPerSecond || 128000,
    })

    const startedAt = Date.now()
    const recording: OffscreenRecordingState = {
      recorder,
      stream,
      startedAt,
      tabId,
      chunkChain: Promise.resolve(),
      cancelled: false,
    }
    recordings.set(tabId, recording)

    // Send chunks to service worker - each chunk includes tabId for routing
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) {
        return
      }
      recording.chunkChain = recording.chunkChain
        .then(async () => {
          if (recording.cancelled) {
            return
          }
          const result = await chrome.runtime.sendMessage({
            action: 'recordingChunk',
            tabId,
            dataBase64: await blobToBase64(event.data),
          })
          if (result?.success === false) {
            throw new Error(result.error || 'Could not send recording chunk')
          }
        })
        .catch((error) => {
          console.error(`Failed to send recording chunk for tab ${tabId}:`, error)
          handleCancelRecordingForTab(tabId)
        })
    }

    recorder.onerror = (event: Event) => {
      console.error(`MediaRecorder error for tab ${tabId}:`, (event as ErrorEvent).error)
      handleCancelRecordingForTab(tabId)
    }

    recorder.onstop = () => {
      console.log(`MediaRecorder stopped for tab ${tabId}`)
    }

    // Wait for MediaRecorder to actually start before returning.
    // This ensures the encoder is initialized and ready to capture frames.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('MediaRecorder failed to start within 5 seconds'))
      }, 5000)

      recorder.onstart = () => {
        clearTimeout(timeout)
        console.log(`MediaRecorder started for tab ${tabId}`)
        resolve()
      }

      // Start with 1 second chunks
      recorder.start(1000)
    })

    return { success: true, tabId, startedAt, mimeType: recorder.mimeType || 'video/mp4' }
  } catch (error: any) {
    stream?.getTracks().map((track) => {
      track.stop()
    })
    recordings.delete(tabId)
    console.error(`Failed to start recording for tab ${tabId}:`, error)
    return { success: false, error: error.message }
  }
}

async function handleStopRecording(params: OffscreenStopRecordingMessage): Promise<OffscreenStopRecordingResult> {
  const { tabId } = params
  const recording = recordings.get(tabId)

  if (!recording) {
    return { success: false, error: `No active recording for tab ${tabId}` }
  }

  try {
    const { recorder, stream, startedAt } = recording

    // Stop recorder and wait for final data
    await new Promise<void>((resolve) => {
      const originalOnStop = recorder.onstop
      recorder.onstop = (event: Event) => {
        if (originalOnStop) {
          originalOnStop.call(recorder, event)
        }
        resolve()
      }
      if (recorder.state !== 'inactive') {
        recorder.stop()
      } else {
        resolve()
      }
    })
    await recording.chunkChain

    const duration = Date.now() - startedAt

    // Send final marker
    await chrome.runtime.sendMessage({
      action: 'recordingChunk',
      tabId,
      final: true,
    })

    return { success: true, tabId, duration }
  } catch (error: any) {
    console.error(`Failed to stop recording for tab ${tabId}:`, error)
    return { success: false, error: error.message }
  } finally {
    recording.stream.getTracks().forEach((track) => {
      track.stop()
    })
    recordings.delete(tabId)
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Could not encode recording chunk'))
        return
      }
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => {
      reject(reader.error || new Error('Could not read recording chunk'))
    }
    reader.readAsDataURL(blob)
  })
}

function handleIsRecording(params: OffscreenIsRecordingMessage): OffscreenIsRecordingResult {
  const { tabId } = params
  const recording = recordings.get(tabId)

  if (!recording) {
    return { isRecording: false, tabId }
  }

  return {
    isRecording: recording.recorder?.state === 'recording',
    tabId,
    startedAt: recording.startedAt,
  }
}

function handleCancelRecording(params: OffscreenCancelRecordingMessage): OffscreenCancelRecordingResult {
  const { tabId } = params
  return handleCancelRecordingForTab(tabId)
}

// Helper function to cancel recording for a specific tab - used by error handlers too
function handleCancelRecordingForTab(tabId: number): OffscreenCancelRecordingResult {
  const recording = recordings.get(tabId)

  if (!recording) {
    return { success: true, tabId }
  }

  try {
    const { recorder, stream } = recording
    recording.cancelled = true

    if (recorder.state !== 'inactive') {
      recorder.stop()
    }
    stream.getTracks().forEach((track) => {
      track.stop()
    })

    void chrome.runtime.sendMessage({
      action: 'recordingCancelled',
      tabId,
    })

    recordings.delete(tabId)

    return { success: true, tabId }
  } catch (error: any) {
    console.error(`Failed to cancel recording for tab ${tabId}:`, error)
    return { success: false, error: error.message }
  }
}

console.log('Playwriter offscreen document loaded')
