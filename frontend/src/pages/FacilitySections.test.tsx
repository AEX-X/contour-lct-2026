import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Equipment, Facility, HierarchyNode, Sensor } from '../domain'
import { FacilityPlanSection } from './FacilitySections'

const provenance = {
  origin: 'observed' as const,
  environment: 'real' as const,
  sourceLabel: 'Backend Contour',
  asOf: null,
}

const facility: Facility = {
  id: 'facility-1', version: 1, name: 'Коллектор № 1', address: 'Адрес не предоставлен', internalCode: '1',
  rostaCode: null, operationalUnitId: 'api-scope', status: 'no_data', statusReason: 'Состояние не рассчитано',
  position: null, responsibleDispatcherId: null, sensorAvailability: 0, updatedAt: '2026-09-28T12:00:00Z', provenance,
}

const hierarchy: HierarchyNode[] = [
  {
    id: 'node_facility_1', facilityId: facility.id, parentId: null, entityType: 'facility', entityId: facility.id,
    displayName: facility.name, path: ['node_facility_1'], planPosition: { planId: 'demo', x: 20, y: 20, level: '0' }, provenance,
  },
  {
    id: 'node_equipment_1', facilityId: facility.id, parentId: 'node_facility_1', entityType: 'equipment', entityId: 'equipment-1',
    displayName: 'Температурный контроль', path: ['node_facility_1', 'node_equipment_1'], planPosition: { planId: 'demo', x: 50, y: 50, level: '1' }, provenance,
  },
  {
    id: 'node_sensor_1', facilityId: facility.id, parentId: 'node_equipment_1', entityType: 'sensor', entityId: 'sensor-1',
    displayName: 'Датчик температуры', path: ['node_facility_1', 'node_equipment_1', 'node_sensor_1'], planPosition: { planId: 'demo', x: 60, y: 60, level: '2' }, provenance,
  },
]

const equipment: Equipment = {
  id: 'equipment-1', version: 1, facilityId: facility.id, hierarchyNodeId: 'node_equipment_1', name: 'Температурный контроль',
  categoryCode: 'equipment', model: null, serialNumber: null, commissionedAt: null, status: 'unknown', lastMaintenanceAt: null, provenance,
}

const sensor: Sensor = {
  id: 'sensor-1', version: 1, facilityId: facility.id, hierarchyNodeId: 'node_sensor_1', equipmentId: equipment.id,
  name: 'Датчик температуры', kind: 'temperature', unit: '°C', status: 'unknown', lastReading: null,
  warningThreshold: null, alarmThreshold: null, readings: [], updatedAt: null, provenance,
}

describe('FacilityPlanSection', () => {
  it('shows display names, an honest unknown state and no epoch for a sensor without readings', async () => {
    const user = userEvent.setup()
    render(
      <FacilityPlanSection
        facility={facility}
        hierarchy={hierarchy}
        equipment={[equipment]}
        sensors={[sensor]}
        risks={[]}
        orders={[]}
        canCreate={false}
        onCreateForTarget={vi.fn()}
        targets={[]}
      />,
    )

    await user.click(screen.getAllByRole('button', { name: /Датчик температуры/ })[0]!)

    expect(screen.getByText('Коллектор № 1 / Температурный контроль / Датчик температуры')).toBeInTheDocument()
    expect(screen.getAllByText('Состояние не рассчитано').length).toBeGreaterThan(0)
    expect(screen.getByText('Не поступало')).toBeInTheDocument()
    expect(screen.queryByText(/node_(?:facility|equipment|sensor)/)).not.toBeInTheDocument()
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument()
  })
})
