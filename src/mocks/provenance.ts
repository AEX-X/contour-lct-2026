import type { DataOrigin, DataProvenance, ISODateTime } from '../domain'

export function syntheticProvenance(
  origin: DataOrigin,
  sourceLabel: string,
  asOf: ISODateTime | null,
  note = 'Синтетические данные для демонстрации интерфейса Contour',
): DataProvenance {
  return {
    origin,
    environment: 'synthetic_demo',
    sourceLabel,
    asOf,
    note,
  }
}
