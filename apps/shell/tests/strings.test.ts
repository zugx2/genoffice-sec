import { describe, expect, it } from 'vitest'
import { strings } from '../src/renderer/src/strings'

/**
 * Home-screen locale tables (src/renderer/src/strings.ts): zh defines the key
 * set; every other locale must cover exactly the same keys with real content.
 */

const locales = Object.keys(strings) as Array<keyof typeof strings>
const referenceKeys = Object.keys(strings.zh).sort()

/** placeholders like {n}, {name}, {v} embedded in a template */
function placeholdersOf(template: string): string[] {
  return (template.match(/\{[a-zA-Z0-9]+\}/g) ?? []).sort()
}

describe('home-screen locale tables', () => {
  it('includes the expected UI languages', () => {
    expect(locales).toContain('zh')
    expect(locales).toContain('en')
    expect(locales).toContain('zh-TW')
    expect(locales.length).toBeGreaterThanOrEqual(19)
  })

  it.each(locales)('locale %s has exactly the zh key set', (locale) => {
    expect(Object.keys(strings[locale]).sort()).toEqual(referenceKeys)
  })

  it.each(locales)('locale %s has no empty or whitespace-only values', (locale) => {
    const empty = Object.entries(strings[locale])
      .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
      .map(([key]) => key)
    expect(empty).toEqual([])
  })

  it.each(locales)('locale %s keeps the zh placeholder set for each key', (locale) => {
    const table = strings[locale] as Record<string, string>
    const mismatched = referenceKeys.filter((key) => {
      const localePlaceholders = placeholdersOf(table[key])
      const zhPlaceholders = placeholdersOf((strings.zh as Record<string, string>)[key])
      // Singular-count keys ("...One") may drop the numeral entirely in
      // languages that express "one" grammatically (e.g. ar/he), so a
      // missing placeholder is fine there — an extra one is not.
      if (key.endsWith('One')) {
        return localePlaceholders.some((p) => !zhPlaceholders.includes(p))
      }
      return localePlaceholders.join(',') !== zhPlaceholders.join(',')
    })
    expect(mismatched).toEqual([])
  })

  it('has no duplicate values that suggest an untranslated copy-paste between zh and en', () => {
    // sanity check that en is actually translated, not a zh copy
    const zh = strings.zh as Record<string, string>
    const en = strings.en as Record<string, string>
    const identical = referenceKeys.filter((key) => zh[key] === en[key])
    // a few shared strings (brand names, "PDF", "OK"-style tokens) are fine
    expect(identical.length).toBeLessThan(referenceKeys.length / 4)
  })

  // ── script-family check: a locale must not carry another script's text ──
  // The T15 incident was Hindi values pasted into the zh-TW block; a generic
  // guard catches that class of copy-paste for every locale at once. Latin
  // script is universal (brand names, "PDF", numerals), so only distinctive
  // scripts are policed, and each locale may use exactly its own family.

  /** script families a locale may legitimately contain (latin always allowed) */
  const ALLOWED_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
    zh: ['cjk'],
    'zh-TW': ['cjk'],
    ja: ['cjk'], // kana + kanji
    ko: ['cjk', 'hangul'],
    th: ['thai'],
    ru: ['cyrillic'],
    ar: ['arabic'],
    he: ['hebrew'],
    hi: ['devanagari'],
  }
  // Latin-script locales (en, fr, de, es, id, pt, it, pl, cs, nl, ms) allow
  // nothing but latin — every family above that a locale does not list is
  // an offender when it appears in one of its values.

  const FAMILY_RANGES: ReadonlyArray<[string, RegExp]> = [
    ['cjk', /[㐀-鿿぀-ヿ]/u],
    ['hangul', /[가-힯ᄀ-ᇿ]/u],
    ['thai', /[฀-๿]/u],
    ['cyrillic', /[Ѐ-ӿ]/u],
    ['arabic', /[؀-ۿ]/u],
    ['hebrew', /[֐-׿]/u],
    ['devanagari', /[ऀ-ॿ]/u],
  ]

  it.each(locales)('locale %s carries no other script family text', (locale) => {
    const allowed = new Set(ALLOWED_SCRIPTS[locale] ?? [])
    const table = strings[locale] as Record<string, string>
    const offenders: string[] = []
    for (const [family, pattern] of FAMILY_RANGES) {
      if (allowed.has(family)) continue
      const keys = referenceKeys.filter((key) => pattern.test(table[key] ?? ''))
      if (keys.length > 0) offenders.push(`${family}: ${keys.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('policeman for the script check: the family ranges themselves match', () => {
    // a range that matches nothing would silently disable the guard above
    const samples: ReadonlyArray<[string, string]> = [
      ['cjk', '文'],
      ['hangul', '한'],
      ['thai', 'ท'],
      ['cyrillic', 'а'],
      ['arabic', 'ا'],
      ['hebrew', 'א'],
      ['devanagari', 'अ'],
    ]
    for (const [family, sample] of samples) {
      const pattern = FAMILY_RANGES.find(([name]) => name === family)?.[1]
      expect(pattern, family).toBeDefined()
      expect(pattern!.test(sample), family).toBe(true)
    }
    expect(FAMILY_RANGES.some(([, pattern]) => pattern.test('plain latin'))).toBe(false)
  })
})
