"""Pydantic response model for a facility's internal node hierarchy."""

from pydantic import BaseModel, Field


class HierarchyNodeOut(BaseModel):
    """One node of a facility's hierarchy tree.

    ``sensor_count`` contains real linked sensor channels at this node or any
    descendant. ``attention_count`` is the subset with a usable latest state
    of warning, fault, or alarm. ``current_state`` is the worst descendant
    telemetry state; missing or unavailable telemetry is unknown rather than
    an invented fault. ``risk_level`` remains unknown until risks have an
    unambiguous hierarchy-node binding. Tree/path fields are computed from the
    actual adjacency-list data.
    """

    id: str
    parent_id: str | None
    entity_type: str
    entity_id: str
    display_name: str
    path: list[str]
    children_count: int
    sensor_count: int = Field(
        ge=0,
        description="Linked sensor channels at this node or any descendant.",
    )
    attention_count: int = Field(
        ge=0,
        description=(
            "Descendant sensors whose usable latest state is warning, fault, "
            "or alarm; unknown telemetry is not counted as an incident."
        ),
    )
    current_state: str = Field(
        description=(
            "Worst descendant telemetry state: alarm, fault, warning, unknown, "
            "or normal. Unavailable telemetry is unknown."
        )
    )
    risk_level: str = Field(
        description=(
            "Always unknown until risks have an unambiguous hierarchy-node binding."
        )
    )
    has_children: bool
