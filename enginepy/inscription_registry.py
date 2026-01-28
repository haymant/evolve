from __future__ import annotations

from typing import Callable, Dict, Optional

RegistryFunc = Callable[..., object]

_REGISTRY: Dict[str, RegistryFunc] = {}


def build_registry_key(pnml_name: str, owner_id: str, kind: str) -> str:
    return f"{pnml_name}_{owner_id}_{kind}"


def register_inscription(key: str, func: RegistryFunc) -> None:
    _REGISTRY[key] = func


def get_inscription(key: str) -> Optional[RegistryFunc]:
    return _REGISTRY.get(key)


def clear_registry() -> None:
    _REGISTRY.clear()
