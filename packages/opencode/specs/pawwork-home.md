# PawWork Home

PawWork Home is the global, user-editable configuration directory for PawWork.
It is separate from runtime app data.

## Priority

Global PawWork configuration is resolved in this order:

1. `PAWWORK_HOME`
2. `PAWWORK_CONFIG_DIR`
3. `~/.pawwork`
4. legacy platform config, `Global.Path.config`

`PAWWORK_CONFIG_DIR` is a legacy compatibility alias. If both environment
variables are set, `PAWWORK_HOME` is the primary write target.

Environment paths support `~/` and `~\` expansion. Relative environment paths
are resolved to absolute paths.

## Files

PawWork reads these user-editable files from PawWork Home candidates:

- `AGENTS.md`
- `pawwork.jsonc`
- `pawwork.json`
- `command/` and `commands/`
- `agent/` and `agents/`
- `skills/`

For `pawwork.jsonc` and `pawwork.json`, PawWork loads the first Home containing
either file. Within that Home, `pawwork.jsonc` wins over `pawwork.json`.

Resource directories such as `command/`, `agent/`, and `skills/` are cumulative
across existing Home candidates. Lower-priority directories are loaded first, so
higher-priority Home entries override same-name legacy entries.

New global writes go only to the primary Home. PawWork does not write new global
configuration to the legacy platform config directory.

One compatibility exception remains: the deprecated legacy TOML file named
`config` under the legacy platform config directory is migrated in place on
read. That migration writes `pawwork.json` in the same legacy platform directory
and removes the old TOML file. Normal PawWork global updates and new writes
still target the primary Home.

## Migration

PawWork does not automatically move legacy files. On first write, it creates the
primary Home and seeds it from the effective legacy global config so existing
settings are not silently dropped.

Users can migrate manually by copying global files from the legacy platform
config directory into `~/.pawwork` or the directory named by `PAWWORK_HOME`.

## Runtime Data

Runtime data stays in platform app-data locations:

- data
- cache
- state
- logs
- bins

These directories do not move into PawWork Home.
