# Instructions for AI agents

## X-Tech standards

- Follow the [Application Standard](https://x-tech-laboratories.github.io/standards/application/) where it applies to a
  library without a UI: TypeScript on Node 24, vitest with a coverage floor that only rises, oxlint, CI through pull requests.
- Use [X-App](https://github.com/x-tech-laboratories/X-App) before writing your own code: check the module table in the
  X-App README first.

## This repository

- Rule sets live in `rulesets/<subject>/<id>.yaml`, in the format of `docs/format.md`. Run `npm run check` after editing one.
- Rule sets written here are `CC-BY-SA-4.0`; an adapted one keeps its origin's licence and attribution in `license` and `source`.
- Code is `GPL-3.0-or-later`.
