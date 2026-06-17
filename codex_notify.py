#!/usr/bin/env python3
import json
import subprocess
import sys


def load_event() -> dict:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def build_message(event: dict) -> str:
    success = event.get("success")
    if success is False:
        return "Codex 未能完成当前任务，请检查终端输出与执行日志。"
    return "Codex 已完成当前任务，请审阅本次执行结果。"


def main() -> int:
    event = load_event()
    message = build_message(event)
    result = subprocess.run(
        ["shortcuts", "run", "codex notice", "-i", message],
        check=False,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
