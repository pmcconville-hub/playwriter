/**
 * Tests viewport sizing and atomic recording file output.
 */
import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fitToAspectRatio } from './screen-recording.js'
import { RecordingOutput } from './recording-relay.js'

describe('fitToAspectRatio', () => {
  test('common sizes → 16:9', () => {
    const ratio = { width: 16, height: 9 }

    // Already 16:9 — no change
    expect(fitToAspectRatio({ width: 1920, height: 1080 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 1080,
        "width": 1920,
      }
    `)
    expect(fitToAspectRatio({ width: 1280, height: 720 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 720,
        "width": 1280,
      }
    `)

    // 16:10 (MacBook default) — too tall, shrink height
    expect(fitToAspectRatio({ width: 1440, height: 900 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 810,
        "width": 1440,
      }
    `)
    expect(fitToAspectRatio({ width: 1680, height: 1050 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 945,
        "width": 1680,
      }
    `)

    // 4:3 — too tall, shrink height
    expect(fitToAspectRatio({ width: 1024, height: 768 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 576,
        "width": 1024,
      }
    `)

    // Ultra-wide 21:9 — too wide, shrink width
    expect(fitToAspectRatio({ width: 2560, height: 1080 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 1080,
        "width": 1920,
      }
    `)
    expect(fitToAspectRatio({ width: 3440, height: 1440 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 1440,
        "width": 2560,
      }
    `)

    // Square — too tall, shrink height
    expect(fitToAspectRatio({ width: 1000, height: 1000 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 563,
        "width": 1000,
      }
    `)
  })

  test('custom aspect ratios', () => {
    // 4:3
    expect(fitToAspectRatio({ width: 1920, height: 1080 }, { width: 4, height: 3 })).toMatchInlineSnapshot(`
      {
        "height": 1080,
        "width": 1440,
      }
    `)

    // 1:1
    expect(fitToAspectRatio({ width: 1920, height: 1080 }, { width: 1, height: 1 })).toMatchInlineSnapshot(`
      {
        "height": 1080,
        "width": 1080,
      }
    `)

    // 9:16 vertical
    expect(fitToAspectRatio({ width: 1920, height: 1080 }, { width: 9, height: 16 })).toMatchInlineSnapshot(`
      {
        "height": 1080,
        "width": 608,
      }
    `)
  })

  test('never increases dimensions', () => {
    const ratio = { width: 16, height: 9 }
    const sizes = [
      { width: 800, height: 600 },
      { width: 1440, height: 900 },
      { width: 2560, height: 1080 },
      { width: 1000, height: 1000 },
    ]
    for (const size of sizes) {
      const result = fitToAspectRatio(size, ratio)
      expect(result.width).toBeLessThanOrEqual(size.width)
      expect(result.height).toBeLessThanOrEqual(size.height)
    }
  })
})

describe('RecordingOutput', () => {
  test('keeps output hidden until all chunks are complete', () => {
    const parent = path.join(process.cwd(), 'tmp')
    fs.mkdirSync(parent, { recursive: true })
    const dir = fs.mkdtempSync(path.join(parent, 'recording-output-'))
    const outputPath = path.join(dir, 'recording.mp4')

    try {
      const output = RecordingOutput.open({ outputPath })
      output.append(Buffer.from('first'))
      output.append(Buffer.from('-second'))

      expect(fs.existsSync(outputPath)).toBe(false)
      expect(output.finish()).toEqual({ path: outputPath, size: 12 })
      expect(fs.readFileSync(outputPath, 'utf8')).toBe('first-second')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('removes partial output after cancellation', () => {
    const parent = path.join(process.cwd(), 'tmp')
    fs.mkdirSync(parent, { recursive: true })
    const dir = fs.mkdtempSync(path.join(parent, 'recording-output-'))
    const outputPath = path.join(dir, 'recording.mp4')

    try {
      const output = RecordingOutput.open({ outputPath })
      output.append(Buffer.from('partial'))
      const temporaryPath = output.temporaryPath
      output.cancel()

      expect(fs.existsSync(outputPath)).toBe(false)
      expect(fs.existsSync(temporaryPath)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
