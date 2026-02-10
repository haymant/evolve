import os
from ls.server import LSPServer


def test_set_preserve_run_dirs_sets_env_and_responds(capsys):
    s = LSPServer()
    msg = {"params": {"command": "evolve.setPreserveRunDirs", "arguments": [{"preserve": True}]}, "id": 1}
    s.handle_workspace_executeCommand(msg)
    # capture stdout response
    captured = capsys.readouterr()
    assert os.environ.get("EVOLVE_PRESERVE_RUNS") == "1"
    assert '"preserve": true' in captured.out

    msg2 = {"params": {"command": "evolve.setPreserveRunDirs", "arguments": [{"preserve": False}]}, "id": 2}
    s.handle_workspace_executeCommand(msg2)
    captured = capsys.readouterr()
    assert os.environ.get("EVOLVE_PRESERVE_RUNS") is None
    assert '"preserve": false' in captured.out
