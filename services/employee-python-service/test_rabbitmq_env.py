"""Regression tests for issue #125: services must import without RABBITMQ_* env vars set."""

import os
import subprocess
import sys


def _import_main_without_rabbitmq_env():
    env = dict(os.environ)
    for key in (
        "RABBITMQ_URL",
        "RABBITMQ_HOST",
        "RABBITMQ_PORT",
        "RABBITMQ_USER",
        "RABBITMQ_PASSWORD",
    ):
        env.pop(key, None)
    env["MONGO_USER"] = "test"
    env["MONGO_PASSWORD"] = "test"
    return subprocess.run(
        [sys.executable, "-c", "import main"],
        cwd=os.path.dirname(os.path.abspath(__file__)),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_employee_service_imports_without_rabbitmq_env():
    result = _import_main_without_rabbitmq_env()
    assert result.returncode == 0, result.stderr
