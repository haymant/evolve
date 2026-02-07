from __future__ import annotations

import json
import os
import sys
import io
import importlib.util
import time
from contextlib import redirect_stdout
from typing import Any, Dict, Optional
import threading
import queue

try:
    from enginepy.pnml_engine import DebugEngine, HistoryEntry, PendingOp
    from enginepy.pnml_parser import extract_place_index
    from enginepy.project_gen import generate_python_project
    from enginepy.inscription_registry import clear_registry
    from enginepy import vscode_bridge
except ImportError:
    repo_root = os.path.dirname(os.path.dirname(__file__))
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    from enginepy.pnml_engine import DebugEngine, HistoryEntry, PendingOp
    from enginepy.pnml_parser import extract_place_index
    from enginepy.project_gen import generate_python_project
    from enginepy.inscription_registry import clear_registry
    from enginepy import vscode_bridge


class DAPProtocol:
    def __init__(self) -> None:
        self.out = sys.stdout.buffer
        self.seq = 1

    def send(self, payload: Dict[str, Any]) -> None:
        raw = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(raw)}\r\n\r\n".encode("utf-8")
        self.out.write(header + raw)
        self.out.flush()

    def send_response(self, request: Dict[str, Any], body: Optional[Dict[str, Any]] = None) -> None:
        response = {
            "type": "response",
            "seq": self.seq,
            "request_seq": request.get("seq"),
            "success": True,
            "command": request.get("command"),
            "body": body or {},
        }
        self.seq += 1
        self.send(response)

    def send_event(self, event: str, body: Optional[Dict[str, Any]] = None) -> None:
        payload = {
            "type": "event",
            "seq": self.seq,
            "event": event,
            "body": body or {},
        }
        self.seq += 1
        self.send(payload)


