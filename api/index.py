import sys
import os

# Make the backend package importable from this serverless entry point
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from main import app  # noqa: F401 — Vercel discovers and serves this ASGI app
