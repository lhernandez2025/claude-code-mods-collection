import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bestMatch, keywords, normalize, rank, similarity, stem, wordSimilarity } from '../src/smart/text.js'

const items = (...texts) => texts.map((text, i) => ({ id: i + 1, text }))

describe('text', () => {
  test('normalizes accents, case and punctuation', () => {
    assert.equal(normalize('  Añade   TESTS, ¡ya!  '), 'anade tests ya')
    assert.deepEqual(keywords('remove the task about the README'), ['remove', 'readme'])
    assert.deepEqual(keywords('quita lo de los tests'), ['quita', 'tests'])
  })

  test('stems common English and Spanish endings', () => {
    assert.equal(stem('adding'), 'add')
    assert.equal(stem('tests'), 'test')
    assert.equal(stem('actualizando'), 'actualiz')
    assert.equal(stem('go'), 'go')
  })

  test('scores related words', () => {
    assert.equal(wordSimilarity('tests', 'tests'), 1)
    assert.equal(wordSimilarity('adding', 'add'), 0.9)
    assert.equal(wordSimilarity('anadir', 'anade'), 0.8)
    assert.equal(wordSimilarity('readme', 'read'), 0.8)
    assert.equal(wordSimilarity('ab', 'abc'), 0)
    assert.equal(wordSimilarity('deploy', 'tests'), 0)
  })

  test('matches descriptions to tasks', () => {
    assert.ok(similarity('adding tests', 'add tests') > 0.9)
    assert.ok(similarity('tests', 'add unit tests for the parser') > 0.7)
    assert.equal(similarity('the', 'add tests'), 0)
    assert.equal(rank('readme', items('add tests', 'update the README'))[0].item.id, 2)
  })

  test('bestMatch refuses weak or ambiguous matches', () => {
    assert.equal(bestMatch('tests', items('add tests', 'update README')).item.id, 1)
    assert.equal(bestMatch('tests', items('add unit tests', 'fix failing tests')), null)
    assert.equal(bestMatch('deploy', items('add tests')), null)
  })
})
