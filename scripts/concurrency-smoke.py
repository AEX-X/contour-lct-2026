"""Authenticated 20-session concurrency smoke for a running Contour API."""

from __future__ import annotations

import argparse
import json
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ACCOUNTS = (
    ("manager", "manager123", "usr_manager"),
    ("senior_dispatcher", "senior123", "usr_senior_dispatcher"),
    ("dispatcher", "dispatcher123", "usr_dispatcher"),
    ("coordinator", "coordinator123", "usr_coordinator"),
    ("engineer", "engineer123", "usr_engineer"),
)


def request_json(
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    method: str = "GET",
    body: dict[str, object] | None = None,
    timeout: float = 30,
) -> dict[str, object]:
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    request = Request(f"{base_url.rstrip('/')}{path}", data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = response.read()
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"{method} {path}: HTTP {response.status}")
            return json.loads(payload) if payload else {}
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path}: HTTP {exc.code}: {details[:300]}") from exc
    except URLError as exc:
        raise RuntimeError(f"{method} {path}: {exc.reason}") from exc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--users", type=int, default=20)
    args = parser.parse_args()
    if args.users < 1:
        parser.error("--users must be positive")

    sessions: list[tuple[str, str, str]] = []
    for index in range(args.users):
        username, password, expected_user_id = ACCOUNTS[index % len(ACCOUNTS)]
        login = request_json(
            args.base_url,
            "/api/v1/auth/login",
            method="POST",
            body={"username": username, "password": password},
        )
        token = login.get("token")
        if not isinstance(token, str) or not token:
            raise RuntimeError(f"login {username}: token missing")
        sessions.append((username, expected_user_id, token))

    barrier = threading.Barrier(args.users)

    def user_flow(username: str, expected_user_id: str, token: str) -> tuple[str, float]:
        barrier.wait(timeout=30)
        started = time.perf_counter()
        me = request_json(args.base_url, "/api/v1/me", token=token)
        facilities = request_json(args.base_url, "/api/v1/facilities?limit=20", token=token)
        if me.get("user_id") != expected_user_id:
            raise RuntimeError(f"session isolation failed for {username}")
        if not isinstance(facilities.get("data"), list):
            raise RuntimeError(f"facility envelope malformed for {username}")
        return username, time.perf_counter() - started

    failures: list[str] = []
    durations: list[float] = []
    with ThreadPoolExecutor(max_workers=args.users) as executor:
        futures = [
            executor.submit(user_flow, username, expected_user_id, token)
            for username, expected_user_id, token in sessions
        ]
        for future in as_completed(futures):
            try:
                _, duration = future.result()
                durations.append(duration)
            except Exception as exc:  # noqa: BLE001 - smoke must report every worker failure
                failures.append(str(exc))

    for _, _, token in sessions:
        try:
            request_json(args.base_url, "/api/v1/auth/logout", token=token, method="POST")
        except Exception as exc:  # noqa: BLE001 - cleanup failures are part of the result
            failures.append(f"logout: {exc}")

    ordered = sorted(durations)
    p95_index = max(0, min(len(ordered) - 1, int(len(ordered) * 0.95) - 1)) if ordered else 0
    summary = {
        "sessions": args.users,
        "completed": len(durations),
        "failed": len(failures),
        "median_seconds": round(statistics.median(durations), 3) if durations else None,
        "p95_seconds": round(ordered[p95_index], 3) if ordered else None,
        "max_seconds": round(max(durations), 3) if durations else None,
        "errors": failures[:10],
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 1 if failures or len(durations) != args.users else 0


if __name__ == "__main__":
    raise SystemExit(main())
