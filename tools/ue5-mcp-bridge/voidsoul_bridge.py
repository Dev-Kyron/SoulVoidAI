"""
VoidSoul ↔ Unreal Engine 5 bridge.

Runs *inside* the Unreal Editor and listens on a localhost TCP socket. The
paired VoidSoul MCP server (server.js) connects to it and forwards tool
calls — so an AI agent can drive the editor through proper Python APIs
instead of screen-scraping the UI.

Everything runs on the Slate game thread via a post-tick callback, so any
`unreal.*` API call is safe (read-only or mutating).

Install
-------
1. Copy this file to your project at: <Project>/Content/Python/voidsoul_bridge.py
2. In UE5: Edit → Plugins → enable "Python Editor Script Plugin" (built-in)
   and restart the editor.
3. Either:
   a. Open the Python console (Window → Developer Tools → Python) and run:
          import voidsoul_bridge
          voidsoul_bridge.start()
   b. Or auto-start: Edit → Project Settings → Plugins → Python → "Startup
      Scripts" → add `voidsoul_bridge.py`. The bridge boots when the editor opens.

To stop:
    import voidsoul_bridge
    voidsoul_bridge.stop()

Protocol
--------
Newline-delimited JSON over TCP. One request → one response per line.
Request:  {"op": "<command>", ...params}
Response: {"ok": true,  ...result}
       or {"ok": false, "error": "<message>"}
"""

import contextlib
import io
import json
import socket
import traceback

import unreal

HOST = "127.0.0.1"
PORT = 30011

_server_socket = None
_clients = []  # list of [socket, recv_buf]
_tick_handle = None
_running = False


# --------------------------------------------------------------------------
# Command handlers
# --------------------------------------------------------------------------

def _op_ping(_params):
    return {"ok": True, "msg": "pong", "engine_version": unreal.SystemLibrary.get_engine_version()}


def _op_run_python(params):
    code = params.get("code", "")
    if not isinstance(code, str) or not code.strip():
        return {"ok": False, "error": "Missing or empty 'code' string."}
    buf_out = io.StringIO()
    buf_err = io.StringIO()
    namespace = {"unreal": unreal, "__name__": "voidsoul_bridge_exec"}
    try:
        with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
            exec(compile(code, "<voidsoul>", "exec"), namespace)
        result_value = namespace.get("result")
        return {
            "ok": True,
            "output": buf_out.getvalue().rstrip(),
            "stderr": buf_err.getvalue().rstrip(),
            "result": _stringify(result_value) if result_value is not None else None,
        }
    except Exception:
        return {"ok": False, "error": traceback.format_exc(), "stderr": buf_err.getvalue().rstrip()}


def _op_get_selected_actors(_params):
    try:
        actors = unreal.EditorLevelLibrary.get_selected_level_actors()
        items = []
        for a in actors:
            items.append({
                "label": a.get_actor_label(),
                "path": a.get_path_name(),
                "class": a.get_class().get_name(),
                "location": _vector_dict(a.get_actor_location()),
            })
        return {"ok": True, "actors": items}
    except Exception:
        return {"ok": False, "error": traceback.format_exc()}


def _op_list_assets(params):
    path = params.get("path", "/Game")
    recursive = bool(params.get("recursive", True))
    limit = int(params.get("limit", 200))
    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
        assets = registry.get_assets_by_path(path, recursive)
        out = []
        for a in assets[:limit]:
            out.append({
                "path": str(a.object_path) if hasattr(a, "object_path") else str(a.package_name),
                "class": str(a.asset_class_path.asset_name) if hasattr(a, "asset_class_path") else str(a.asset_class),
                "name": str(a.asset_name),
            })
        return {"ok": True, "assets": out, "truncated": len(assets) > limit, "total": len(assets)}
    except Exception:
        return {"ok": False, "error": traceback.format_exc()}


def _op_level_summary(_params):
    try:
        actors = unreal.EditorLevelLibrary.get_all_level_actors()
        by_class = {}
        for a in actors:
            name = a.get_class().get_name()
            by_class[name] = by_class.get(name, 0) + 1
        top = sorted(by_class.items(), key=lambda kv: -kv[1])[:20]
        level = unreal.EditorLevelLibrary.get_editor_world().get_name()
        return {
            "ok": True,
            "level": level,
            "actor_count": len(actors),
            "top_classes": [{"class": k, "count": v} for k, v in top],
        }
    except Exception:
        return {"ok": False, "error": traceback.format_exc()}


