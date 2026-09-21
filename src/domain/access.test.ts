import { describe, expect, it } from 'vitest'
import { canAccessFacility } from './access'
import { createDemoSeed } from '../mocks'

describe('scope policy', () => {
  it('keeps manager, senior dispatcher and facility dispatcher scopes separate', () => {
    const state = createDemoSeed()
    const manager = state.users['user-manager']!
    const senior = state.users['user-senior']!
    const dispatcher = state.users['user-dispatcher']!
    const engineer = state.users['user-engineer']!

    expect(canAccessFacility(state, manager, 'fac-007')).toBe(true)
    expect(canAccessFacility(state, senior, 'fac-002')).toBe(true)
    expect(canAccessFacility(state, senior, 'fac-004')).toBe(false)
    expect(canAccessFacility(state, dispatcher, 'fac-001')).toBe(true)
    expect(canAccessFacility(state, dispatcher, 'fac-002')).toBe(false)
    expect(canAccessFacility(state, engineer, 'fac-001')).toBe(false)
  })
})
