import os
import types

from enginepy.pnml_dap import PNMLDAPServer
from enginepy.pnml_engine import PendingOp


def test_async_submit_stops_on_breakpoint() -> None:
    root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    sample = os.path.join(root, "examples", "GenericAsync.evolve.yaml")
    with open(sample, "r", encoding="utf-8") as handle:
        text = handle.read()

    server = PNMLDAPServer(start_reader=False)
    server.engine.load(text)
    engine = server.engine.engine
    assert engine is not None

    pending = PendingOp(
        id=123,
        transition_id="t_form",
        inscription_id="in_form",
        transition_name="t_form",
        transition_description=None,
        net_id=engine.net.id,
        run_id=engine.run_id,
        operation_type="form",
        resume_token="token-1",
        output_places=["p_form", "p_done"],
        moved_tokens=[{"from": "t_form"}],
        metadata={"timeout_ms": 1000, "operationParams": {}},
        ui_state=None,
    )

    engine.pending_ops_by_id[pending.id] = pending
    engine.pending_ops_by_token[pending.resume_token] = pending
    server.engine.breakpoints = {"p_form", "p_done"}

    events = []
    responses = []
    server.protocol.send_event = types.MethodType(lambda _self, event, body=None: events.append((event, body)), server.protocol)
    server.protocol.send_response = types.MethodType(lambda _self, request, body=None: responses.append((request, body)), server.protocol)

    server.handle_asyncOperationSubmit({"arguments": {"resumeToken": "token-1", "result": {"approved": True}}})

    assert server.stopped is True
    assert server.last_stop_place == "p_form"
    assert any(event == "stopped" for event, _ in events)
    assert engine.marking.get("p_form")
