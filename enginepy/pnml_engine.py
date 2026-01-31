from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Callable, Union
import threading
import time

from .pnml_parser import PNMLNet, PlaceIndex, parse_pnml, Inscription
from .inscription_registry import get_inscription
from .async_ops import AsyncResult, AsyncOpRequest


@dataclass
class HistoryEntry:
    step: int
    transition_id: Optional[str]
    line: Optional[int]
    produced_places: List[str]


@dataclass
class PendingOp:
    id: int
    transition_id: str
    inscription_id: Optional[str]
    transition_name: Optional[str]
    transition_description: Optional[str]
    net_id: Optional[str]
    run_id: str
    operation_type: str
    resume_token: Optional[str]
    output_places: List[str]
    moved_tokens: List[object]
    metadata: Optional[Dict[str, object]] = None
    ui_state: Optional[Dict[str, object]] = None
    result: Optional[object] = None
    error: Optional[str] = None
    completed: bool = False


class PNMLEngine:
    def __init__(self, net: PNMLNet) -> None:
        self.net = net
        self.marking: Dict[str, List[object]] = {
            pid: list(place.tokens) for pid, place in net.places.items()
        }
        self.history: List[HistoryEntry] = []
        self.pending_ops_by_id: Dict[int, PendingOp] = {}
        self.pending_ops_by_token: Dict[str, PendingOp] = {}
        self.run_id: str = f"run-{int(time.time() * 1000)}"
        self._pending_lock = threading.Lock()

    def enabled_transitions(self) -> List[str]:
        if self.pending_ops_by_id:
            return []
        inputs, _outputs = self._build_io_maps()
        enabled: List[str] = []
        for tid, in_places in inputs.items():
            if all(self.marking.get(pid) and len(self.marking[pid]) > 0 for pid in in_places):
                enabled.append(tid)
        return enabled

    def step_once(self) -> Optional[Union[str, PendingOp]]:
        if self.pending_ops_by_id:
            return next(iter(self.pending_ops_by_id.values()))
        enabled = self.enabled_transitions()
        if not enabled:
            return None
        tid = enabled[0]
        transition = self.net.transitions.get(tid)
        if transition and transition.inscriptions:
            if not self._evaluate_guards(transition.inscriptions):
                return None
        inputs, outputs = self._build_io_maps()
        moved_tokens: List[object] = []
        for pid in inputs.get(tid, []):
            if self.marking.get(pid):
                moved_tokens.append(self.marking[pid].pop(0))
        output_places = outputs.get(tid, [])

        if transition and transition.inscriptions:
            pending = self._execute_expressions(transition.inscriptions, moved_tokens, tid, output_places)
            if pending is not None:
                if not pending.completed:
                    self._register_pending_op(pending)
                return pending

        for pid in output_places:
            self.marking.setdefault(pid, []).extend(moved_tokens or [{"from": tid}])
        return tid

    def _evaluate_guards(self, inscriptions: List[Inscription]) -> bool:
        for ins in inscriptions:
            if ins.kind != "guard":
                continue
            func = self._resolve_inscription(ins)
            if not func:
                continue
            result = self._call_inscription(func, None)
            if result is None:
                result = True
            if not bool(result):
                return False
        return True

    def _execute_expressions(
        self,
        inscriptions: List[Inscription],
        tokens: List[object],
        transition_id: str,
        output_places: List[str],
    ) -> Optional[PendingOp]:
        for ins in inscriptions:
            if ins.kind != "expression":
                continue
            func = self._resolve_inscription(ins)
            if not func:
                continue
            arg = tokens[0] if tokens else None
            exec_mode = (ins.exec_mode or "sync").lower()
            result = self._call_inscription(func, arg)
            if exec_mode == "async":
                if isinstance(result, AsyncResult):
                    pending = self._build_pending_op(
                        op_id=result.id,
                        transition_id=transition_id,
                        inscription_id=ins.id,
                        operation_type="async_result",
                        resume_token=None,
                        output_places=output_places,
                        moved_tokens=tokens,
                    )
                    self._register_pending_op(pending)
                    result.add_done_callback(lambda res: self.submit_async(pending.id, None, res.result(), res.error()))
                    return pending
                if isinstance(result, AsyncOpRequest):
                    resume_token = result.resume_token or self._generate_resume_token()
                    pending = self._build_pending_op(
                        op_id=int(time.time() * 1000) % 1_000_000_000,
                        transition_id=transition_id,
                        inscription_id=ins.id,
                        operation_type=result.operation_type,
                        resume_token=resume_token,
                        output_places=output_places,
                        moved_tokens=tokens,
                        metadata={
                            "timeout_ms": result.timeout_ms,
                            "operationParams": result.operation_params or {},
                        },
                        ui_state=result.ui_state,
                    )
                    self._register_pending_op(pending)
                    return pending
                pending = PendingOp(
                    id=int(time.time() * 1000) % 1_000_000_000,
                    transition_id=transition_id,
                    inscription_id=ins.id,
                    transition_name=transition_id,
                    transition_description=None,
                    net_id=self.net.id,
                    run_id=self.run_id,
                    operation_type="async_immediate",
                    resume_token=None,
                    output_places=output_places,
                    moved_tokens=tokens,
                    result=result,
                    completed=True,
                )
                self._finalize_async(pending)
                return pending
        return None

    def submit_async(
        self,
        op_id: Optional[int] = None,
        resume_token: Optional[str] = None,
        result: Optional[object] = None,
        error: Optional[str] = None,
    ) -> None:
        with self._pending_lock:
            pending = None
            if op_id is not None:
                pending = self.pending_ops_by_id.get(op_id)
            elif resume_token is not None:
                pending = self.pending_ops_by_token.get(resume_token)
            if pending is None:
                return
            pending.result = result
            pending.error = error
            pending.completed = True
            self._finalize_async(pending)
            self._unregister_pending_op(pending)

    def _finalize_async(self, pending: PendingOp) -> None:
        if pending.result is not None:
            tokens: List[object] = [pending.result]
        elif pending.error is not None:
            tokens = [{"error": pending.error}]
        else:
            tokens = list(pending.moved_tokens or [])
        if not tokens:
            tokens = [{"from": pending.transition_id}]
        for pid in pending.output_places:
            self.marking.setdefault(pid, []).extend(tokens)

    def _build_pending_op(
        self,
        op_id: int,
        transition_id: str,
        inscription_id: Optional[str],
        operation_type: str,
        resume_token: Optional[str],
        output_places: List[str],
        moved_tokens: List[object],
        metadata: Optional[Dict[str, object]] = None,
        ui_state: Optional[Dict[str, object]] = None,
    ) -> PendingOp:
        return PendingOp(
            id=op_id,
            transition_id=transition_id,
            inscription_id=inscription_id,
            transition_name=transition_id,
            transition_description=None,
            net_id=self.net.id,
            run_id=self.run_id,
            operation_type=operation_type,
            resume_token=resume_token,
            output_places=output_places,
            moved_tokens=moved_tokens,
            metadata=metadata,
            ui_state=ui_state,
        )

    def _register_pending_op(self, pending: PendingOp) -> None:
        self.pending_ops_by_id[pending.id] = pending
        if pending.resume_token:
            self.pending_ops_by_token[pending.resume_token] = pending
        try:
            from . import vscode_bridge
            vscode_bridge.emit_async_operation_started(pending)
        except Exception:
            pass

    def _unregister_pending_op(self, pending: PendingOp) -> None:
        self.pending_ops_by_id.pop(pending.id, None)
        if pending.resume_token:
            self.pending_ops_by_token.pop(pending.resume_token, None)

    def _generate_resume_token(self) -> str:
        return f"evo_async_{int(time.time() * 1000)}"

    def _resolve_inscription(self, ins: Inscription) -> Optional[Callable[..., object]]:
        if ins.func:
            return ins.func
        if ins.registry_key:
            ins.func = get_inscription(ins.registry_key)
        return ins.func

    def _call_inscription(self, func: Callable[..., object], token: Optional[object]) -> object:
        try:
            return func() if token is None else func(token)
        except TypeError:
            return func()

    def _build_io_maps(self) -> tuple[Dict[str, List[str]], Dict[str, List[str]]]:
        inputs: Dict[str, List[str]] = {}
        outputs: Dict[str, List[str]] = {}
        place_ids = set(self.net.places.keys())
        transition_ids = set(self.net.transitions.keys())
        for arc in self.net.arcs:
            if not arc.source or not arc.target:
                continue
            if arc.source in place_ids and arc.target in transition_ids:
                inputs.setdefault(arc.target, []).append(arc.source)
            elif arc.source in transition_ids and arc.target in place_ids:
                outputs.setdefault(arc.source, []).append(arc.target)
        return inputs, outputs


