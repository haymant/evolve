"""
VSCode Bridge - Enable Python inscription code to interact with VS Code.

This module provides a bridge between Python code running in PNML executions
and the VS Code extension, allowing inscriptions to:
- Send messages to GitHub Copilot Chat
- Execute VS Code commands
- Retrieve chat history
- Display messages in VS Code UI

Only available during debug sessions. In run mode, calls will raise RuntimeError.
"""

from __future__ import annotations
from typing import Any, Dict, List, Optional, Callable
import threading
import time
import os
import json
import socket
import base64
import hashlib
from urllib.parse import urlparse, urlencode

from .async_ops import AsyncResult, run_async


class VSCodeBridge:
    """Bridge for communicating with VS Code extension during debug sessions."""
    
    def __init__(self, send_request_callback: Callable[[Dict], Dict]):
        """
        Initialize bridge with callback to send requests to VS Code.
        
        Args:
            send_request_callback: Function that sends request dict and returns response dict
        """
        self._send_request = send_request_callback
        self._request_id = 0
        self._lock = threading.Lock()
    
    def chat(self, message: str, timeout: int = 30) -> str:
        """
        Send message to GitHub Copilot Chat and return response.
        
        Args:
            message: The message/question to send to Copilot
            timeout: Maximum seconds to wait for response (default: 30)
        
        Returns:
            Copilot's text response
        
        Raises:
            RuntimeError: If request fails or times out
        
        Example:
            response = vscode_bridge.chat("Explain Petri nets")
            print(f"Copilot says: {response}")
        """
        response = self._send_custom_request(
            "vscode/chat",
            {"message": message, "timeout": timeout * 1000}
        )
        if response.get("blocked"):
            reason = response.get("blockedReason", "blocked")
            opened = response.get("openedChat")
            suffix = " and opened Copilot Chat" if opened else ""
            return f"[Copilot blocked: {reason}{suffix}]"
        return response.get("response", "")

    def chat_async(self, message: str, timeout: int = 30) -> AsyncResult:
        """Run chat in a background thread and return an AsyncResult."""
        return run_async(lambda: self.chat(message, timeout))
    
    def execute_command(self, command: str, *args, timeout: int = 10) -> Any:
        """
        Execute a VS Code command.
        
        Args:
            command: Command identifier (e.g., 'vscode.open', 'workbench.action.files.save')
            *args: Arguments to pass to the command
            timeout: Maximum seconds to wait (default: 10)
        
        Returns:
            Command result (type depends on command)
        
        Raises:
            RuntimeError: If command fails or times out
        
        Example:
            vscode_bridge.execute_command('vscode.open', 'file:///path/to/file.txt')
        """
        response = self._send_custom_request(
            "vscode/executeCommand",
            {"command": command, "args": list(args), "timeout": timeout * 1000}
        )
        return response.get("result")
    
    def get_chat_history(self, conversation_id: str, limit: int = 10) -> List[Dict[str, str]]:
        """
        Retrieve chat conversation history.
        
        Args:
            conversation_id: ID of conversation to retrieve
            limit: Maximum number of messages to return (default: 10)
        
        Returns:
            List of message dicts with keys: role, content, timestamp
        
        Example:
            history = vscode_bridge.get_chat_history("conv-123", limit=5)
            for msg in history:
                print(f"{msg['role']}: {msg['content']}")
        """
        response = self._send_custom_request(
            "vscode/getChatHistory",
            {"conversationId": conversation_id, "limit": limit}
        )
        return response.get("messages", [])
    
    def show_message(self, message: str, level: str = "info") -> None:
        """
        Display a message in VS Code.
        
        Args:
            message: Message text to display
            level: Message level - "info", "warning", or "error" (default: "info")
        
        Example:
            vscode_bridge.show_message("Transition fired!", "info")
        """
        self._send_custom_request(
            "vscode/showMessage",
            {"message": message, "level": level}
        )
    
    def _send_custom_request(self, request_type: str, params: Dict) -> Dict:
        """
        Send a custom request to VS Code and wait for response.
        
        Args:
            request_type: Type of request (e.g., "vscode/chat")
            params: Request parameters
        
        Returns:
            Response dict with result data
        
        Raises:
            RuntimeError: If request fails
        """
        with self._lock:
            request_id = self._request_id
            self._request_id += 1
        
        request = {
            "id": request_id,
            "type": request_type,
            "params": params
        }
        
        # Send request and wait for response (blocking)
        response = self._send_request(request)
        
        if not response.get("success"):
            error = response.get("error", "Unknown error")
            raise RuntimeError(f"VSCode request failed: {error}")
        
        return response.get("result", {})


# Global bridge instance (initialized by DAP server during debug session)
_bridge: Optional[VSCodeBridge] = None
_run_bridge: Optional["RunBridgeClient"] = None


