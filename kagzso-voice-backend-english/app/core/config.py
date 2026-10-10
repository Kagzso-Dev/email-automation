"""Application settings loaded from environment variables / .env.

Secrets are typed as SecretStr so they never appear in repr(), logs or
tracebacks. Use `.get_secret_value()` only at the point of use.
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import List

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL

# Language code mapping: CALL_LANGUAGE (short) -> Sarvam BCP-47 code.
SARVAM_LANGUAGE_CODES = {
    "en": "en-IN",
    "hi": "hi-IN",
    "ta": "ta-IN",
    "te": "te-IN",
    "kn": "kn-IN",
    "ml": "ml-IN",
    "mr": "mr-IN",
    "gu": "gu-IN",
    "bn": "bn-IN",
    "pa": "pa-IN",
    "od": "od-IN",
    "auto": "unknown",
}


class Settings(BaseSettings):
    # KAGZSO_ENV_FILE lets tests run without reading the real .env.
    model_config = SettingsConfigDict(
        env_file=os.getenv("KAGZSO_ENV_FILE", ".env"), env_file_encoding="utf-8", extra="ignore"
    )

    # --- App ---
    APP_NAME: str = "Kagzso Voice Backend"
    APP_ENV: str = "development"  # development | staging | production | test
    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    LOG_LEVEL: str = "INFO"
    # Protects /api/calls/*, /api/agents/* and /api/test/* (header X-API-Key).
    ADMIN_API_KEY: SecretStr = SecretStr("")
    # Used to sign the media WebSocket URL token.
    APP_SECRET_KEY: SecretStr = SecretStr("")
    CORS_ORIGINS: str = ""  # comma-separated list; empty = no browser origins allowed
    RATE_LIMIT_PER_MINUTE: int = 30
    # Dispatch status callbacks: calls placed with run_id/log_id POST their status,
    # outcome, summary and transcript here, signed with HMAC-SHA256 (empty = off).
    STATUS_CALLBACK_URL: str = ""  # e.g. http://localhost:4000/api/webhooks/ai-calls
    STATUS_CALLBACK_SECRET: SecretStr = SecretStr("")  # same value as Dispatch's AI_CALL_WEBHOOK_SECRET

    # --- Plivo ---
    PLIVO_AUTH_ID: str = ""
    PLIVO_AUTH_TOKEN: SecretStr = SecretStr("")
    PLIVO_FROM_NUMBER: str = ""
    PLIVO_VALIDATE_SIGNATURE: bool = True

    # --- Twilio ---
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: SecretStr = SecretStr("")
    TWILIO_FROM_NUMBER: str = ""
    TWILIO_VALIDATE_SIGNATURE: bool = True
    TWILIO_MACHINE_DETECTION: bool = True

    # Which phone provider places new calls: plivo | twilio
    TELEPHONY_PROVIDER: str = "plivo"

    PUBLIC_BASE_URL: str = ""  # e.g. https://abcd.ngrok-free.app (no trailing slash)

    # --- Sarvam STT ---
    SARVAM_API_KEY: SecretStr = SecretStr("")
    SARVAM_STT_MODEL: str = "saaras:v3"
    SARVAM_STT_MODE: str = "transcribe"  # only used by saaras:v3
    SARVAM_BASE_URL: str = "https://api.sarvam.ai"
    SARVAM_TIMEOUT_SECONDS: float = 10.0

    # --- Cartesia TTS ---
    CARTESIA_API_KEY: SecretStr = SecretStr("")
    CARTESIA_TTS_MODEL: str = "sonic-3.6"
    CARTESIA_VOICE_ID: str = ""
    CARTESIA_VERSION: str = "2026-08-14"
    CARTESIA_BASE_URL: str = "https://api.cartesia.ai"
    CARTESIA_WS_URL: str = "wss://api.cartesia.ai/tts/websocket"
    CARTESIA_LANGUAGE: str = "en"
    CARTESIA_SPEED: float = 1.0
    # Comma-separated voice ids: each new call uses the next one in turn (empty = agent's voice)
    CARTESIA_VOICE_ROTATION: str = ""

    # --- LLM ---
    LLM_PROVIDER: str = "gemini"  # gemini | openai | groq | ollama | openai_compatible
    LLM_API_KEY: SecretStr = SecretStr("")
    LLM_MODEL: str = ""
    LLM_BASE_URL: str = ""  # optional override (OpenAI-compatible providers)
    LLM_TEMPERATURE: float = 0.6
    LLM_MAX_OUTPUT_TOKENS: int = 1024
    LLM_TIMEOUT_SECONDS: float = 8.0
    # Used once per reply if LLM_MODEL hits quota / overload / timeout before speaking.
    LLM_FALLBACK_MODEL: str = ""
    # Gemini thinking depth: minimal | low | medium | high, or empty for the model default.
    # "minimal" roughly halves time-to-first-word on phone calls.
    LLM_THINKING_LEVEL: str = "minimal"

    # --- MySQL ---
    MYSQL_HOST: str = "localhost"
    MYSQL_PORT: int = 3306
    MYSQL_DATABASE: str = "kagzso_voice"
    MYSQL_USER: str = "root"
    MYSQL_PASSWORD: SecretStr = SecretStr("")
    # Optional full override (used by tests, e.g. sqlite+aiosqlite:///./test.db)
    DATABASE_URL: str = ""

    # --- In-process call session state ---
    SESSION_TTL_SECONDS: int = 7200

    # --- Call behaviour ---
    CALL_LANGUAGE: str = "en"
    MAX_CALL_DURATION_SECONDS: int = 180
    # Wait this long after the media stream starts for the customer to speak
    # ("Hello?"); if they stay silent, the agent greets first.
    GREETING_DELAY_MS: int = 2500
    # Render the fixed first sentence while the phone rings, so it plays the instant the
    # call is answered (no TTS round-trip = no dead air). Falls back to live TTS on failure.
    GREETING_PRERENDER: bool = True
    # Wait before a pre-rendered greeting when the customer hasn't spoken yet.
    GREETING_PRERENDERED_DELAY_MS: int = 300
    # Silence after the agent finishes speaking: re-prompt once ("Hello, hear panreengala?"),
    # then close politely and hang up if there is still no response.
    SILENCE_REPROMPT_SECONDS: float = 7.0
    # True only if your team really follows up interested leads (rows are written to
    # `followups`). Controls whether the agent may say "our team will contact you".
    TEAM_FOLLOWUP_ENABLED: bool = False
    # Plivo answering-machine detection (async); voicemail -> hang up, outcome=voicemail.
    PLIVO_MACHINE_DETECTION: bool = True

    # --- Voice activity detection / turn taking ---
    VAD_AGGRESSIVENESS: int = 2  # webrtcvad 0-3
    VAD_SPEECH_START_MS: int = 200  # voiced audio needed to declare speech (and barge-in)
    VAD_SPEECH_END_SILENCE_MS: int = 700  # silence that ends a customer turn
    VAD_MIN_UTTERANCE_MS: int = 250  # shorter utterances are treated as noise
    VAD_MIN_RMS: int = 300  # energy gate on 16-bit PCM to ignore line hiss
    # Barge-in while the agent is talking: echo / noise must not cut the agent off.
    BARGE_IN_GRACE_MS: int = 800  # ignore speech-start for this long after agent audio begins (echo window)
    BARGE_IN_MIN_SPEECH_MS: int = 1200  # loud speech needed to interrupt immediately (a real sentence)
    BARGE_IN_MIN_RMS: int = 600  # "loud" threshold for the above (16-bit PCM RMS)
    # Shorter / quieter speech interrupts only if STT finds real words in it.
    MAX_UTTERANCE_SECONDS: int = 25

    @field_validator("PUBLIC_BASE_URL")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        return v.rstrip("/")

    # ---------- derived helpers ----------
    @property
    def is_production(self) -> bool:
        return self.APP_ENV.lower() == "production"

    @property
    def cors_origins(self) -> List[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def sarvam_language_code(self) -> str:
        lang = self.CALL_LANGUAGE.strip()
        if "-" in lang or lang == "unknown":
            return lang
        return SARVAM_LANGUAGE_CODES.get(lang.lower(), "unknown")

    @property
    def public_ws_base_url(self) -> str:
        if self.PUBLIC_BASE_URL.startswith("https://"):
            return "wss://" + self.PUBLIC_BASE_URL[len("https://"):]
        if self.PUBLIC_BASE_URL.startswith("http://"):
            return "ws://" + self.PUBLIC_BASE_URL[len("http://"):]
        return self.PUBLIC_BASE_URL

    def database_url(self, sync: bool = False) -> URL | str:
        if self.DATABASE_URL:
            url = self.DATABASE_URL
            if sync:
                url = url.replace("+aiosqlite", "").replace("+aiomysql", "+pymysql")
            return url
        return URL.create(
            drivername="mysql+pymysql" if sync else "mysql+aiomysql",
            username=self.MYSQL_USER,
            password=self.MYSQL_PASSWORD.get_secret_value() or None,
            host=self.MYSQL_HOST,
            port=self.MYSQL_PORT,
            database=self.MYSQL_DATABASE,
            query={"charset": "utf8mb4"},
        )

    # ---------- provider configuration checks (never return values) ----------
    def plivo_configured(self) -> bool:
        return bool(self.PLIVO_AUTH_ID and self.PLIVO_AUTH_TOKEN.get_secret_value() and self.PLIVO_FROM_NUMBER)

    def twilio_configured(self) -> bool:
        return bool(self.TWILIO_ACCOUNT_SID and self.TWILIO_AUTH_TOKEN.get_secret_value() and self.TWILIO_FROM_NUMBER)

    @property
    def voice_rotation(self) -> list:
        return [v.strip() for v in self.CARTESIA_VOICE_ROTATION.split(",") if v.strip()]

    @property
    def telephony_provider(self) -> str:
        return (self.TELEPHONY_PROVIDER or "plivo").strip().lower()

    def telephony_configured(self) -> bool:
        return self.twilio_configured() if self.telephony_provider == "twilio" else self.plivo_configured()

    @property
    def telephony_from_number(self) -> str:
        return self.TWILIO_FROM_NUMBER if self.telephony_provider == "twilio" else self.PLIVO_FROM_NUMBER

    def sarvam_configured(self) -> bool:
        return bool(self.SARVAM_API_KEY.get_secret_value() and self.SARVAM_STT_MODEL)

    def cartesia_configured(self) -> bool:
        return bool(self.CARTESIA_API_KEY.get_secret_value() and self.CARTESIA_TTS_MODEL and self.CARTESIA_VOICE_ID)

    def llm_configured(self) -> bool:
        needs_key = self.LLM_PROVIDER.lower() not in ("ollama",)
        return bool(self.LLM_PROVIDER and self.LLM_MODEL and (self.LLM_API_KEY.get_secret_value() or not needs_key))

    def secret_values(self) -> List[str]:
        """All secret values, used by the log redaction filter."""
        vals = [
            self.PLIVO_AUTH_TOKEN, self.SARVAM_API_KEY, self.CARTESIA_API_KEY, self.LLM_API_KEY,
            self.MYSQL_PASSWORD, self.ADMIN_API_KEY, self.APP_SECRET_KEY, self.TWILIO_AUTH_TOKEN,
            self.STATUS_CALLBACK_SECRET,
        ]
        return [v.get_secret_value() for v in vals if v.get_secret_value() and len(v.get_secret_value()) >= 4]

    def validate_secrets(self) -> List[str]:
        """Return a list of configuration problems. Fatal in production, warnings otherwise."""
        problems: List[str] = []
        if len(self.ADMIN_API_KEY.get_secret_value()) < 16:
            problems.append("ADMIN_API_KEY must be set (min 16 chars) - protected APIs are disabled without it")
        if len(self.APP_SECRET_KEY.get_secret_value()) < 32:
            problems.append("APP_SECRET_KEY must be set (min 32 chars) - used to sign media-stream URLs")
        if not self.PUBLIC_BASE_URL.startswith("https://"):
            problems.append("PUBLIC_BASE_URL must be a public https:// URL (e.g. your ngrok URL)")
        if self.telephony_provider not in ("plivo", "twilio"):
            problems.append("TELEPHONY_PROVIDER must be 'plivo' or 'twilio'")
        elif self.telephony_provider == "twilio" and not self.twilio_configured():
            problems.append("Twilio is not fully configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER)")
        elif self.telephony_provider == "plivo" and not self.plivo_configured():
            problems.append("Plivo is not fully configured (PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN / PLIVO_FROM_NUMBER)")
        if not self.sarvam_configured():
            problems.append("Sarvam STT is not configured (SARVAM_API_KEY)")
        if not self.cartesia_configured():
            problems.append("Cartesia TTS is not configured (CARTESIA_API_KEY / CARTESIA_VOICE_ID)")
        if not self.llm_configured():
            problems.append("LLM is not configured (LLM_PROVIDER / LLM_MODEL / LLM_API_KEY)")
        return problems


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
