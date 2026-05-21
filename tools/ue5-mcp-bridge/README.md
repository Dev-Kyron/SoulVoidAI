# VoidSoul ↔ Unreal Engine 5 MCP bridge

Two halves that talk to each other:

| Where it lives | What it does |
| --- | --- |
| `voidsoul_bridge.py` — copy into your **UE5 project** | Runs inside the editor on the game thread. Listens on `127.0.0.1:30011` for JSON commands and executes them against the `unreal` Python API. |
| `server.js` — stays in this folder | A small MCP server that VoidSoul spawns. Forwards `tools/call` requests over TCP to the bridge inside UE5. |

When both are running, the AI agent in VoidSoul gains six new tools — `ping`, `run_python`, `get_selected_actors`, `list_assets`, `level_summary`, `save_level` — and `run_python` is the trapdoor to *all* of UE5's Editor Python API.

## Setup (one-time)

### 1. Enable the Python plugin in UE5

1. **Edit → Plugins**, search **Python Editor Script Plugin**, tick **Enabled**.
2. Restart the editor when prompted.

### 2. Install the bridge into your UE5 project

Copy `voidsoul_bridge.py` to:

```
<YourProject>/Content/Python/voidsoul_bridge.py
```

If the `Content/Python` folder doesn't exist, create it.

### 3. (Recommended) Auto-start the bridge with the editor

**Edit → Project Settings → Plugins → Python**, scroll to **Startup Scripts**, click **+**, set the value to:

```
voidsoul_bridge.py
```

From now on, every time you open the project, the bridge starts itself and logs `VoidSoul bridge listening on 127.0.0.1:30011` to the Output Log.

> Or, manually each session: open **Window → Developer Tools → Python**, then run:
> ```python
> import voidsoul_bridge
> ```
> (It auto-starts on import.)

### 4. Add the MCP server to VoidSoul

**Settings → MCP Servers → + Add MCP server**:

| Field | Value |
| --- | --- |
| Name | `UE5` |
| Command | `node` |
| Args | `<absolute path>\VoidSoulAssistant\tools\ue5-mcp-bridge\server.js` |

Click **Add & start**. If UE5 is open and the bridge is running, the row goes green and you'll see six new tools.

## Verify it works

In a chat with Agent mode on:

> *Ping the UE5 bridge.*

Claude/GPT will call `mcp_ue5_ping` and you'll get back `pong` + your engine version.

> *Give me a level summary.*

Returns `{ level, actor_count, top_classes: [...] }`.

> *List all assets under `/Game/Characters`.*

> *Run this Python: spawn a `StaticMeshActor` at the origin called "TestPin".*

The agent will compose the right Python and call `mcp_ue5_run_python`.

## What you'll see in the UE5 Output Log

- `VoidSoul bridge listening on 127.0.0.1:30011` — bridge is up.
- `VoidSoul bridge already running.` — `start()` was called twice; harmless.
- Errors from your `run_python` code surface here too (and in the MCP response).

## Stopping the bridge

In the Python console:

```python
import voidsoul_bridge
voidsoul_bridge.stop()
```

Or just close the editor — the listener dies with the process.

## Troubleshooting

**MCP row stays red in VoidSoul.** UE5 isn't running, or the bridge wasn't started. Open UE5, then click the reconnect icon on the row.

**"Couldn't reach the UE5 bridge at 127.0.0.1:30011"** — same cause. Confirm the **Output Log** in UE5 shows the "VoidSoul bridge listening" line.

**Port conflict.** Set environment variables before spawning:
```
VOIDSOUL_UE5_PORT=30099
```
…and edit the constant at the top of `voidsoul_bridge.py` to match.

**Mutation operations hang or crash.** Some `unreal.*` calls really do need the game thread. The bridge runs every command on the Slate post-tick callback, so this should be safe — if you hit it anyway, wrap your code with `unreal.SystemLibrary.execute_console_command(world, "...")` or use the EditorActorSubsystem for actor mutations.

**Versions tested.** UE5.3, UE5.4. Older 5.x should mostly work; the `EditorLevelLibrary` and `AssetRegistryHelpers` APIs have been stable.
