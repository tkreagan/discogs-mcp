import { describe, it, expect } from 'vitest'
import { extractSemanticFilterTerms, shouldUseBroadSearch } from '../../../src/mcp/tools/authenticated'

describe('extractSemanticFilterTerms', () => {
	it('strips common stop words and returns meaningful terms', () => {
		expect(extractSemanticFilterTerms('empowering female vocals')).toEqual(['empowering', 'female', 'vocals'])
	})

	it('strips leading/trailing stop words', () => {
		expect(extractSemanticFilterTerms('something for a rainy day')).toEqual(['rainy', 'day'])
	})

	it('strips all stop words from a fully-stop-word query', () => {
		expect(extractSemanticFilterTerms('something with a lot of the')).toEqual(['lot'])
	})

	it('returns single meaningful word', () => {
		expect(extractSemanticFilterTerms('instrumental')).toEqual(['instrumental'])
	})

	it('strips short words (length <= 2) that are not stop words', () => {
		expect(extractSemanticFilterTerms('upbeat music to go')).toEqual(['upbeat', 'music'])
	})

	it('handles mixed case', () => {
		expect(extractSemanticFilterTerms('Upbeat Female Vocals')).toEqual(['upbeat', 'female', 'vocals'])
	})

	it('handles road trip type queries', () => {
		expect(extractSemanticFilterTerms('good road trip music')).toEqual(['good', 'road', 'trip', 'music'])
	})

	it('returns empty array for all-stop-word query', () => {
		expect(extractSemanticFilterTerms('the a an')).toEqual([])
	})
})

describe('shouldUseBroadSearch', () => {
	it('returns true for "search more broadly"', () => {
		expect(shouldUseBroadSearch('search more broadly')).toBe(true)
	})

	it('returns true for "show more"', () => {
		expect(shouldUseBroadSearch('show more')).toBe(true)
	})

	it('returns true for "full collection"', () => {
		expect(shouldUseBroadSearch('full collection')).toBe(true)
	})

	it('returns true for "broader search"', () => {
		expect(shouldUseBroadSearch('broader search')).toBe(true)
	})

	it('returns true for "show everything"', () => {
		expect(shouldUseBroadSearch('show everything')).toBe(true)
	})

	it('returns true for "show all"', () => {
		expect(shouldUseBroadSearch('show all')).toBe(true)
	})

	it('returns false for a normal semantic query', () => {
		expect(shouldUseBroadSearch('empowering female vocals')).toBe(false)
	})

	it('returns false for a mood query', () => {
		expect(shouldUseBroadSearch('something for a rainy Sunday')).toBe(false)
	})

	it('is case-insensitive', () => {
		expect(shouldUseBroadSearch('Search More Broadly')).toBe(true)
	})

	it('returns false when broad phrase is embedded in a real query', () => {
		expect(shouldUseBroadSearch('show all Miles Davis')).toBe(false)
	})

	it('returns false for "show all jazz albums"', () => {
		expect(shouldUseBroadSearch('show all jazz albums')).toBe(false)
	})

	it('returns true when broad phrase has trailing punctuation', () => {
		expect(shouldUseBroadSearch('show everything!')).toBe(true)
	})

	it('returns true for "please show more" with filler words', () => {
		expect(shouldUseBroadSearch('please show more')).toBe(true)
	})

	it('returns true for "can you search more broadly?"', () => {
		expect(shouldUseBroadSearch('can you search more broadly?')).toBe(true)
	})
})