class RunBridgeClient:
    """WebSocket client for run-mode VS Code interop."""

    def __init__(self, addr: str, token: str, session: str) -> None:
        self._addr = addr
        self._token = token
        self._session = session
        self._sock: Optional[socket.socket] = None
        self._lock = threading.Lock()

    def _connect(self) -> None:
        if self._sock is not None:
            return
        parsed = urlparse(self._addr)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 80
        path = parsed.path or "/"
        query = urlencode({"token": self._token, "session": self._session})
        path = f"{path}?{query}"

        sock = socket.create_connection((host, port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode("utf-8")
        headers = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(headers.encode("utf-8"))
        response = self._recv_http_headers(sock)
        if "101" not in response.splitlines()[0]:
            sock.close()
            raise RuntimeError("Run bridge handshake failed")
        accept = self._compute_accept(key)
        if f"Sec-WebSocket-Accept: {accept}" not in response:
            sock.close()
            raise RuntimeError("Run bridge handshake invalid")
        self._sock = sock

    def send_request(self, request: Dict, timeout_ms: int) -> Dict:
        with self._lock:
            self._connect()
            payload = json.dumps(request).encode("utf-8")
            self._send_frame(payload)
            deadline = time.time() + max(1, timeout_ms) / 1000.0
            while time.time() < deadline:
                try:
                    data = self._recv_frame(timeout=0.5)
                except socket.timeout:
                    continue
                if not data:
                    continue
                try:
                    message = json.loads(data.decode("utf-8"))
                except json.JSONDecodeError:
                    continue
                if message.get("id") == request.get("id"):
                    return message
            raise RuntimeError(f"Request timeout after {timeout_ms/1000.0}s")

    def _recv_http_headers(self, sock: socket.socket) -> str:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(1024)
            if not chunk:
                break
            data += chunk
        return data.decode("utf-8", errors="ignore")

    def _compute_accept(self, key: str) -> str:
        magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        sha1 = hashlib.sha1((key + magic).encode("utf-8")).digest()
        return base64.b64encode(sha1).decode("utf-8")

    def _send_frame(self, payload: bytes) -> None:
        if not self._sock:
            raise RuntimeError("Run bridge socket not connected")
        fin_opcode = 0x81  # FIN + text
        length = len(payload)
        mask_bit = 0x80
        if length < 126:
            header = bytes([fin_opcode, mask_bit | length])
            extended = b""
        elif length < 65536:
            header = bytes([fin_opcode, mask_bit | 126])
            extended = length.to_bytes(2, "big")
        else:
            header = bytes([fin_opcode, mask_bit | 127])
            extended = length.to_bytes(8, "big")
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self._sock.sendall(header + extended + mask + masked)

    def _recv_frame(self, timeout: float) -> bytes:
        if not self._sock:
            raise RuntimeError("Run bridge socket not connected")
        self._sock.settimeout(timeout)
        first = self._recv_exact(2)
        if not first:
            return b""
        b1, b2 = first[0], first[1]
        masked = (b2 & 0x80) != 0
        length = b2 & 0x7F
        if length == 126:
            length = int.from_bytes(self._recv_exact(2), "big")
        elif length == 127:
            length = int.from_bytes(self._recv_exact(8), "big")
        mask = self._recv_exact(4) if masked else b""
        payload = self._recv_exact(length) if length > 0 else b""
        if masked and mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return payload

    def _recv_exact(self, n: int) -> bytes:
        data = b""
        while len(data) < n:
            chunk = self._sock.recv(n - len(data))
            if not chunk:
                break
            data += chunk
        return data


def _set_bridge(bridge: Optional[VSCodeBridge]) -> None:
    """Internal: Set global bridge instance (called by DAP server)."""
    global _bridge
    _bridge = bridge


def _ensure_run_bridge() -> Optional[RunBridgeClient]:
    global _run_bridge
    if _run_bridge is not None:
        return _run_bridge
    addr = os.getenv("EVOLVE_RUN_BRIDGE_ADDR")
    token = os.getenv("EVOLVE_RUN_BRIDGE_TOKEN")
    session = os.getenv("EVOLVE_RUN_BRIDGE_SESSION")
    if not addr or not token or not session:
        return None
    _run_bridge = RunBridgeClient(addr, token, session)
    return _run_bridge


def is_available() -> bool:
    return _bridge is not None or _ensure_run_bridge() is not None


def chat(message: str, timeout: int = 30) -> str:
    """
    Send message to GitHub Copilot Chat and return response.
    
    Args:
        message: The message/question to send to Copilot
        timeout: Maximum seconds to wait for response (default: 30)
    
    Returns:
        Copilot's text response
    
    Raises:
        RuntimeError: If not in debug session or request fails
    
    Example:
        from enginepy import vscode_bridge
        response = vscode_bridge.chat("What are Petri nets?")
        print(response)
    """
    if _bridge is not None:
        return _bridge.chat(message, timeout)
    run_bridge = _ensure_run_bridge()
    if run_bridge is None:
        raise RuntimeError(
            "VSCode bridge not initialized. "
            "The bridge is only available during debug sessions or run-mode bridge sessions."
        )
    request = {
        "id": int(time.time() * 1000) % 1_000_000_000,
        "type": "vscode/chat",
        "params": {"message": message, "timeout": timeout * 1000}
    }
    response = run_bridge.send_request(request, timeout * 1000)
    if not response.get("success"):
        raise RuntimeError(f"VSCode request failed: {response.get('error', 'Unknown error')}")
    result = response.get("result", {})
    if result.get("blocked"):
        reason = result.get("blockedReason", "blocked")
        opened = result.get("openedChat")
        suffix = " and opened Copilot Chat" if opened else ""
        return f"[Copilot blocked: {reason}{suffix}]"
    return result.get("response", "")


def chat_async(message: str, timeout: int = 30) -> AsyncResult:
    """Run chat in a background thread and return an AsyncResult."""
    if _bridge is not None:
        return _bridge.chat_async(message, timeout)
    run_bridge = _ensure_run_bridge()
    if run_bridge is None:
        raise RuntimeError(
            "VSCode bridge not initialized. "
            "The bridge is only available during debug sessions or run-mode bridge sessions."
        )
    return run_async(lambda: chat(message, timeout))


def execute_command(command: str, *args, timeout: int = 10) -> Any:
    """
    Execute a VS Code command.
    
    Args:
        command: Command identifier (e.g., 'vscode.open')
        *args: Arguments to pass to the command
        timeout: Maximum seconds to wait (default: 10)
    
    Returns:
        Command result (type depends on command)
    
    Raises:
        RuntimeError: If not in debug session or command fails
    
    Example:
        from enginepy import vscode_bridge
        vscode_bridge.execute_command('workbench.action.files.newUntitledFile')
    """
    if _bridge is not None:
        return _bridge.execute_command(command, *args, timeout)
    run_bridge = _ensure_run_bridge()
    if run_bridge is None:
        raise RuntimeError("VSCode bridge not initialized (not in debug session)")
    request = {
        "id": int(time.time() * 1000) % 1_000_000_000,
        "type": "vscode/executeCommand",
        "params": {"command": command, "args": list(args), "timeout": timeout * 1000}
    }
    response = run_bridge.send_request(request, timeout * 1000)
    if not response.get("success"):
        raise RuntimeError(f"VSCode request failed: {response.get('error', 'Unknown error')}")
    result = response.get("result", {})
    return result.get("result")


def get_chat_history(conversation_id: str, limit: int = 10) -> List[Dict[str, str]]:
    """
    Retrieve chat conversation history.
    
    Args:
        conversation_id: ID of conversation to retrieve
        limit: Maximum number of messages to return (default: 10)
    
    Returns:
        List of message dicts with keys: role, content, timestamp
    
    Raises:
        RuntimeError: If not in debug session
    
    Example:
        from enginepy import vscode_bridge
        history = vscode_bridge.get_chat_history("conv-123")
        for msg in history:
            print(f"{msg['role']}: {msg['content']}")
    """
    if _bridge is not None:
        return _bridge.get_chat_history(conversation_id, limit)
    run_bridge = _ensure_run_bridge()
    if run_bridge is None:
        raise RuntimeError("VSCode bridge not initialized (not in debug session)")
    request = {
        "id": int(time.time() * 1000) % 1_000_000_000,
        "type": "vscode/getChatHistory",
        "params": {"conversationId": conversation_id, "limit": limit}
    }
    response = run_bridge.send_request(request, 30000)
    if not response.get("success"):
        raise RuntimeError(f"VSCode request failed: {response.get('error', 'Unknown error')}")
    result = response.get("result", {})
    return result.get("messages", [])


def show_message(message: str, level: str = "info") -> None:
    """
    Display a message in VS Code.
    
    Args:
        message: Message text to display
        level: Message level - "info", "warning", or "error" (default: "info")
    
    Raises:
        RuntimeError: If not in debug session
    
    Example:
        from enginepy import vscode_bridge
        vscode_bridge.show_message("Processing complete!", "info")
    """
    if _bridge is not None:
        _bridge.show_message(message, level)
        return
    run_bridge = _ensure_run_bridge()
    if run_bridge is None:
        raise RuntimeError("VSCode bridge not initialized (not in debug session)")
    request = {
        "id": int(time.time() * 1000) % 1_000_000_000,
        "type": "vscode/showMessage",
        "params": {"message": message, "level": level}
    }
    response = run_bridge.send_request(request, 30000)
    if not response.get("success"):
        raise RuntimeError(f"VSCode request failed: {response.get('error', 'Unknown error')}")
