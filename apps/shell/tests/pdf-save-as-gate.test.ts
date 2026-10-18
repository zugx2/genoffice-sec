import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Ruling 13, pdf Save As + the refusal ordering (structural).
 *
 * apps/shell/src/main/index.ts is the Electron app entry — importing it in a
 * test would boot the whole shell — so this pins the wiring by source, the
 * same approach as privacy-doc.test.ts: the pdf Save As menu item disables
 * while the active tab is cloud-only, and `savePdfAs` refuses via the shared
 * typed refusal BEFORE its save dialog opens or its clean-copy branch runs a
 * verbatim `copyFileSync` of a cloud-only document into a local file. The
 * behavior of the underlying predicate (`isCloudOnlyPath`) is covered by
 * document-store-router.test.ts; the editor-side gates by the per-editor
 * export-gate tests.
 */

const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')

/** The shell's whole pdf-menu + savePdfAs region: from `buildPdfMenu` up to the
 * next top-level function after it. */
const pdfMenuAndSaveAsRegion = (): string => {
  const start = source.indexOf('function buildPdfMenu(): void {')
  expect(start, 'buildPdfMenu found in shell main').toBeGreaterThan(-1)
  let end = source.indexOf('\nasync function ', start + 1)
  const fnAfter = source.indexOf('\nfunction ', start + 1)
  if (fnAfter > -1 && (end === -1 || fnAfter < end)) end = fnAfter
  expect(end, 'a function follows buildPdfMenu').toBeGreaterThan(start)
  return source.slice(start, end)
}

/** The body of the `savePdfAs` flow function. */
const savePdfAsBody = (): string => {
  const start = source.indexOf('async function savePdfAs(): Promise<void> {')
  expect(start, 'savePdfAs found in shell main').toBeGreaterThan(-1)
  let end = source.indexOf('\nasync function ', start + 1)
  const fnAfter = source.indexOf('\nfunction ', start + 1)
  if (fnAfter > -1 && (end === -1 || fnAfter < end)) end = fnAfter
  expect(end, 'a function follows savePdfAs').toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('pdf Save As gate (Ruling 13)', () => {
  it('disables the Save As menu item while the active pdf tab is cloud-only', () => {
    const region = pdfMenuAndSaveAsRegion()
    // the pdf menu's Save As item carries the same predicate as the converter
    // exports in the same menu (the visible half of the two-layer treatment)
    expect(region).toMatch(
      /label: tm\('menuSaveAs'\),[\s\S]{0,160}?enabled: !pdfTabExportBlocked\(\)/,
    )
  })

  it('refuses savePdfAs before any dialog opens or the clean copy runs', () => {
    const body = savePdfAsBody()
    const refuse = body.indexOf('if (pdfTabExportBlocked())')
    expect(refuse, 'the cloud-only refusal is present').toBeGreaterThan(-1)
    expect(body).toContain('refuseBlockedExport()')
    // enforcement ordering: refusal first, dialog and the verbatim
    // copyFileSync branch only ever reachable past it (match the call, not
    // the word in the comment above it)
    const dialog = body.indexOf('showSaveDialogWithMemory')
    const copy = body.indexOf('copyFileSync(tab.filePath')
    expect(dialog).toBeGreaterThan(refuse)
    expect(copy).toBeGreaterThan(refuse)
  })
})
