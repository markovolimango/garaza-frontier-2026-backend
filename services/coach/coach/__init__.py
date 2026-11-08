"""Headless presentation-practice coaching backend.

Owns session state, ingests device events (pose, speech, heart rate), computes movement and
speaking observations, applies deterministic coaching rules and serves REST + WebSocket APIs.
"""

__version__ = "0.1.0"
SCHEMA_VERSION = "1.0"
