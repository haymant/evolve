from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Callable
import re

from .inscription_registry import build_registry_key


@dataclass
class PlaceIndex:
    id: Optional[str]
    id_line: int
    start_line: int
    end_line: int


@dataclass
class Place:
    id: str
    tokens: List[object] = field(default_factory=list)


@dataclass
class Inscription:
    id: Optional[str] = None
    language: Optional[str] = None
    kind: Optional[str] = None
    source: Optional[str] = None
    exec_mode: Optional[str] = None
    code: Optional[str] = None
    owner_id: Optional[str] = None
    registry_key: Optional[str] = None
    func: Optional[Callable[..., object]] = None


@dataclass
class Transition:
    id: str
    inscriptions: List[Inscription] = field(default_factory=list)


@dataclass
class Arc:
    id: str
    source: Optional[str] = None
    target: Optional[str] = None
    inscriptions: List[Inscription] = field(default_factory=list)


@dataclass
class PNMLNet:
    id: Optional[str] = None
    places: Dict[str, Place] = field(default_factory=dict)
    transitions: Dict[str, Transition] = field(default_factory=dict)
    arcs: List[Arc] = field(default_factory=list)


_KEY_RE = re.compile(r"^([A-Za-z0-9_]+)\s*:\s*(.*)$")
_LIST_ID_RE = re.compile(r"^-\s*id:\s*([A-Za-z0-9_\-]+)\s*$")
_LIST_VALUE_RE = re.compile(r"^-\s*value:\s*(.+)$")


def _parse_scalar(value: str) -> object:
    raw = value.strip()
    if raw.startswith('"') and raw.endswith('"'):
        return raw[1:-1]
    if raw.startswith("'") and raw.endswith("'"):
        return raw[1:-1]
    if raw.lower() in {"true", "false"}:
        return raw.lower() == "true"
    try:
        if "." in raw:
            return float(raw)
        return int(raw)
    except ValueError:
        return raw


def _active_section(stack: List[Tuple[str, int]]) -> Optional[str]:
    for name, _indent in reversed(stack):
        if name in {"net", "place", "transition", "arc", "initialTokens", "inscriptions"}:
            return name
    return None


def _stack_contains(stack: List[Tuple[str, int]], name: str) -> bool:
    return any(entry_name == name for entry_name, _ in stack)


def extract_place_index(text: str) -> List[PlaceIndex]:
    lines = text.splitlines()
    stack: List[Tuple[str, int]] = []
    places: List[PlaceIndex] = []
    current_place: Optional[PlaceIndex] = None

    for i, raw in enumerate(lines):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        while stack and indent <= stack[-1][1]:
            stack.pop()
        stripped = raw.lstrip()
        key_match = _KEY_RE.match(stripped)
        if key_match:
            key, value = key_match.groups()
            if value == "":
                stack.append((key, indent))
            continue

        list_match = _LIST_ID_RE.match(stripped)
        if list_match and _active_section(stack) == "place":
            if current_place:
                current_place.end_line = i - 1
            place_id = list_match.group(1)
            current_place = PlaceIndex(id=place_id, id_line=i, start_line=i, end_line=i)
            places.append(current_place)
            continue

        if current_place:
            current_place.end_line = max(current_place.end_line, i)

    if current_place:
        current_place.end_line = max(current_place.end_line, len(lines) - 1)

    return places


def find_place_for_line(places: List[PlaceIndex], line: int) -> Optional[PlaceIndex]:
    for place in places:
        if place.start_line <= line <= place.end_line:
            return place
    after = sorted((p for p in places if p.start_line > line), key=lambda p: p.start_line)
    return after[0] if after else None


