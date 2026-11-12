import json
import sys


def protected_changes(plan):
    return [
        change
        for change in plan.get("resource_changes", [])
        if change["mode"] == "managed"
        and change["type"] in ("azurerm_linux_web_app", "azurerm_service_plan")
        and change["change"]["actions"] != ["no-op"]
    ]


if __name__ == "__main__":
    changes = protected_changes(json.load(sys.stdin))
    if changes:
        details = "\n".join(
            f"- {change['address']}: {', '.join(change['change']['actions'])}"
            for change in changes
        )
        sys.exit(
            "Release blocked: this plan changes production web apps or service plans.\n"
            f"{details}\n"
            "Use the Terraform workflow with allow_production_changes during a maintenance window."
        )
    print("Production web apps and service plans are unchanged.")