def _run_cli() -> None:
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        print("Missing PNML YAML path.")
        return
    text = open(path, "r", encoding="utf-8").read()
    net, _ = parse_pnml(text)
    engine = PNMLEngine(net)
    while True:
        result = engine.step_once()
        if result is None:
            break
        if isinstance(result, PendingOp) and not result.completed:
            print(f"Paused for async operation: {result.id}")
            break
        if not engine.enabled_transitions():
            break
    print("Final marking:", engine.marking)


if __name__ == "__main__":
    _run_cli()


class DebugEngine:
    def __init__(self) -> None:
        self.net: Optional[PNMLNet] = None
        self.place_index: List[PlaceIndex] = []
        self.place_line_map: Dict[str, int] = {}
        self.engine: Optional[PNMLEngine] = None
        self.breakpoints: Set[str] = set()
        self.history: List[HistoryEntry] = []
        self.step_counter: int = 0

    def load(self, text: str) -> None:
        self.net, self.place_index = parse_pnml(text)
        self.place_line_map = {p.id: p.id_line for p in self.place_index if p.id}
        if self.net is not None:
            self.engine = PNMLEngine(self.net)
        else:
            self.engine = None
        self.breakpoints = set()
        self.history = []
        self.step_counter = 0

    def set_breakpoints_by_lines(self, lines: List[int]) -> List[int]:
        self.breakpoints = set()
        for line in lines:
            place = self.find_place_for_line(line)
            if place and place.id:
                self.breakpoints.add(place.id)
        return list(lines)

    def find_place_for_line(self, line: int) -> Optional[PlaceIndex]:
        for place in self.place_index:
            if place.start_line <= line <= place.end_line:
                return place
        after = sorted((p for p in self.place_index if p.start_line > line), key=lambda p: p.start_line)
        return after[0] if after else None

    def continue_run(self) -> Optional[HistoryEntry]:
        if not self.engine:
            return None
        while True:
            result = self.engine.step_once()
            if result is None:
                return None
            if isinstance(result, PendingOp):
                if not result.completed:
                    entry = HistoryEntry(
                        step=self.step_counter,
                        transition_id=result.transition_id,
                        line=None,
                        produced_places=[],
                    )
                    self.history.append(entry)
                    return entry
                self.step_counter += 1
                produced = self._produced_places(result.transition_id)
                entry = HistoryEntry(
                    step=self.step_counter,
                    transition_id=result.transition_id,
                    line=None,
                    produced_places=produced,
                )
                self.history.append(entry)
                continue
            transition_id = result
            self.step_counter += 1
            produced = self._produced_places(transition_id)
            stop_place = next((p for p in produced if p in self.breakpoints), None)
            stop_line = self.place_line_map.get(stop_place) if stop_place else None
            entry = HistoryEntry(
                step=self.step_counter,
                transition_id=transition_id,
                line=stop_line,
                produced_places=produced,
            )
            self.history.append(entry)
            if stop_place:
                return entry

    def step_once(self) -> Optional[HistoryEntry]:
        if not self.engine:
            return None
        result = self.engine.step_once()
        if result is None:
            return None
        if isinstance(result, PendingOp):
            entry = HistoryEntry(
                step=self.step_counter,
                transition_id=result.transition_id,
                line=None,
                produced_places=[],
            )
            self.history.append(entry)
            return entry
        transition_id = result
        self.step_counter += 1
        produced = self._produced_places(transition_id)
        entry = HistoryEntry(
            step=self.step_counter,
            transition_id=transition_id,
            line=None,
            produced_places=produced,
        )
        self.history.append(entry)
        return entry

    def _produced_places(self, transition_id: str) -> List[str]:
        if not self.net:
            return []
        outputs: List[str] = []
        place_ids = set(self.net.places.keys())
        transition_ids = set(self.net.transitions.keys())
        for arc in self.net.arcs:
            if arc.source in transition_ids and arc.target in place_ids and arc.source == transition_id:
                outputs.append(arc.target)
        return outputs
