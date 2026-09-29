"""The fixed capability-string catalogue (single source of truth).

See `BACKEND_REQUIREMENTS_FROM_FRONTEND_TZ.md` section 3 and
`docs/adr/0002-capability-scope-rbac-with-district-level.md`: authorization
is done through these permission strings plus a resolved scope, never
through a hardcoded role name.
"""

PERMISSIONS: frozenset[str] = frozenset(
    {
        "facility.read.all",
        "facility.read.assigned",
        "facility.read.temporary",
        "facility.technical_context.read",
        "facility.dispatcher.assign",
        "sensor.read",
        "risk.read",
        "risk.acknowledge",
        "risk.resolve",
        "risk.confirm",
        "work_order.read",
        "work_order.create_draft",
        "work_order.create",
        "work_order.edit_draft",
        "work_order.submit",
        "work_order.triage",
        "work_order.request_clarification",
        "work_order.priority.propose",
        "work_order.priority.finalize",
        "work_order.sla.finalize",
        "work_order.assign_engineer",
        "work_order.reassign_engineer",
        "work_order.accept_assignment",
        "work_order.decline_assignment",
        "work_order.execute",
        "work_order.submit_result",
        "work_order.verify",
        "work_order.return_for_rework",
        "work_order.close",
        "work_order.cancel",
        "work_order.override",
        "work_order.costs.read",
        "work_order.costs.write",
        "engineer_workload.read",
        "engineer_assignment.manage",
        "analytics.read.summary",
        "analytics.read.technical",
        "analytics.city.read",
        "analytics.facility.read",
        "analytics.management.read",
        "analytics.economy.read",
        "offline_package.download",
        "offline_mutation.sync",
        "notification.read",
        "notification.preferences.manage",
        "report.export",
        "system.manage",
        "audit.read",
    }
)


def is_valid_permission(permission: str) -> bool:
    """Check whether a permission string is part of the fixed catalogue.

    Args:
        permission: The permission string to validate.

    Returns:
        True if the permission is a known capability string.
    """
    return permission in PERMISSIONS
