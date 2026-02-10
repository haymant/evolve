from __future__ import annotations

import json
import os
import sys
from urllib.parse import urlparse, unquote
from typing import Any, Dict, Optional

repo_root = os.path.dirname(os.path.dirname(__file__))
if repo_root not in sys.path:
    sys.path.insert(0, repo_root)

from enginepy.pnml_parser import extract_place_index
from enginepy.project_gen import generate_python_project


class LSPServer:
    def __init__(self) -> None:
        self.seq = 1
        self.documents: Dict[str, str] = {}

    def run(self) -> None:
        while True:
            message = self._read_message()
            if message is None:
                break
            if message.get("method") == "exit":
                break
            if message.get("method") == "shutdown":
                self._send_response(message, None)
                continue
            if message.get("method") == "initialize":
                self._handle_initialize(message)
                continue
            method = message.get("method")
            handler = getattr(self, f"handle_{method.replace('/', '_')}", None)
            if handler:
                handler(message)
            elif message.get("id") is not None:
                self._send_response(message, None)

    def _handle_initialize(self, message: Dict[str, Any]) -> None:
        capabilities = {
            "textDocumentSync": 1,
            "documentSymbolProvider": True,
            "executeCommandProvider": {"commands": ["evolve.places", "evolve.generatePython", "evolve.setPreserveRunDirs"]},
        }
        self._send_response(message, {"capabilities": capabilities})

    def handle_textDocument_didOpen(self, message: Dict[str, Any]) -> None:
        params = message.get("params", {})
        doc = params.get("textDocument", {})
        uri = doc.get("uri")
        text = doc.get("text", "")
        if uri:
            self.documents[uri] = text

    def handle_textDocument_didChange(self, message: Dict[str, Any]) -> None:
        params = message.get("params", {})
        uri = params.get("textDocument", {}).get("uri")
        changes = params.get("contentChanges", [])
        if uri and changes:
            self.documents[uri] = changes[-1].get("text", "")

    def handle_textDocument_documentSymbol(self, message: Dict[str, Any]) -> None:
        params = message.get("params", {})
        uri = params.get("textDocument", {}).get("uri")
        text = self.documents.get(uri or "", "")
        symbols = []
        for place in extract_place_index(text):
            if place.id is None:
                continue
            symbols.append({
                "name": place.id,
                "kind": 12,
                "range": {
                    "start": {"line": place.start_line, "character": 0},
                    "end": {"line": place.end_line, "character": 0},
                },
                "selectionRange": {
                    "start": {"line": place.id_line, "character": 0},
                    "end": {"line": place.id_line, "character": 0},
                },
            })
        self._send_response(message, symbols)

    def handle_workspace_executeCommand(self, message: Dict[str, Any]) -> None:
        params = message.get("params", {})
        command = params.get("command")
        if command == "evolve.places":
            uri = params.get("arguments", [{}])[0].get("uri")
            text = self.documents.get(uri or "", "")
            result = [
                {
                    "id": place.id,
                    "idLine": place.id_line,
                    "startLine": place.start_line,
                    "endLine": place.end_line,
                }
                for place in extract_place_index(text)
            ]
            self._send_response(message, result)
        elif command == "evolve.generatePython":
            args = params.get("arguments", [{}])[0]
            uri = args.get("uri")
            workspace_root = args.get("workspaceRoot")
            text = self.documents.get(uri or "", "")
            module_dir = ""
            if uri:
                parsed = urlparse(uri)
                if parsed.scheme == "file":
                    file_path = unquote(parsed.path)
                    if not text and os.path.exists(file_path):
                        with open(file_path, "r", encoding="utf-8") as f:
                            text = f.read()
                    base = os.path.splitext(os.path.basename(file_path))[0]
                    workspace = workspace_root or os.path.dirname(os.path.dirname(file_path))
                    out_dir = os.path.join(workspace, ".vscode", "evolve_py")
                    module_dir = generate_python_project(text, out_dir, source_name=base)
            self._send_response(message, {"moduleDir": module_dir})
        elif command == "evolve.setPreserveRunDirs":
            args = params.get("arguments", [{}])[0] or {}
            preserve = bool(args.get("preserve", False))
            if preserve:
                os.environ["EVOLVE_PRESERVE_RUNS"] = "1"
            else:
                os.environ.pop("EVOLVE_PRESERVE_RUNS", None)
            self._send_response(message, {"preserve": preserve})
        else:
            self._send_response(message, None)

    def _send_response(self, request: Dict[str, Any], result: Any) -> None:
        response = {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": result,
        }
        self._send(response)

    def _send(self, payload: Dict[str, Any]) -> None:
        raw = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(raw)}\r\n\r\n".encode("utf-8")
        sys.stdout.buffer.write(header + raw)
        sys.stdout.buffer.flush()


    def _read_message(self) -> Optional[Dict[str, Any]]:
        header_bytes = b""
        while True:
            line = sys.stdin.buffer.readline()
            if not line:
                return None
            header_bytes += line
            if line in (b"\r\n", b"\n"):
                break
        headers = header_bytes.decode("utf-8").splitlines()
        length = 0
        for h in headers:
            if h.lower().startswith("content-length"):
                _, value = h.split(":", 1)
                length = int(value.strip())
                break
        if length == 0:
            return None
        body = sys.stdin.buffer.read(length)
        if not body:
            return None
        return json.loads(body.decode("utf-8"))


def main() -> None:
    server = LSPServer()
    server.run()


if __name__ == "__main__":
    main()
