import io
import json
import subprocess
import sys

from harvest_analytics import cli


def run(argv, text):
    out = io.StringIO()
    code = cli.main(argv, io.StringIO(text), out)
    return code, out.getvalue()


def test_ping_roundtrip():
    code, out = run(["ping"], '{"a": 1}')
    assert code == 0
    assert json.loads(out)["echo"] == {"a": 1}


def test_unknown_entrypoint_is_rejected_not_executed():
    for name in ["nope", "os.system", "../ping", ""]:
        code, out = run([name], "{}")
        assert code == 2 and out == ""


def test_invalid_json_and_non_object_input():
    assert run(["ping"], "{bad")[0] == 3
    assert run(["ping"], "[1]")[0] == 3


def test_module_invocation_via_subprocess():
    r = subprocess.run([sys.executable, "-m", "harvest_analytics", "ping"], input='{"x": true}', capture_output=True, text=True)
    assert r.returncode == 0
    assert json.loads(r.stdout)["ok"] is True
    bad = subprocess.run([sys.executable, "-m", "harvest_analytics", "ping", "extra"], input="{}", capture_output=True, text=True)
    assert bad.returncode == 2
