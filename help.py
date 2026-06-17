#!/usr/bin/env python3
import json
import os
import random
import shutil
import shlex
import subprocess
import sys
import time


SASSY_MESSAGES = [
    "任务已完成，请返回 codex 检查",
    "codex 已完成任务，返回输入下一步指令"
]

SASSY_FAIL_MESSAGES = [
    "codex 在执行中发生了一些错误"
]


def _debug_log(message: str) -> None:
    # Support both generic and Codex-specific env var
    path = os.getenv("NOTIFY_DEBUG_LOG", "").strip() or os.getenv("CODEX_NOTIFY_DEBUG_LOG", "").strip()
    if not path:
        return
    try:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {message}\n")
    except Exception:
        pass


def _resolve_executable(*candidates: str) -> str:
    for candidate in candidates:
        if not candidate:
            continue
        if os.path.isabs(candidate) and os.path.exists(candidate):
            return candidate
        found = shutil.which(candidate)
        if found:
            return found
    return ""


def _run(cmd):
    try:
        return subprocess.run(
            cmd,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError as e:
        _debug_log(f"command not found: {cmd[0]} ({e})")
        return None
    except Exception as e:
        _debug_log(f"command failed: {cmd!r} ({e})")
        return None


def _pick_iterm_icon() -> str:
    candidates = [
        "/Applications/iTerm.app/Contents/Resources/iTerm.icns",
        "/Applications/iTerm.app/Contents/Resources/AppIcon.icns",
        "/Applications/iTerm2.app/Contents/Resources/iTerm.icns",
        "/Applications/iTerm2.app/Contents/Resources/AppIcon.icns",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return ""


def _detect_source(payload: dict) -> str:
    """Detect payload source: 'claude' or 'codex' or 'unknown'."""
    # Claude Code Stop hook has hook_event_name field
    if payload.get("hook_event_name"):
        return "claude"
    # Codex has type == "agent-turn-complete"
    if payload.get("type") == "agent-turn-complete":
        return "codex"
    # Fallback: if cwd exists, likely Claude
    if payload.get("cwd"):
        return "claude"
    return "unknown"


def _extract_project_name(payload: dict) -> str:
    """Extract project name from cwd path."""
    cwd = payload.get("cwd", "").strip()
    if not cwd:
        # Try to get from current working directory
        cwd = os.getcwd()
    if cwd:
        # Get the last directory name from path
        project_name = os.path.basename(cwd.rstrip("/\\"))
        if project_name:
            return project_name
    return ""


def _infer_status(payload: dict) -> str:
    if payload.get("success") is True:
        return "success"
    if payload.get("success") is False:
        return "failure"

    status = str(payload.get("status", "")).lower()
    if status in {"success", "ok", "done", "passed", "pass"}:
        return "success"
    if status in {"fail", "failed", "error", "errored", "exception", "panic"}:
        return "failure"

    if payload.get("error") or payload.get("exception"):
        return "failure"

    exit_code = payload.get("exit-code")
    if isinstance(exit_code, int) and exit_code != 0:
        return "failure"

    return ""


def _build_focus_execute_cmd(focus_title: str) -> str:
    # Use universal terminal focus script
    script_path = os.path.join(os.path.dirname(__file__), "focus_terminal.py")
    if not os.path.exists(script_path):
        # Fallback to iTerm2-specific script
        script_path = os.path.join(os.path.dirname(__file__), "focus_iterm2.py")
    python = sys.executable or "python3"
    return f"{shlex.quote(python)} {shlex.quote(script_path)} {shlex.quote(focus_title)}"


def _is_terminal_frontmost() -> bool:
    """Check if any terminal app is frontmost (iTerm2, Terminal, etc.)."""
    script = 'tell application "System Events" to get name of first application process whose frontmost is true'
    osascript = _resolve_executable("/usr/bin/osascript", "osascript")
    if not osascript:
        _debug_log("osascript not found; skip terminal frontmost check")
        return False
    try:
        result = subprocess.run(
            [osascript, "-e", script],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            _debug_log(
                f"osascript frontmost check failed rc={result.returncode} stderr={result.stderr.strip()!r}"
            )
            return False
        name = result.stdout.strip()
        # Support multiple terminal apps
        terminal_apps = {
            "iTerm2", "iTerm",           # iTerm2
            "Terminal",                   # macOS Terminal.app
            "Alacritty",                  # Alacritty
            "kitty",                      # kitty
            "Hyper",                      # Hyper
            "Warp",                       # Warp
            "WezTerm",                    # WezTerm
        }
        return name in terminal_apps
    except Exception as e:
        _debug_log(f"osascript frontmost check exception: {e}")
        return False


def _notify_macos(
    title,
    subtitle,
    message,
    thread_id,
    activate_app,
    sound,
    open_target,
    execute_cmd,
    source="codex",
):
    _debug_log(f"_notify_macos called: title={title!r}, message={message!r}")
    terminal_notifier = _resolve_executable(
        "/opt/homebrew/bin/terminal-notifier",
        "/usr/local/bin/terminal-notifier",
        "terminal-notifier",
    )
    if terminal_notifier:
        # Use source-specific group prefix for notification grouping
        group_prefix = source if source in {"claude", "codex"} else "notify"
        group_name = f"{group_prefix}-{thread_id}" if thread_id else group_prefix
        cmd = [
            terminal_notifier,
            "-title",
            title,
            "-subtitle",
            subtitle,
            "-message",
            message,
            "-group",
            group_name,
        ]
        icon_path = _pick_iterm_icon()
        if icon_path:
            cmd += ["-appIcon", icon_path]
        if execute_cmd:
            cmd += ["-execute", execute_cmd]
        elif open_target:
            cmd += ["-open", open_target]
        if activate_app:
            cmd += ["-activate", activate_app]
        if sound:
            cmd += ["-sound", sound]
        _run(cmd)
        return

    # Fallback 1: macOS Shortcuts (most reliable on macOS 15+)
    shortcuts_cmd = _resolve_executable("/usr/bin/shortcuts", "shortcuts")
    if shortcuts_cmd:
        # Use "AI打工仔凌凌七向您报道！" shortcut
        notify_text = f"{title}\n{subtitle}\n{message}" if subtitle else f"{title}\n{message}"
        _debug_log(f"shortcuts cmd: {notify_text}")
        result = _run([shortcuts_cmd, "run", "AI打工仔凌凌七向您报道！", "-i", notify_text])
        if result and result.returncode == 0:
            return

    # Fallback 2: osascript (may not work on macOS 15+)
    _debug_log("shortcuts failed or not found, trying osascript fallback")
    osascript = _resolve_executable("/usr/bin/osascript", "osascript")
    if not osascript:
        _debug_log("osascript not found; cannot send notification")
        return
    esc_title = title.replace('"', '\\"')
    esc_message = message.replace('"', '\\"')
    esc_subtitle = subtitle.replace('"', '\\"')
    sound_name = sound if sound else "Glass"
    cmd = f'display notification "{esc_message}" with title "{esc_title}" subtitle "{esc_subtitle}" sound name "{sound_name}"'
    _debug_log(f"osascript cmd: {cmd}")
    _run([osascript, "-e", cmd])


def _read_payload() -> dict:
    raw = ""
    if len(sys.argv) >= 2:
        raw = sys.argv[1]
    else:
        try:
            raw = sys.stdin.read()
        except Exception:
            raw = ""

    raw = (raw or "").strip()
    if not raw:
        return {}

    # Allow passing a file path containing JSON payload.
    if len(raw) < 4096 and os.path.isfile(raw):
        try:
            with open(raw, "r", encoding="utf-8") as f:
                raw = f.read().strip()
        except Exception as e:
            _debug_log(f"failed to read payload file {raw!r}: {e}")
            return {}

    try:
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else {}
    except json.JSONDecodeError as e:
        _debug_log(f"invalid json payload: {e} raw={raw[:200]!r}")
        return {}


def main() -> int:
    payload = _read_payload()
    if not payload:
        return 0

    # Detect source: claude or codex
    source = _detect_source(payload)
    _debug_log(f"detected source: {source}, payload keys: {list(payload.keys())}")

    if source == "unknown":
        # For backward compatibility, still require agent-turn-complete for unknown
        if payload.get("type") != "agent-turn-complete":
            return 0

    # Extract project name from cwd
    project_name = _extract_project_name(payload)
    project_suffix = f" [{project_name}]" if project_name else ""

    # Build notification content based on source
    status = _infer_status(payload)
    icon = "🟣" if source == "claude" else "⚡"
    name = "Claude" if source == "claude" else "Codex"

    if status == "failure":
        icon = "🔴" if source == "claude" else "❌"
        title = f"{icon} {name}{project_suffix}"
        message = random.choice(SASSY_FAIL_MESSAGES)
    else:
        title = f"{icon} {name}{project_suffix}"
        message = random.choice(SASSY_MESSAGES)

    subtitle = ""
    thread_id = payload.get("session_id", "") if source == "claude" else payload.get("thread-id", "")

    activate_app = payload.get("activate-app", "com.googlecode.iterm2")

    # Support both generic and Codex-specific env vars
    sound = (payload.get("sound")
             or os.getenv("NOTIFY_SOUND", "").strip()
             or os.getenv("CODEX_NOTIFY_SOUND", "").strip())
    open_target = (payload.get("open")
                   or os.getenv("NOTIFY_OPEN", "").strip()
                   or os.getenv("CODEX_NOTIFY_OPEN", "").strip())
    execute_cmd = (payload.get("execute")
                   or os.getenv("NOTIFY_EXEC", "").strip()
                   or os.getenv("CODEX_NOTIFY_EXEC", "").strip())
    focus_title = (payload.get("focus-title")
                   or os.getenv("NOTIFY_FOCUS_TITLE", "").strip()
                   or os.getenv("CODEX_NOTIFY_FOCUS_TITLE", "").strip())

    if focus_title and not execute_cmd:
        execute_cmd = _build_focus_execute_cmd(focus_title)

    suppress_env = (os.getenv("NOTIFY_SUPPRESS_WHEN_TERMINAL_ACTIVE", "").strip()
                    or os.getenv("NOTIFY_SUPPRESS_WHEN_ITERM_ACTIVE", "").strip()
                    or os.getenv("CODEX_NOTIFY_SUPPRESS_WHEN_ITERM_ACTIVE", "1").strip())
    if suppress_env not in {"0", "false", "False", "no", "NO"}:
        if _is_terminal_frontmost():
            return 0

    _notify_macos(
        title,
        subtitle,
        message,
        thread_id,
        activate_app,
        sound,
        open_target,
        execute_cmd,
        source,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
