"""Regression test for issue #125: ensure the service imports without RabbitMQ env vars set."""

import os
import subprocess
import sys


def test_analytics_service_imports_without_rabbitmq_env():
    env = dict(os.environ)
    for key in (
        "RABBITMQ_URL",
        "RABBITMQ_HOST",
        "RABBITMQ_PORT",
        "RABBITMQ_USER",
        "RABBITMQ_PASSWORD",
    ):
        env.pop(key, None)
    env["POSTGRES_USER"] = "test"
    env["POSTGRES_PASSWORD"] = "test"
    result = subprocess.run(
        [sys.executable, "-c", "import main"],
        cwd=os.path.dirname(os.path.abspath(__file__)),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
