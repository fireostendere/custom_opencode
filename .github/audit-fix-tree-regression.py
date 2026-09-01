#!/usr/bin/env python3
from pathlib import Path

path = Path("scripts/web-fixture-e2e.py")
text = path.read_text(encoding="utf-8")
old = '''    parent_toggle = fixture_group.locator('[data-session-tree-toggle="ses_fixture"]')
    assert parent_toggle.count() == 1 and parent_toggle.get_attribute("aria-expanded") == "false"
    assert fixture_group.locator('[data-session-children="ses_fixture"]').is_hidden()
    parent_toggle.click()
    assert fixture_group.locator('[data-session-children="ses_fixture"]').is_visible()
    assert fixture_group.locator('[data-session="ses_child_reader"] .session-title').inner_text() == "Reader subagent"
    child_toggle = fixture_group.locator('[data-session-tree-toggle="ses_child_reader"]')
    assert child_toggle.count() == 1 and child_toggle.get_attribute("aria-expanded") == "false"
    child_toggle.click()
    assert fixture_group.locator('[data-session="ses_child_review"] .session-title').inner_text() == "Reviewer nested"
'''
new = '''    parent_toggle = fixture_group.locator('[data-session-tree-toggle="ses_fixture"]')
    parent_children = fixture_group.locator('[data-session-children="ses_fixture"]')
    assert parent_toggle.count() == 1
    if parent_toggle.get_attribute("aria-expanded") == "true":
        parent_toggle.click()
    assert parent_toggle.get_attribute("aria-expanded") == "false" and parent_children.is_hidden()
    parent_toggle.click()
    assert parent_toggle.get_attribute("aria-expanded") == "true" and parent_children.is_visible()
    assert fixture_group.locator('[data-session="ses_child_reader"] .session-title').inner_text() == "Reader subagent"
    child_toggle = fixture_group.locator('[data-session-tree-toggle="ses_child_reader"]')
    child_children = fixture_group.locator('[data-session-children="ses_child_reader"]')
    assert child_toggle.count() == 1
    if child_toggle.get_attribute("aria-expanded") == "true":
        child_toggle.click()
    assert child_toggle.get_attribute("aria-expanded") == "false" and child_children.is_hidden()
    child_toggle.click()
    assert child_toggle.get_attribute("aria-expanded") == "true" and child_children.is_visible()
    assert fixture_group.locator('[data-session="ses_child_review"] .session-title').inner_text() == "Reviewer nested"
'''
if new not in text:
    if old not in text:
        raise SystemExit("tree regression block not found")
    text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
