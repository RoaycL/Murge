# Normative UI reference

`murge-ui-preview.html` is the owner-approved interactive visual reference for the framework milestone.

## Authority

For visual implementation, use sources in this order:

1. `murge-ui-preview.html` for geometry, spacing, card composition, navigation hierarchy and visual state.
2. `../UI_SPEC.md` for written dimensions, behavior and accessibility requirements.
3. Existing Vue/CSS source only when it agrees with the two references above.

If the implementation and reference disagree, the reference wins unless the owner explicitly approves a change.

## Contributor rules

- Open the reference and inspect every relevant route before implementing a page.
- Do not invent alternative dashboards, cards, colors, navigation groups or spacing.
- Preserve the 934×672 reference canvas and fixed internal proportions.
- Do not copy the temporary HTML implementation directly into production components without adapting semantics, accessibility and application architecture.
- Fixture values may differ, but their length and density should exercise the same layout.
- Any intentional visual deviation must be listed in the pull request with its reason and an owner-approval link.
- UI pull requests must include a 934×672 screenshot beside the corresponding reference state.

## Integrity

Imported reference SHA-256:

```text
396a59abd9130c601971ac065055ffefc65ab4bb31fee03ee46b82eecdec745b
```

Update this hash when, and only when, the owner approves a new reference version.
