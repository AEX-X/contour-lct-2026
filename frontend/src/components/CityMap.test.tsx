import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Facility } from '../domain'
import { CITY_MAP_MARKER_LIMIT, CityMap } from './CityMap'

function makeFacility(index: number): Facility {
  return {
    id: `facility-${index}`,
    version: 1,
    name: `Объект ${String(index).padStart(2, '0')}`,
    address: `Адрес ${index}`,
    internalCode: String(index),
    rostaCode: null,
    operationalUnitId: 'api-scope',
    status: index === 78 ? 'critical' : 'normal',
    statusReason: index === 78 ? 'Критический инцидент' : 'Норма',
    position: { lon: 37.55 + index / 1000, lat: 55.7 + index / 1000 },
    responsibleDispatcherId: null,
    sensorAvailability: 0.5,
    updatedAt: '2026-09-28T12:00:00Z',
    provenance: {
      origin: 'observed',
      environment: 'synthetic_demo',
      sourceLabel: 'Backend Contour',
      asOf: '2026-09-28T12:00:00Z',
      note: 'Координаты демонстрационные',
    },
  }
}

describe('CityMap', () => {
  it('limits and clusters dense demo geometry while keeping the selected facility reachable', async () => {
    const facilities = Array.from({ length: 78 }, (_, index) => makeFacility(index + 1))
    const user = userEvent.setup()

    render(
      <CityMap
        facilities={facilities}
        risks={[]}
        incidents={[]}
        asOf="2026-09-28T12:00:00Z"
        selectedId="facility-78"
        onSelect={vi.fn()}
      />,
    )

    expect(screen.getAllByRole('button').length).toBeLessThanOrEqual(CITY_MAP_MARKER_LIMIT)
    expect(screen.getByRole('button', { name: /Объект 78/ })).toBeInTheDocument()
    expect(screen.getByText(`Показаны ${CITY_MAP_MARKER_LIMIT} из 78 объектов`, { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Демонстрационная геометрия')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Группа из/ }))
    expect(screen.getByRole('group', { name: /Объекты в группе/ })).toBeInTheDocument()
    expect(screen.getByText(/Полный перечень доступен/)).toBeInTheDocument()
  })
})
