# ADR 0005 — Recipes express relationships, never UI

## Decision

Recipes may contain narrative stages and abstract composition moves only. Runtime guards reject UI-specific keys.

## Consequence

A Recipe cannot legally define Hero/Card/Button variants, colors, radii, font families, classes or CSS. Visual implementation remains local.