def _op_save_level(_params):
    try:
        unreal.EditorLoadingAndSavingUtils.save_current_level()
        return {"ok": True, "msg": "Current level saved."}
    except Exception:
        return {"ok": False, "error": traceback.format_exc()}


_OPS = {
    "ping": _op_ping,
    "run_python": _op_run_python,
    "get_selected_actors": _op_get_selected_actors,
    "list_assets": _op_list_assets,
    "level_summary": _op_level_summary,
    "save_level": _op_save_level,
}


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _vector_dict(v):
    try:
        return {"x": float(v.x), "y": float(v.y), "z": float(v.z)}
    except Exception:
        return None


def _stringify(value):
    """Best-effort coerce a Python value to a JSON-friendly form."""
    try:
        json.dumps(value)
        return value
    except Exception:
        return repr(value)


# --------------------------------------------------------------------------
# Socket I/O — drained from a Slate post-tick so every API call runs on the
# game thread.
# --------------------------------------------------------------------------

def _accept_new_clients():
    if not _server_socket:
        return
    try:
        conn, _addr = _server_socket.accept()
        conn.setblocking(False)
        _clients.append([conn, b""])
    except BlockingIOError:
        pass
    except Exception:
        pass


def _process_clients():
    for client in list(_clients):
        sock, buf = client
        try:
            data = sock.recv(8192)
            if not data:
                # peer disconnected
                _close_client(client)
                continue
            buf += data
        except BlockingIOError:
            pass
        except (ConnectionResetError, OSError):
            _close_client(client)
            continue

        # Drain complete lines
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            response = _dispatch(line)
            try:
                sock.sendall((json.dumps(response) + "\n").encode("utf-8"))
            except Exception:
                _close_client(client)
                break
        client[1] = buf


def _dispatch(line):
    try:
        payload = json.loads(line.decode("utf-8"))
    except Exception as exc:
        return {"ok": False, "error": "Invalid JSON: " + str(exc)}
    op = payload.get("op")
    handler = _OPS.get(op)
    if not handler:
        return {"ok": False, "error": "Unknown op: " + str(op)}
    try:
        return handler(payload)
    except Exception:
        return {"ok": False, "error": traceback.format_exc()}


def _close_client(client):
    try:
        client[0].close()
    except Exception:
        pass
    if client in _clients:
        _clients.remove(client)


def _on_tick(_delta_seconds):
    if not _running:
        return
    try:
        _accept_new_clients()
        _process_clients()
    except Exception:
        unreal.log_error("VoidSoul bridge tick error:\n" + traceback.format_exc())


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def start():
    """Start the bridge listener and Slate tick. Idempotent."""
    global _server_socket, _running, _tick_handle
    if _running:
        unreal.log("VoidSoul bridge already running.")
        return
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((HOST, PORT))
    except OSError as exc:
        unreal.log_error("VoidSoul bridge could not bind: " + str(exc))
        return
    sock.listen(4)
    sock.setblocking(False)
    _server_socket = sock
    _running = True
    _tick_handle = unreal.register_slate_post_tick_callback(_on_tick)
    unreal.log("VoidSoul bridge listening on " + HOST + ":" + str(PORT))


def stop():
    """Stop the bridge and close all client connections."""
    global _server_socket, _running, _tick_handle
    _running = False
    if _tick_handle is not None:
        try:
            unreal.unregister_slate_post_tick_callback(_tick_handle)
        except Exception:
            pass
        _tick_handle = None
    for client in list(_clients):
        _close_client(client)
    if _server_socket:
        try:
            _server_socket.close()
        except Exception:
            pass
        _server_socket = None
    unreal.log("VoidSoul bridge stopped.")


# Auto-start when imported as a startup script (UE5 imports the module only —
# starting the listener here keeps "add to Startup Scripts" a one-step setup).
if __name__ != "voidsoul_bridge_exec":
    try:
        start()
    except Exception:
        unreal.log_error("VoidSoul bridge autostart failed:\n" + traceback.format_exc())
