"""Pydantic response models for sensor list/detail (ticket 05).

current_state/data_health/forecast_summary/maintenance_state are honest
MVP placeholders (see PLAN.md): real values need ticket 08 (risk) and a
real health-scoring pass that is out of scope here.
"""

from datetime import datetime

from pydantic import BaseModel, Field


class CurrentReading(BaseModel):
    """The most recent reading for a sensor, if any exist yet."""

    value: str
    numeric_value: float | None
    unit: str | None
    measured_at: datetime


class SensorOut(BaseModel):
    """A sensor channel and its latest available telemetry snapshot."""

    id: str
    channel_id: str
    tag: str
    sensor_type: str
    system_type: str
    value_type: str
    display_name: str
    facility_id: str | None
    hierarchy_node_id: str | None
    has_geolocation: bool = False
    position: None = None
    current_reading: CurrentReading | None = None
    current_state: str = "unknown"
    data_health: str = "unavailable"


class SensorDetailOut(SensorOut):
    """The full sensor detail card (superset of the list item shape)."""

    hierarchy_path: list[str] = Field(
        description=(
            "User-facing display names from the facility root to the sensor; "
            "internal hierarchy ids are exposed by hierarchy_node_id instead."
        )
    )
    forecast_summary: str | None
    maintenance_state: str


class SensorListMeta(BaseModel):
    """Cursor-pagination metadata for the sensor list envelope."""

    next_cursor: str | None
    total: int
    generated_at: datetime


class SensorListEnvelope(BaseModel):
    """The standard {data, meta} envelope for GET /api/v1/sensors."""

    data: list[SensorOut]
    meta: SensorListMeta
