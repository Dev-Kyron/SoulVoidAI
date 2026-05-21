import { describe, expect, it } from 'vitest'
import { isSupportedFile } from './extract'

describe('isSupportedFile', () => {
  it('accepts common plain-text formats', () => {
    expect(isSupportedFile('notes.md')).toBe(true)
    expect(isSupportedFile('readme.txt')).toBe(true)
    expect(isSupportedFile('config.yaml')).toBe(true)
    expect(isSupportedFile('data.csv')).toBe(true)
    expect(isSupportedFile('schema.json')).toBe(true)
  })

  it('accepts code-file extensions for UE5 + general dev', () => {
    expect(isSupportedFile('Main.cpp')).toBe(true)
    expect(isSupportedFile('Player.h')).toBe(true)
    expect(isSupportedFile('build.py')).toBe(true)
    expect(isSupportedFile('app.ts')).toBe(true)
    expect(isSupportedFile('component.tsx')).toBe(true)
  })

  it('accepts pdf and docx', () => {
    expect(isSupportedFile('design.pdf')).toBe(true)
    expect(isSupportedFile('notes.docx')).toBe(true)
  })

  it('is case-insensitive on the extension', () => {
    expect(isSupportedFile('REPORT.PDF')).toBe(true)
    expect(isSupportedFile('Notes.MD')).toBe(true)
  })

  it('rejects unsupported binary formats', () => {
    expect(isSupportedFile('photo.png')).toBe(false)
    expect(isSupportedFile('video.mp4')).toBe(false)
    expect(isSupportedFile('archive.zip')).toBe(false)
    expect(isSupportedFile('binary.exe')).toBe(false)
  })

  it('rejects files with no extension', () => {
    expect(isSupportedFile('LICENSE')).toBe(false)
    expect(isSupportedFile('Makefile')).toBe(false)
  })
})
