import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Facility } from '../domain'
import { FacilityTable } from './CityPage'

function makeFacility(index: number): Facility {
  return {
    id: `facility-${index}`,
    version: 1,
    name: `Объект ${index}`,
    address: `Адрес ${index}`,
    internalCode: String(index),
    rostaCode: null,
    operationalUnitId: 'api-scope',
    status: 'normal',
    statusReason: 'Норма',
    position: null,
    responsibleDispatcherId: null,
    sensorAvailability: 0.5,
    updatedAt: '2026-09-28T12:00:00Z',
    provenance: {
      origin: 'observed',
      environment: 'real',
      sourceLabel: 'Backend Contour',
      asOf: '2026-09-28T12:00:00Z',
    },
  }
}

describe('FacilityTable', () => {
  it('paginates a large facility list and explains the coverage metric', async () => {
    const facilities = Array.from({ length: 78 }, (_, index) => makeFacility(index + 1))
    const operationalByFacility = new Map(
      facilities.map((facility) => [facility.id, { state: 'normal' as const, reason: 'Норма' }]),
    )
    const onPageChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <FacilityTable
        facilities={facilities}
        operationalByFacility={operationalByFacility}
        selectedId={null}
        page={1}
        pageSize={20}
        onPageChange={onPageChange}
        onSelect={vi.fn()}
      />,
    )

    expect(screen.getByText('Объект 1')).toBeInTheDocument()
    expect(screen.getByText('Объект 20')).toBeInTheDocument()
    expect(screen.queryByText('Объект 21')).not.toBeInTheDocument()
    expect(screen.getByText('1-20 из 78')).toBeInTheDocument()
    expect(screen.getByText(/не свежесть данных или текущую связь/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(onPageChange).toHaveBeenCalledWith(2)

    rerender(
      <FacilityTable
        facilities={facilities}
        operationalByFacility={operationalByFacility}
        selectedId={null}
        page={4}
        pageSize={20}
        onPageChange={onPageChange}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByText('Объект 61')).toBeInTheDocument()
    expect(screen.getByText('Объект 78')).toBeInTheDocument()
    expect(screen.getByText('61-78 из 78')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Далее' })).toBeDisabled()
  })
})
