/**
 * Recording relay functionality for the CDP relay server.
 * Handles recording state and streams capture chunks into atomic output files.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pc from 'picocolors'
import type {
  StartRecordingParams,
  StopRecordingParams,
  IsRecordingParams,
  CancelRecordingParams,
  StartRecordingResult,
  StopRecordingResult,
  IsRecordingResult,
  CancelRecordingResult,
  RecordingDataMessage,
  RecordingCancelledMessage,
} from './protocol.js'

export class RecordingOutput {
  readonly outputPath: string
  readonly temporaryPath: string
  private fd: number | null
  private bytesWritten = 0

  private constructor({ outputPath, temporaryPath, fd }: { outputPath: string; temporaryPath: string; fd: number }) {
    this.outputPath = outputPath
    this.temporaryPath = temporaryPath
    this.fd = fd
  }

  static open({ outputPath }: { outputPath: string }): RecordingOutput {
    const directory = path.dirname(outputPath)
    fs.mkdirSync(directory, { recursive: true })
    const temporaryPath = path.join(
      directory,
      `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    )
    const fd = fs.openSync(temporaryPath, 'w')
    return new RecordingOutput({ outputPath, temporaryPath, fd })
  }

  append(chunk: Buffer): void {
    if (this.fd === null) {
      throw new Error('Recording output is closed')
    }
    let offset = 0
    while (offset < chunk.length) {
      const written = fs.writeSync(this.fd, chunk, offset)
      if (written <= 0) {
        throw new Error('Recording output write made no progress')
      }
      offset += written
    }
    this.bytesWritten += chunk.length
  }

  finish(): { path: string; size: number } {
    if (this.fd === null) {
      throw new Error('Recording output is closed')
    }
    fs.closeSync(this.fd)
    this.fd = null
    fs.renameSync(this.temporaryPath, this.outputPath)
    return { path: this.outputPath, size: this.bytesWritten }
  }

  cancel(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd)
      } catch {}
      this.fd = null
    }
    try {
      fs.unlinkSync(this.temporaryPath)
    } catch {}
  }
}

export interface ActiveRecording {
  tabId: number
  sessionId?: string // The sessionId used to start this recording, for lookup when stopping
  output: RecordingOutput
  chunksReceived: number
  startedAt: number
  resolveStop?: (result: StopRecordingResult) => void
}

export class RecordingRelay {
  private activeRecordings = new Map<number, ActiveRecording>()
  // Track which tabId just sent recordingData metadata - used to route the next binary chunk
  private lastRecordingMetadataTabId: number | null = null
  private sendToExtension: (params: { method: string; params?: unknown; timeout?: number }) => Promise<unknown>
  private isExtensionConnected: () => boolean
  private logger?: { log(...args: unknown[]): void; error(...args: unknown[]): void }

  constructor({
    sendToExtension,
    isExtensionConnected,
    logger,
  }: {
    sendToExtension: (params: { method: string; params?: unknown; timeout?: number }) => Promise<unknown>
    isExtensionConnected: () => boolean
    logger?: { log(...args: unknown[]): void; error(...args: unknown[]): void }
  }) {
    this.sendToExtension = sendToExtension
    this.isExtensionConnected = isExtensionConnected
    this.logger = logger
  }

  /**
   * Handle incoming binary data (recording chunks) from the extension.
   */
  handleBinaryData(buffer: Buffer): void {
    const tabId = this.lastRecordingMetadataTabId
    this.lastRecordingMetadataTabId = null

    if (tabId !== null) {
      const recording = this.activeRecordings.get(tabId)
      if (recording) {
        this.appendRecordingPayload({ recording, buffer })
      } else {
        this.logger?.log(pc.yellow(`Received recording chunk for unknown tab ${tabId}, ignoring`))
      }
    } else {
      this.logger?.log(pc.yellow('Received recording chunk without preceding metadata, ignoring'))
    }
  }

  /**
   * Handle recordingData message from extension.
   */
  handleRecordingData(message: RecordingDataMessage): void {
    const { tabId, final } = message.params
    const recording = this.activeRecordings.get(tabId)

    if (!final) {
      this.lastRecordingMetadataTabId = tabId
    }

    if (recording && final) {
      this.finishRecording(recording)
    }
  }

  /**
   * Handle recordingCancelled message from extension.
   */
  handleRecordingCancelled(message: RecordingCancelledMessage): void {
    const { tabId } = message.params
    const recording = this.activeRecordings.get(tabId)
    if (recording) {
      this.logger?.log(pc.yellow(`Recording cancelled for tab ${tabId}`))
      this.failRecording({ recording, error: 'Recording was cancelled' })
    }
  }

  async startRecording(params: StartRecordingParams & { outputPath: string }): Promise<StartRecordingResult> {
    const { outputPath, ...recordingParams } = params

    if (!outputPath) {
      return { success: false, error: 'outputPath is required' }
    }

    if (!this.isExtensionConnected()) {
      return { success: false, error: 'Extension not connected' }
    }

    const output = (() => {
      try {
        return RecordingOutput.open({ outputPath: path.resolve(outputPath) })
      } catch (error) {
        this.logger?.error('Failed to open recording output:', error)
        return error instanceof Error ? error : new Error(String(error))
      }
    })()
    if (output instanceof Error) {
      return { success: false, error: output.message }
    }
    try {
      const result = (await this.sendToExtension({
        method: 'startRecording',
        params: recordingParams,
        timeout: 10000,
      })) as StartRecordingResult

      if (!result) {
        output.cancel()
        return { success: false, error: 'Extension returned empty result' }
      }

      if (result.success) {
        this.activeRecordings.set(result.tabId, {
          tabId: result.tabId,
          sessionId: recordingParams.sessionId,
          output,
          chunksReceived: 0,
          startedAt: result.startedAt,
        })
        this.logger?.log(
          pc.green(
            `Recording started for tab ${result.tabId} (sessionId: ${recordingParams.sessionId || 'none'}), output: ${outputPath}`,
          ),
        )
      } else {
        output.cancel()
      }

      return result
    } catch (error: unknown) {
      output.cancel()
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger?.error('Start recording error:', error)
      return { success: false, error: errorMessage }
    }
  }

  async stopRecording(params: StopRecordingParams): Promise<StopRecordingResult> {
    if (!this.isExtensionConnected()) {
      return { success: false, error: 'Extension not connected' }
    }

    const findRecording = (): ActiveRecording | undefined => {
      if (params.sessionId) {
        for (const recording of this.activeRecordings.values()) {
          if (recording.sessionId === params.sessionId) {
            return recording
          }
        }
        return undefined
      }
      return this.activeRecordings.values().next().value
    }

    const recording = findRecording()

    if (!recording) {
      const errorMsg = params.sessionId
        ? `No active recording found for sessionId: ${params.sessionId}`
        : 'No active recording found'
      return { success: false, error: errorMsg }
    }

    let timeoutId: ReturnType<typeof setTimeout>
    const finalPromise = new Promise<StopRecordingResult>((resolve) => {
      const wrappedResolve = (result: StopRecordingResult) => {
        clearTimeout(timeoutId)
        resolve(result)
      }
      recording.resolveStop = wrappedResolve
      timeoutId = setTimeout(() => {
        if (recording.resolveStop) {
          recording.resolveStop = undefined
          recording.output.cancel()
          this.activeRecordings.delete(recording.tabId)
          resolve({ success: false, error: 'Timeout waiting for recording data' })
        }
      }, 30000)
    })

    try {
      const result = (await this.sendToExtension({
        method: 'stopRecording',
        params,
        timeout: 10000,
      })) as StopRecordingResult

      if (!result.success) {
        this.failRecording({ recording, error: result.error || 'Extension failed to stop recording' })
        return result
      }

      return await finalPromise
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger?.error('Stop recording error:', error)
      this.failRecording({ recording, error: errorMessage })
      return { success: false, error: errorMessage }
    }
  }

  async isRecording(params: IsRecordingParams): Promise<IsRecordingResult> {
    if (!this.isExtensionConnected()) {
      return { isRecording: false }
    }

    try {
      return (await this.sendToExtension({
        method: 'isRecording',
        params,
        timeout: 5000,
      })) as IsRecordingResult
    } catch {
      return { isRecording: false }
    }
  }

  async cancelRecording(params: CancelRecordingParams): Promise<CancelRecordingResult> {
    if (!this.isExtensionConnected()) {
      return { success: false, error: 'Extension not connected' }
    }

    try {
      return (await this.sendToExtension({
        method: 'cancelRecording',
        params,
        timeout: 5000,
      })) as CancelRecordingResult
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger?.error('Cancel recording error:', error)
      return { success: false, error: errorMessage }
    }
  }

  destroyAll(reason: string): void {
    Array.from(this.activeRecordings.values()).map((recording) => {
      this.failRecording({ recording, error: reason })
    })
  }

  private failRecording({ recording, error }: { recording: ActiveRecording; error: string }): void {
    recording.output.cancel()
    recording.resolveStop?.({ success: false, error })
    recording.resolveStop = undefined
    this.activeRecordings.delete(recording.tabId)
  }

  private appendRecordingPayload({ recording, buffer }: { recording: ActiveRecording; buffer: Buffer }): void {
    try {
      recording.output.append(buffer)
      recording.chunksReceived += 1
      this.logger?.log(
        pc.blue(
          `Received recording chunk for tab ${recording.tabId}: ${buffer.length} bytes (total chunks: ${recording.chunksReceived})`,
        ),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failRecording({ recording, error: `Failed to write recording: ${message}` })
      this.requestRecordingCancellation(recording)
    }
  }

  private finishRecording(recording: ActiveRecording): void {
    try {
      const output = recording.output.finish()
      const duration = Date.now() - recording.startedAt
      this.logger?.log(pc.green(`Recording saved: ${output.path} (${output.size} bytes, ${duration}ms)`))
      recording.resolveStop?.({
        success: true,
        tabId: recording.tabId,
        duration,
        path: output.path,
        size: output.size,
      })
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger?.error('Failed to write recording:', error)
      recording.output.cancel()
      recording.resolveStop?.({ success: false, error: errorMessage })
    }
    this.activeRecordings.delete(recording.tabId)
  }

  private requestRecordingCancellation(recording: ActiveRecording): void {
    void this.sendToExtension({
      method: 'cancelRecording',
      params: recording.sessionId ? { sessionId: recording.sessionId } : {},
      timeout: 5000,
    }).catch(() => {})
  }
}
