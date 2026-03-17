import os
import time
import hmac
import hashlib
import secrets
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from routes.submit import router as submit_router
from routes.metadata import router as metadata_router

load_dotenv()

app = FastAPI(title="Global Reading Map API")

# Allow requests from the Vite dev server and production origin
_ALLOWED_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class NoIndexMiddleware(BaseHTTPMiddleware):
    """Tells search-engine crawlers not to index API responses."""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        return response

app.add_middleware(NoIndexMiddleware)

app.include_router(submit_router, prefix="/api")
app.include_router(metadata_router, prefix="/api")

# ── HMAC submit token ──────────────────────────────────────────────────────
# Shared secret used to sign short-lived tokens that the frontend must present
# when calling /api/submit.  Prevents direct API abuse from bots that haven't
# loaded the page.  Tokens rotate every TOKEN_WINDOW seconds.

TOKEN_SECRET = os.getenv("SUBMIT_TOKEN_SECRET", "dev-secret-change-me")
TOKEN_WINDOW = 300  # 5 minutes


def make_token(window: int) -> str:
    nonce = secrets.token_hex(4)
    msg = f"submit:{window}:{nonce}".encode()
    token_hex = hmac.new(TOKEN_SECRET.encode(), msg, hashlib.sha256).hexdigest()
    return f"{token_hex}:{nonce}"


@app.get("/api/token")
def get_token():
    now = int(time.time())
    window = now // TOKEN_WINDOW
    expires_in = TOKEN_WINDOW - (now % TOKEN_WINDOW)
    return {"token": make_token(window), "expires_in": expires_in}


@app.get("/health")
@app.head("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
