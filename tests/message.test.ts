import { describe, expect, it } from 'vitest'
import { messageBlocks } from '../src/shared/message'

describe('messageBlocks', () => {
  it('joins a paragraph that was wrapped at 72 columns', () => {
    expect(messageBlocks('The repository view reloads on the same focus event that clears the\nwarning, so the button may already be gone.')).toEqual([
      { kind: 'paragraph', text: 'The repository view reloads on the same focus event that clears the warning, so the button may already be gone.' }
    ])
  })

  it('keeps paragraphs separate', () => {
    expect(messageBlocks('First one.\n\nSecond\none.')).toEqual([
      { kind: 'paragraph', text: 'First one.' },
      { kind: 'paragraph', text: 'Second one.' }
    ])
  })

  it('reads a bulleted list whose items wrap onto indented lines', () => {
    const body = '- BRANCHLINE_GIT names one git to use, for machines with several\n  installed and for tests\n- Fonts fall back\n* Star bullets too'
    expect(messageBlocks(body)).toEqual([
      { kind: 'list', ordered: false, items: ['BRANCHLINE_GIT names one git to use, for machines with several installed and for tests', 'Fonts fall back', 'Star bullets too'] }
    ])
  })

  it('reads a numbered list', () => {
    expect(messageBlocks('1. one\n   continued\n2) two')).toEqual([{ kind: 'list', ordered: true, items: ['one continued', 'two'] }])
  })

  it('separates a lead-in line from the list under it', () => {
    expect(messageBlocks('Changes:\n- a\n- b')).toEqual([
      { kind: 'paragraph', text: 'Changes:' },
      { kind: 'list', ordered: false, items: ['a', 'b'] }
    ])
  })

  it('keeps trailers one per line', () => {
    expect(messageBlocks('Body.\n\nCo-Authored-By: A <a@example.com>\nSigned-off-by: B <b@example.com>')).toEqual([
      { kind: 'paragraph', text: 'Body.' },
      { kind: 'trailers', lines: ['Co-Authored-By: A <a@example.com>', 'Signed-off-by: B <b@example.com>'] }
    ])
  })

  it('does not mistake an ordinary sentence with a colon for a trailer', () => {
    expect(messageBlocks('Note: this wraps\nonto a second line.')).toEqual([{ kind: 'paragraph', text: 'Note: this wraps onto a second line.' }])
  })

  it('leaves indented code exactly as written', () => {
    expect(messageBlocks('Run it like this:\n\n    npm run smoke\n      --flag\n\nThen read the output.')).toEqual([
      { kind: 'paragraph', text: 'Run it like this:' },
      { kind: 'code', text: '    npm run smoke\n      --flag' },
      { kind: 'paragraph', text: 'Then read the output.' }
    ])
  })

  it('handles Windows line endings and an empty body', () => {
    expect(messageBlocks('one\r\ntwo\r\n')).toEqual([{ kind: 'paragraph', text: 'one two' }])
    expect(messageBlocks('')).toEqual([])
    expect(messageBlocks('\n\n')).toEqual([])
  })
})
