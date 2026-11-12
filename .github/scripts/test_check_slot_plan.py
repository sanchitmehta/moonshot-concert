import unittest

from check_slot_plan import protected_changes


def change(resource_type, actions, name="main"):
    return {
        "mode": "managed",
        "type": resource_type,
        "address": f"{resource_type}.{name}",
        "change": {"actions": actions},
    }


class SlotPlanTests(unittest.TestCase):
    def test_allows_staging_configuration_changes_with_unchanged_production(self):
        plan = {
            "resource_changes": [
                change("azurerm_linux_web_app", ["no-op"], "storefront"),
                change("azurerm_service_plan", ["no-op"]),
                change("azurerm_linux_web_app_slot", ["update"], "staging"),
            ]
        }
        self.assertEqual(protected_changes(plan), [])

    def test_blocks_production_configuration_updates(self):
        for app in ("api", "storefront"):
            with self.subTest(app=app):
                update = change("azurerm_linux_web_app", ["update"], app)
                self.assertEqual(protected_changes({"resource_changes": [update]}), [update])

    def test_blocks_production_creation_deletion_and_replacement(self):
        for actions in (["create"], ["delete"], ["delete", "create"], ["create", "delete"]):
            with self.subTest(actions=actions):
                update = change("azurerm_linux_web_app", actions)
                self.assertEqual(protected_changes({"resource_changes": [update]}), [update])

    def test_blocks_service_plan_changes(self):
        update = change("azurerm_service_plan", ["update"])
        self.assertEqual(protected_changes({"resource_changes": [update]}), [update])

    def test_allows_other_infrastructure_changes_and_empty_plans(self):
        plan = {"resource_changes": [change("aws_vpc_security_group_ingress_rule", ["create"])]}
        self.assertEqual(protected_changes(plan), [])
        self.assertEqual(protected_changes({}), [])


if __name__ == "__main__":
    unittest.main()