class PNMLDAPServer:
    def __init__(self, start_reader: bool = True) -> None:
        self.protocol = DAPProtocol()
        self.engine = DebugEngine()
        self.program: Optional[str] = None
        self.last_stop: Optional[HistoryEntry] = None
        self.last_stop_place: Optional[str] = None
        self.last_breakpoint_line: Optional[int] = None
        self.last_breakpoint_line_raw: Optional[int] = None
        self.ignore_breakpoints_once: bool = False
        self.no_debug = False
        self.stopped = False
        self.inscription_breakpoints: Dict[str, set[int]] = {}
        self.last_stop_source: Optional[Dict[str, object]] = None
        
        # VSCode bridge support
        self._custom_request_id = 0
        self._custom_responses: Dict[int, Dict] = {}
        self._custom_response_queues: Dict[int, queue.Queue] = {}
        self._custom_lock = threading.Lock()
        self._bridge: Optional[vscode_bridge.VSCodeBridge] = None
        self._incoming_messages: queue.Queue = queue.Queue()
        self._reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        if start_reader:
            self._reader_thread.start()
        self._known_pending_ops: set[int] = set()

    def run(self) -> None:
        while True:
            message = self._incoming_messages.get()
            if message is None:
                break
            self._handle_message(message)

    def _handle_message(self, message: Dict[str, Any]) -> None:
        if message.get("type") != "request":
            return
        command = message.get("command")
        handler = getattr(self, f"handle_{command}", None)
        if handler:
            handler(message)
        else:
            self.protocol.send_response(message)

    def _reader_loop(self) -> None:
        while True:
            message = self._read_message()
            if message is None:
                self._incoming_messages.put(None)
                break
            self._incoming_messages.put(message)

    def handle_initialize(self, request: Dict[str, Any]) -> None:
        body = {
            "supportsConfigurationDoneRequest": True,
            "supportsStepBack": False,
            "supportsTerminateRequest": True,
            "supportsEvaluateForHovers": False,
            "supportsDelayedStackTraceLoading": False,
        }
        self.protocol.send_response(request, body)
        self.protocol.send_event("initialized")

    def handle_launch(self, request: Dict[str, Any]) -> None:
        args = request.get("arguments", {})
        self.program = args.get("program")
        self.no_debug = bool(args.get("noDebug"))
        
        # Initialize VSCode bridge for debug sessions
        if not self.no_debug:
            self._bridge = vscode_bridge.VSCodeBridge(self._send_vscode_request_sync)
            vscode_bridge._set_bridge(self._bridge)
        
        if self.program and os.path.exists(self.program):
            with open(self.program, "r", encoding="utf-8") as f:
                text = f.read()
            self._ensure_inscriptions_registered(self.program, text)
            self.engine.load(text)
        self.protocol.send_response(request)
        if self.no_debug:
            if self.engine.engine:
                buf = io.StringIO()
                with redirect_stdout(buf):
                    while True:
                        result = self.engine.engine.step_once()
                        if result is None:
                            break
                        if isinstance(result, PendingOp) and not result.completed:
                            break
                        if not self.engine.engine.enabled_transitions():
                            break
                self._emit_output(buf.getvalue())
                self._emit_marking()
                self._emit_pending_ops()
            self._terminate()

    def handle_setBreakpoints(self, request: Dict[str, Any]) -> None:
        args = request.get("arguments", {})
        source = args.get("source") or {}
        source_path = source.get("path") if isinstance(source, dict) else None
        breakpoints = args.get("breakpoints") or []
        lines = []
        for bp in breakpoints:
            if not bp.get("line"):
                continue
            raw_line = int(bp.get("line"))
            line_zero = raw_line - 1 if raw_line > 0 else raw_line
            lines.append(line_zero)
            self.last_breakpoint_line_raw = raw_line
        if source_path and source_path.endswith("inscriptions.py"):
            self.inscription_breakpoints[source_path] = set(bp.get("line") for bp in breakpoints if bp.get("line"))
            verified = [{"verified": True, "line": int(bp.get("line"))} for bp in breakpoints if bp.get("line")]
            self.protocol.send_response(request, {"breakpoints": verified})
            return
        self.last_breakpoint_line = lines[0] if lines else None
        self.engine.set_breakpoints_by_lines(lines)
        verified = [{"verified": True, "line": line + 1} for line in lines]
        self.protocol.send_response(request, {"breakpoints": verified})

    def handle_configurationDone(self, request: Dict[str, Any]) -> None:
        self.protocol.send_response(request)
        self._maybe_stop()

    def handle_threads(self, request: Dict[str, Any]) -> None:
        self.protocol.send_response(request, {"threads": [{"id": 1, "name": "Main"}]})

    def handle_stackTrace(self, request: Dict[str, Any]) -> None:
        frames = []
        source = {
            "name": os.path.basename(self.program) if self.program else "PNML",
            "path": self.program,
        }
        if self.last_stop_source:
            frames.append({
                "id": 1,
                "name": self.last_stop_source.get("name", "inscription"),
                "line": int(self.last_stop_source.get("line", 1)),
                "column": 1,
                "source": {"name": os.path.basename(str(self.last_stop_source.get("path"))), "path": self.last_stop_source.get("path")},
            })
            self.protocol.send_response(request, {"stackFrames": frames, "totalFrames": len(frames)})
            return
        if self.last_stop_place:
            line = self.engine.place_line_map.get(self.last_stop_place)
            if line is not None:
                frames.append({
                    "id": 1,
                    "name": f"Place {self.last_stop_place}",
                    "line": line + 1,
                    "column": 1,
                    "source": source,
                })
        elif self.last_stop and self.last_stop.line is not None:
            frames.append({
                "id": 1,
                "name": self.last_stop.transition_id or "PNML",
                "line": self.last_stop.line + 1,
                "column": 1,
                "source": source,
            })
        elif self.engine.breakpoints:
            for i, place_id in enumerate(sorted(self.engine.breakpoints)):
                line = self.engine.place_line_map.get(place_id)
                if line is None:
                    continue
                frames.append({
                    "id": i + 1,
                    "name": f"Breakpoint {place_id}",
                    "line": line + 1,
                    "column": 1,
                    "source": source,
                })
        elif self.engine.place_index:
            for i, place in enumerate(self.engine.place_index):
                if place.id is None:
                    continue
                frames.append({
                    "id": i + 1,
                    "name": f"Place {place.id}",
                    "line": place.id_line + 1,
                    "column": 1,
                    "source": source,
                })
        if self.last_breakpoint_line_raw is not None:
            frames.append({
                "id": len(frames) + 1,
                "name": "Breakpoint",
                "line": self.last_breakpoint_line_raw,
                "column": 1,
                "source": source,
            })
        elif self.last_breakpoint_line is not None:
            line = max(0, self.last_breakpoint_line)
            frames.append({
                "id": 1,
                "name": "Breakpoint",
                "line": line + 1,
                "column": 1,
                "source": source,
            })
        if not frames and self.program and os.path.exists(self.program):
            with open(self.program, "r", encoding="utf-8") as f:
                for i, raw in enumerate(f.read().splitlines()):
                    if "id:" in raw:
                        frames.append({
                            "id": len(frames) + 1,
                            "name": "Id",
                            "line": i + 1,
                            "column": 1,
                            "source": source,
                        })
        self.protocol.send_response(request, {"stackFrames": frames, "totalFrames": len(frames)})

    def handle_scopes(self, request: Dict[str, Any]) -> None:
        scopes = [
            {"name": "Marking", "variablesReference": 1, "presentationHint": "data"},
            {"name": "History", "variablesReference": 2, "presentationHint": "data"},
        ]
        self.protocol.send_response(request, {"scopes": scopes})

    def handle_variables(self, request: Dict[str, Any]) -> None:
        args = request.get("arguments", {})
        ref = args.get("variablesReference")
        if ref == 1 and self.engine.engine:
            vars_list = [
                {"name": pid, "value": str(tokens), "type": "list", "variablesReference": 0}
                for pid, tokens in self.engine.engine.marking.items()
            ]
        elif ref == 2:
            vars_list = [
                {
                    "name": f"step {entry.step}",
                    "value": f"transition {entry.transition_id}",
                    "type": "HistoryEntry",
                    "variablesReference": 0,
                }
                for entry in self.engine.history
            ]
        else:
            vars_list = []
        self.protocol.send_response(request, {"variables": vars_list})

    def handle_continue(self, request: Dict[str, Any]) -> None:
        self.protocol.send_response(request, {"allThreadsContinued": True})
        if not self.engine.engine:
            self._terminate()
            return
        if self.ignore_breakpoints_once:
            self._terminate()
            return
        buf = io.StringIO()
        with redirect_stdout(buf):
            entry = self.engine.continue_run()
        self._emit_output(buf.getvalue())
        self._emit_marking()
        self._emit_pending_ops()
        if self.engine.engine and self.engine.engine.pending_ops_by_id:
            if self.inscription_breakpoints:
                path, lines = next(iter(self.inscription_breakpoints.items()))
                if lines:
                    self.last_stop_source = {"path": path, "line": min(lines), "name": "inscription"}
            else:
                self.last_stop = entry
                self.last_stop_place = None
            self.stopped = True
            self.protocol.send_event("stopped", {"reason": "pause", "threadId": 1})
            return
        if entry and entry.line is not None:
            self.last_stop = entry
            self.last_stop_place = None
            self.stopped = True
            self.ignore_breakpoints_once = True
            self.protocol.send_event("stopped", {"reason": "breakpoint", "threadId": 1})
            return
        self._terminate()

    def handle_next(self, request: Dict[str, Any]) -> None:
        self.protocol.send_response(request)
        if not self.engine.engine:
            self._terminate()
            return
        buf = io.StringIO()
        with redirect_stdout(buf):
            entry = self.engine.step_once()
        self._emit_output(buf.getvalue())
        self._emit_marking()
        self._emit_pending_ops()
        if entry is None:
            self._terminate()
            return
        if self.inscription_breakpoints:
            path, lines = next(iter(self.inscription_breakpoints.items()))
            if lines:
                self.last_stop_source = {"path": path, "line": min(lines), "name": "inscription"}
                self.protocol.send_event("stopped", {"reason": "breakpoint", "threadId": 1})
                return
        line = None
        if entry.produced_places:
            line = self.engine.place_line_map.get(entry.produced_places[0])
            self.last_stop_place = None
        if line is None and self.last_breakpoint_line is not None:
            line = self.last_breakpoint_line
        if line is not None:
            self.last_stop = HistoryEntry(
                step=entry.step,
                transition_id=entry.transition_id,
                line=line,
                produced_places=entry.produced_places,
            )
        self.protocol.send_event("stopped", {"reason": "step", "threadId": 1})

    def handle_asyncOperationSubmit(self, request: Dict[str, Any]) -> None:
        args = request.get("arguments", {})
        op_id = args.get("operationId")
        resume_token = args.get("resumeToken")
        result = args.get("result")
        error = args.get("error")
        if not self.engine.engine:
            self.protocol.send_response(request)
            return
        if op_id is None and resume_token is None:
            self.protocol.send_response(request)
            return
        pending = None
        if op_id is not None:
            try:
                pending = self.engine.engine.pending_ops_by_id.get(int(op_id))
            except (TypeError, ValueError):
                pending = None
        if pending is None and resume_token is not None:
            pending = self.engine.engine.pending_ops_by_token.get(str(resume_token))
        try:
            op_id_int = int(op_id) if op_id is not None else None
        except (TypeError, ValueError):
            op_id_int = None
        self.engine.engine.submit_async(op_id=op_id_int, resume_token=resume_token, result=result, error=error)
        if op_id_int is not None:
            self._known_pending_ops.discard(op_id_int)
        self.protocol.send_event("asyncOperationUpdated", {
            "operationId": op_id or resume_token,
            "status": "completed" if error is None else "failed",
            "result": result,
            "error": error,
        })
        self._emit_marking()
        if pending and self.engine.breakpoints:
            stop_place = None
            for pid in pending.output_places:
                if pid not in self.engine.breakpoints:
                    continue
                tokens = self.engine.engine.marking.get(pid) or []
                if tokens:
                    stop_place = pid
                    break
            if stop_place:
                line = self.engine.place_line_map.get(stop_place)
                entry = HistoryEntry(
                    step=len(self.engine.history) + 1,
                    transition_id=pending.transition_id,
                    line=line,
                    produced_places=[stop_place],
                )
                self.engine.history.append(entry)
                self.last_stop = entry
                self.last_stop_place = stop_place
                self.stopped = True
                self.protocol.send_event(
                    "stopped",
                    {
                        "reason": "asyncComplete",
                        "threadId": 1,
                        "place": stop_place,
                        "transitionId": pending.transition_id,
                        "resumeToken": pending.resume_token,
                    },
                )
        self.protocol.send_response(request)

    def handle_evaluate(self, request: Dict[str, Any]) -> None:
        args = request.get("arguments", {})
        expr = (args.get("expression") or "").strip()
        result = ""
        if self.engine.engine:
            if expr in self.engine.engine.marking:
                result = repr(self.engine.engine.marking[expr])
            elif expr.startswith("marking."):
                key = expr.split(".", 1)[1]
                result = repr(self.engine.engine.marking.get(key))
        self.protocol.send_response(request, {"result": result, "variablesReference": 0})

    def handle_disconnect(self, request: Dict[str, Any]) -> None:
        self.protocol.send_response(request)
        # Clean up bridge
        vscode_bridge._set_bridge(None)
        self._bridge = None
        self._terminate()
        raise SystemExit(0)

    def handle_terminate(self, request: Dict[str, Any]) -> None:
        self.protocol.send_response(request)
        # Clean up bridge
        vscode_bridge._set_bridge(None)
        self._bridge = None
        self._terminate()
        raise SystemExit(0)
    
    def handle_customRequestResponse(self, request: Dict[str, Any]) -> None:
        """Handle response from VS Code for custom request initiated by Python code."""
        args = request.get("arguments", {})
        request_id = args.get("requestId")
        
        self._emit_output(f"[DEBUG] Received customRequestResponse for request {request_id}\n")
        
        if request_id is None:
            self.protocol.send_response(request)
            return
        
        with self._custom_lock:
            if request_id in self._custom_response_queues:
                queue_obj = self._custom_response_queues[request_id]
                queue_obj.put(args)
                self._emit_output(f"[DEBUG] Queued response for request {request_id}\n")
            else:
                self._emit_output(f"[DEBUG] No queue found for request {request_id}\n")

        self.protocol.send_response(request)
    
    def _send_vscode_request_sync(self, request: Dict) -> Dict:
        """
        Send custom request to VS Code and wait for response (blocking).
        Called by VSCodeBridge from Python inscription code.
        
        Args:
            request: Request dict with keys: id, type, params
        
        Returns:
            Response dict with keys: success, result/error
        """
        request_id = request["id"]
        request_type = request["type"]
        params = request["params"]
        
        # Emit diagnostic
        self._emit_output(f"[DEBUG] Sending VSCode request {request_id}: {request_type}\n")
        
        # Create queue for response
        response_queue: queue.Queue = queue.Queue()
        with self._custom_lock:
            self._custom_response_queues[request_id] = response_queue
        
        try:
            # Send reverse request to extension via DAP event
            self.protocol.send_event("customRequest", {
                "requestId": request_id,
                "type": request_type,
                "params": params
            })
            
            # Wait for response with timeout, but continue processing DAP messages
            timeout = params.get("timeout", 30000) / 1000.0  # Convert ms to seconds
            deadline = time.time() + timeout
            
            while time.time() < deadline:
                # Check if response arrived
                try:
                    response_data = response_queue.get(timeout=0.1)
                    self._emit_output(f"[DEBUG] Received VSCode response {request_id}\n")
                    return {
                        "success": response_data.get("success", False),
                        "result": response_data.get("result"),
                        "error": response_data.get("error")
                    }
                except queue.Empty:
                    # No response yet, process any incoming DAP messages
                    self._process_pending_messages()
            
            # Timeout
            self._emit_output(f"[DEBUG] VSCode request {request_id} timed out\n")
            return {
                "success": False,
                "error": f"Request timeout after {timeout}s"
            }
        finally:
            # Clean up queue
            with self._custom_lock:
                self._custom_response_queues.pop(request_id, None)
    
    def _process_pending_messages(self) -> None:
        """Process any pending DAP messages without blocking."""
        while True:
            try:
                message = self._incoming_messages.get_nowait()
            except queue.Empty:
                break
            if message is None:
                break
            if message.get("type") == "request" and message.get("command") == "customRequestResponse":
                self.handle_customRequestResponse(message)
            else:
                # Defer other requests to main loop
                self._incoming_messages.put(message)
                break

    def _maybe_stop(self) -> None:
        if self.stopped:
            return
        if self.inscription_breakpoints:
            path, lines = next(iter(self.inscription_breakpoints.items()))
            if lines:
                self.last_stop_source = {"path": path, "line": min(lines), "name": "inscription"}
                self.stopped = True
                self.protocol.send_event("stopped", {"reason": "breakpoint", "threadId": 1})
                return
        if self.engine.engine and self.engine.breakpoints:
            inputs, _outputs = self.engine.engine._build_io_maps()
            enabled = set(self.engine.engine.enabled_transitions())
            for place_id in self.engine.breakpoints:
                tokens = self.engine.engine.marking.get(place_id) or []
                is_input = any(place_id in inputs.get(tid, []) for tid in enabled)
                if tokens and is_input:
                    self.last_stop_place = place_id
                    self.stopped = True
                    self.protocol.send_event("stopped", {"reason": "breakpoint", "threadId": 1})
                    return
        if self.engine.place_index:
            buf = io.StringIO()
            with redirect_stdout(buf):
                entry = self.engine.continue_run()
            self._emit_output(buf.getvalue())
            self._emit_pending_ops()
            if entry is None:
                places = extract_place_index(self._read_program_text())
                if places:
                    entry = HistoryEntry(step=1, transition_id=None, line=places[0].id_line, produced_places=[])
            if entry:
                self.last_stop = entry
                self.last_stop_place = next(iter(entry.produced_places), None)
                self.stopped = True
                reason = "step" if entry.line is not None else "pause"
                self.protocol.send_event("stopped", {"reason": reason, "threadId": 1})

    def _emit_pending_ops(self) -> None:
        if not self.engine.engine:
            return
        pending = self.engine.engine.pending_ops_by_id
        if not pending:
            self._known_pending_ops.clear()
            return
        for op_id, op in pending.items():
            if op_id in self._known_pending_ops:
                continue
            self._known_pending_ops.add(op_id)
            self._emit_async_operation_started(op)

    def _emit_async_operation_started(self, op: PendingOp) -> None:
        timeout_ms = None
        if op.metadata and isinstance(op.metadata, dict):
            raw_timeout = op.metadata.get("timeout_ms") or op.metadata.get("timeout")
            try:
                timeout_ms = int(raw_timeout) if raw_timeout is not None else None
            except (TypeError, ValueError):
                timeout_ms = None
        body = {
            "operationId": op.id,
            "operationType": op.operation_type,
            "resumeToken": op.resume_token,
            "transitionId": op.transition_id,
            "transitionName": op.transition_name,
            "transitionDescription": op.transition_description,
            "inscriptionId": op.inscription_id,
            "netId": op.net_id,
            "runId": op.run_id,
            "createdAt": int(time.time() * 1000),
            "timeoutMs": timeout_ms,
            "uiState": op.ui_state,
            "metadata": op.metadata,
        }
        self.protocol.send_event("asyncOperationStarted", body)

    def _terminate(self) -> None:
        self._emit_marking(final=True)
        self.protocol.send_event("terminated")

    def _emit_output(self, text: str) -> None:
        if not text:
            return
        self.protocol.send_event("output", {"category": "stdout", "output": text})

    def _emit_marking(self, final: bool = False) -> None:
        if not self.engine.engine:
            return
        label = "Final marking" if final else "Marking"
        self.protocol.send_event(
            "output",
            {
                "category": "stdout",
                "output": f"{label}: {self.engine.engine.marking}\n",
            },
        )

    def _ensure_inscriptions_registered(self, program: str, text: str) -> None:
        clear_registry()
        workspace_root = os.path.dirname(os.path.dirname(program))
        out_dir = os.path.join(workspace_root, ".vscode", "evolve_py")
        source_name = os.path.splitext(os.path.basename(program))[0]
        module_dir = generate_python_project(text, out_dir, source_name=source_name)
        if not module_dir:
            return
        if module_dir not in sys.path:
            sys.path.append(module_dir)
        inscriptions_path = os.path.join(module_dir, "inscriptions.py")
        if not os.path.exists(inscriptions_path):
            return
        module_name = f"evolve_inscriptions_{source_name}"
        spec = importlib.util.spec_from_file_location(module_name, inscriptions_path)
        if spec and spec.loader:
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            # Emit diagnostic output so tests can observe registration occurred
            try:
                from enginepy.pnml_parser import parse_pnml
                from enginepy.inscription_registry import get_inscription
                net, _ = parse_pnml(text)
                missing = []
                for tid, transition in net.transitions.items():
                    for ins in transition.inscriptions:
                        key = ins.registry_key
                        if key and get_inscription(key) is None:
                            missing.append(key)
                if missing:
                    self._emit_output(f"Inscription registration missing: {missing}\n")
                else:
                    self._emit_output(f"Inscription registration ok for net {net.id}\n")
            except Exception as e:
                self._emit_output(f"Inscription registration check error: {e}\n")

    def _read_program_text(self) -> str:
        if self.program and os.path.exists(self.program):
            with open(self.program, "r", encoding="utf-8") as f:
                return f.read()
        return ""

    def _read_message(self) -> Optional[Dict[str, Any]]:
        header_bytes = b""
        while True:
            line = sys.stdin.buffer.readline()
            if not line:
                return None
            header_bytes += line
            if line == b"\r\n" or line == b"\n":
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
    server = PNMLDAPServer()
    server.run()


if __name__ == "__main__":
    main()
