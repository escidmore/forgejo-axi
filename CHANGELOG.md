# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as scoped by
[`docs/contract.md`](docs/contract.md): command names, field meanings, enum
values, and exit semantics change only in a major release.

## [1.1.0] - 2026-08-15

### Added

- HOME-relative host credentials from `~/.config/forgejo-axi/hosts.json` for
  daemon-compatible authentication without environment variables.
- Matched `base_url` and `token` resolution with explicit token precedence and
  symlink-compatible Home Manager configuration paths.

### Fixed

- Status history now uses status IDs to break equal-timestamp ties, preventing
  a completed check from being reported as pending.

## [1.0.0] - 2026-08-03

First public release.

### Added

- `pr` command family: `find`, `list`, `view`, `create`, `update`, `checks`,
  `mergeability`, `merge`, `merged`, `reviews`, and `diff`. `create` and
  `update` reconcile existing state instead of duplicating mutations, and
  `merge` requires an expected head SHA.
- `issue` command family: `list`, `view`, `create`, `edit`, `comment`, `close`,
  and `reopen`, with labels and milestones addressed by name and resolved
  before anything is mutated.
- `label` command family: `list`, `create`, `edit`, and `delete`, addressed by
  name with numeric ids resolved for you.
- `run` command family for Actions, gated on runtime capability probing.
- `repo view`, `status`, and a raw `api` escape hatch with `--paginate`.
- TOON output by default and the same data model as JSON with `--json`.
- Capability detection by probing the runtime Swagger document, never by
  inferring features from a version number. Forgejo 15.0.5 and 16.x are both
  supported targets.
- An Agent Skill at `skills/forgejo-axi/SKILL.md`, generated from the CLI's own
  help text and byte-checked against its sources.

[1.1.0]: https://github.com/escidmore/forgejo-axi/releases/tag/v1.1.0
[1.0.0]: https://github.com/escidmore/forgejo-axi/releases/tag/v1.0.0