def parse_pnml(text: str) -> Tuple[PNMLNet, List[PlaceIndex]]:
    lines = text.splitlines()
    stack: List[Tuple[str, int]] = []
    net = PNMLNet()
    place_index: List[PlaceIndex] = []
    current_place_id: Optional[str] = None
    current_transition_id: Optional[str] = None
    current_arc: Optional[Arc] = None
    current_place_entry: Optional[PlaceIndex] = None
    current_inscription: Optional[Inscription] = None
    code_indent: Optional[int] = None
    current_net_id: Optional[str] = None
    current_inscription_owner: Optional[str] = None

    for i, raw in enumerate(lines):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if code_indent is not None:
            if indent > code_indent:
                if current_inscription is not None:
                    current_inscription.code = (current_inscription.code or "") + raw[code_indent + 1:] + "\n"
                continue
            code_indent = None
        while stack and indent <= stack[-1][1]:
            stack.pop()
        stripped = raw.lstrip()

        key_match = _KEY_RE.match(stripped)
        if key_match:
            key, value = key_match.groups()
            if key == "code" and value.strip() == "|":
                code_indent = indent
                if current_inscription is not None:
                    current_inscription.code = ""
                continue
            if value == "":
                stack.append((key, indent))
            else:
                if current_inscription is not None and _active_section(stack) == "inscriptions":
                    if key in {"language", "kind", "source", "id", "execMode", "code"}:
                        if key == "language":
                            current_inscription.language = value.strip()
                        elif key == "kind":
                            current_inscription.kind = value.strip()
                        elif key == "source":
                            current_inscription.source = value.strip()
                        elif key == "id":
                            current_inscription.id = value.strip()
                        elif key == "execMode":
                            current_inscription.exec_mode = value.strip()
                        elif key == "code":
                            # Inline single-line code value
                            current_inscription.code = _parse_scalar(value)
                        _sync_inscription_owner(net, current_inscription, current_net_id, current_transition_id, current_arc, current_inscription_owner)
                
                if _active_section(stack) == "arc" and current_arc:
                    if key == "source":
                        current_arc.source = value.strip()
                    elif key == "target":
                        current_arc.target = value.strip()
                continue

        list_match = _LIST_ID_RE.match(stripped)
        if list_match:
            item_id = list_match.group(1)
            section = _active_section(stack)
            if section == "net" and not any(_stack_contains(stack, s) for s in ("page", "place", "transition", "arc", "inscriptions")):
                current_net_id = item_id
                net.id = item_id
                continue
            if section == "place":
                if current_place_entry:
                    current_place_entry.end_line = i - 1
                current_place_id = item_id
                current_place_entry = PlaceIndex(id=item_id, id_line=i, start_line=i, end_line=i)
                place_index.append(current_place_entry)
                net.places[item_id] = Place(id=item_id, tokens=[])
                continue
            if section == "transition":
                current_transition_id = item_id
                net.transitions[item_id] = Transition(id=item_id)
                continue
            if section == "inscriptions":
                current_inscription = Inscription(id=item_id)
                current_inscription_owner = _active_section(stack[:-1])
                _sync_inscription_owner(net, current_inscription, current_net_id, current_transition_id, current_arc, current_inscription_owner)
                continue
            if section == "arc":
                current_arc = Arc(id=item_id)
                net.arcs.append(current_arc)
                continue

        value_match = _LIST_VALUE_RE.match(stripped)
        if value_match and _active_section(stack) == "initialTokens" and current_place_id:
            token = _parse_scalar(value_match.group(1))
            net.places[current_place_id].tokens.append(token)

        if current_place_entry:
            current_place_entry.end_line = max(current_place_entry.end_line, i)

    if current_place_entry:
        current_place_entry.end_line = max(current_place_entry.end_line, len(lines) - 1)

    return net, place_index


def _sync_inscription_owner(
    net: PNMLNet,
    ins: Inscription,
    net_id: Optional[str],
    transition_id: Optional[str],
    arc: Optional[Arc],
    owner_section: Optional[str],
) -> None:
    if owner_section == "transition" and transition_id:
        ins.owner_id = transition_id
        ins.registry_key = build_registry_key(net_id or "pnml", transition_id, ins.kind or "inscription")
        transition = net.transitions.get(transition_id)
        if transition and ins not in transition.inscriptions:
            transition.inscriptions.append(ins)
        return
    if owner_section == "arc" and arc:
        ins.owner_id = arc.id
        ins.registry_key = build_registry_key(net_id or "pnml", arc.id, ins.kind or "inscription")
        if ins not in arc.inscriptions:
            arc.inscriptions.append(ins)
