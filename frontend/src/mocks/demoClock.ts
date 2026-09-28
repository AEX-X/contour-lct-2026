import type { ISODateTime } from '../domain'

export const DEMO_CLOCK_START: ISODateTime = '2026-09-21T07:00:00.000Z'

export class DemoClock {
  private current: Date

  constructor(initial: ISODateTime = DEMO_CLOCK_START) {
    this.current = new Date(initial)
  }

  now(): ISODateTime {
    return this.current.toISOString()
  }

  advanceMinutes(minutes: number): ISODateTime {
    this.current = new Date(this.current.getTime() + minutes * 60_000)
    return this.now()
  }

  set(iso: ISODateTime): ISODateTime {
    this.current = new Date(iso)
    return this.now()
  }

  reset(): ISODateTime {
    this.current = new Date(DEMO_CLOCK_START)
    return this.now()
  }
}
