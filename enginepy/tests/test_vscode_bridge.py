"""
Unit tests for VSCode bridge module.
"""

import pytest
import threading
import time
from enginepy import vscode_bridge


class MockSendRequest:
    """Mock callback for sending requests."""
    def __init__(self):
        self.requests = []
        self.responses = {}
    
    def __call__(self, request):
        """Store request and return mock response."""
        self.requests.append(request)
        request_id = request["id"]
        
        # Return mock response if configured
        if request_id in self.responses:
            return self.responses[request_id]
        
        # Default success response
        return {
            "success": True,
            "result": {"response": "Mock response"},
            "error": None
        }


def test_bridge_initialization():
    """Test bridge can be initialized with callback."""
    mock_send = MockSendRequest()
    bridge = vscode_bridge.VSCodeBridge(mock_send)
    assert bridge is not None
    assert bridge._request_id == 0


def test_chat_sends_request():
    """Test chat method sends request with correct format."""
    mock_send = MockSendRequest()
    mock_send.responses[0] = {
        "success": True,
        "result": {"response": "Test response"},
        "error": None
    }
    
    bridge = vscode_bridge.VSCodeBridge(mock_send)
    response = bridge.chat("Test message", timeout=5)
    
    assert len(mock_send.requests) == 1
    request = mock_send.requests[0]
    assert request["type"] == "vscode/chat"
    assert request["params"]["message"] == "Test message"
    assert request["params"]["timeout"] == 5000  # converted to ms
    assert response == "Test response"


def test_execute_command_sends_request():
    """Test execute_command method sends request correctly."""
    mock_send = MockSendRequest()
    mock_send.responses[0] = {
        "success": True,
        "result": {"result": 42},
        "error": None
    }
    
    bridge = vscode_bridge.VSCodeBridge(mock_send)
    result = bridge.execute_command("test.command", "arg1", "arg2", timeout=10)
    
    assert len(mock_send.requests) == 1
    request = mock_send.requests[0]
    assert request["type"] == "vscode/executeCommand"
    assert request["params"]["command"] == "test.command"
    assert request["params"]["args"] == ["arg1", "arg2"]
    assert request["params"]["timeout"] == 10000
    assert result == 42


def test_get_chat_history_sends_request():
    """Test get_chat_history method sends request correctly."""
    mock_send = MockSendRequest()
    mock_messages = [
        {"role": "user", "content": "Question", "timestamp": 123456},
        {"role": "copilot", "content": "Answer", "timestamp": 123457}
    ]
    mock_send.responses[0] = {
        "success": True,
        "result": {"messages": mock_messages},
        "error": None
    }
    
    bridge = vscode_bridge.VSCodeBridge(mock_send)
    history = bridge.get_chat_history("conv-123", limit=5)
    
    assert len(mock_send.requests) == 1
    request = mock_send.requests[0]
    assert request["type"] == "vscode/getChatHistory"
    assert request["params"]["conversationId"] == "conv-123"
    assert request["params"]["limit"] == 5
    assert history == mock_messages


def test_show_message_sends_request():
    """Test show_message method sends request correctly."""
    mock_send = MockSendRequest()
    
    bridge = vscode_bridge.VSCodeBridge(mock_send)
    bridge.show_message("Test message", "warning")
    
    assert len(mock_send.requests) == 1
    request = mock_send.requests[0]
    assert request["type"] == "vscode/showMessage"
    assert request["params"]["message"] == "Test message"
    assert request["params"]["level"] == "warning"


def test_request_failure_raises_error():
    """Test that failed requests raise RuntimeError."""
    mock_send = MockSendRequest()
    mock_send.responses[0] = {
        "success": False,
        "result": None,
        "error": "Something went wrong"
    }
    
    bridge = vscode_bridge.VSCodeBridge(mock_send)
    
    with pytest.raises(RuntimeError, match="Something went wrong"):
        bridge.chat("Test")


def test_request_ids_increment():
    """Test that request IDs increment correctly."""
    mock_send = MockSendRequest()
    bridge = vscode_bridge.VSCodeBridge(mock_send)
    
    bridge.show_message("Message 1")
    bridge.show_message("Message 2")
    bridge.show_message("Message 3")
    
    assert len(mock_send.requests) == 3
    assert mock_send.requests[0]["id"] == 0
    assert mock_send.requests[1]["id"] == 1
    assert mock_send.requests[2]["id"] == 2


def test_global_api_without_initialization():
    """Test global API raises error when bridge not initialized."""
    vscode_bridge._set_bridge(None)
    
    with pytest.raises(RuntimeError, match="not initialized"):
        vscode_bridge.chat("Test")
    
    with pytest.raises(RuntimeError, match="not initialized"):
        vscode_bridge.execute_command("test")
    
    with pytest.raises(RuntimeError, match="not initialized"):
        vscode_bridge.get_chat_history("conv-123")
    
    with pytest.raises(RuntimeError, match="not initialized"):
        vscode_bridge.show_message("Test")


def test_global_api_with_initialization():
    """Test global API works when bridge is initialized."""
    mock_send = MockSendRequest()
    mock_send.responses[0] = {
        "success": True,
        "result": {"response": "Global API response"},
        "error": None
    }
    
    bridge = vscode_bridge.VSCodeBridge(mock_send)
    vscode_bridge._set_bridge(bridge)
    
    try:
        response = vscode_bridge.chat("Test from global API")
        assert response == "Global API response"
        assert len(mock_send.requests) == 1
    finally:
        vscode_bridge._set_bridge(None)


def test_thread_safety():
    """Test that bridge is thread-safe."""
    mock_send = MockSendRequest()
    bridge = vscode_bridge.VSCodeBridge(mock_send)
    
    def send_messages(n):
        for i in range(n):
            bridge.show_message(f"Message {i}")
    
    threads = [
        threading.Thread(target=send_messages, args=(10,))
        for _ in range(5)
    ]
    
    for t in threads:
        t.start()
    
    for t in threads:
        t.join()
    
    # Should have received 50 requests total
    assert len(mock_send.requests) == 50
    
    # All request IDs should be unique
    request_ids = [req["id"] for req in mock_send.requests]
    assert len(set(request_ids)) == 50


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
