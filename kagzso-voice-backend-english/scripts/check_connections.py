"""Check MySQL connectivity using the values in .env.

    python scripts/check_connections.py

Prints results only - never prints passwords.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import settings  # noqa: E402


async def check_mysql() -> bool:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    print(f"MySQL  -> {settings.MYSQL_USER}@{settings.MYSQL_HOST}:{settings.MYSQL_PORT}/{settings.MYSQL_DATABASE}")
    engine = create_async_engine(settings.database_url())
    try:
        async with engine.connect() as conn:
            version = (await conn.execute(text("SELECT VERSION()"))).scalar()
            print(f"  OK   server version {version}")
            try:
                rev = (await conn.execute(text("SELECT version_num FROM alembic_version"))).scalar()
                print(f"  OK   migrations applied (revision {rev})")
            except Exception:
                print("  WARN tables not created yet - run: alembic upgrade head")
        return True
    except Exception as exc:
        msg = str(exc).splitlines()[0][:200]
        for secret in settings.secret_values():
            msg = msg.replace(secret, "****")
        print(f"  FAIL {type(exc).__name__}: {msg}")
        return False
    finally:
        await engine.dispose()


async def main() -> int:
    return 0 if await check_mysql() else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
