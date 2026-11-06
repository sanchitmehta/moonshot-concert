#!/usr/bin/env python3
"""Send rate-limited demo traffic to the Moonshot Fest API."""

import argparse
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import math
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


MAX_DURATION_SECONDS = 300
MIN_INTERVAL_SECONDS = 0.01
MAX_CONCURRENCY = 100
MAX_SPIKE_DURATION_SECONDS = 60
STOP_LATENCY_SECONDS = 3
REQUEST_TIMEOUT_SECONDS = 5


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="HTTPS origin serving storefront-web and storefront-api")
    parser.add_argument(
        "--path",
        action="append",
        default=None,
        help="Storefront API path; repeat to cycle through endpoints (default: /api/offers)",
    )
    parser.add_argument("--users", required=True, help="Comma-separated demo user IDs")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--duration", type=float, help="Run time in seconds (1-300; default: 60)")
    mode.add_argument("--until-stopped", action="store_true", help="Run until Ctrl+C, including through errors and slow responses")
    parser.add_argument("--interval", type=float, default=1, help="Seconds between request starts globally (minimum: 0.01; default: 1)")
    parser.add_argument("--concurrency", type=int, default=1, help="Maximum in-flight requests (1-100; default: 1)")
    parser.add_argument(
        "--confirm-authorized-target",
        action="store_true",
        help="Required when sending traffic to a non-local target you are authorized to test",
    )
    args = parser.parse_args(argv)
    if args.duration is None:
        args.duration = 60
    args.path = args.path or ["/api/offers"]

    parsed_url = urllib.parse.urlsplit(args.base_url)
    if (
        parsed_url.scheme not in ("http", "https")
        or not parsed_url.hostname
        or parsed_url.username
        or parsed_url.password
        or parsed_url.query
        or parsed_url.fragment
        or parsed_url.path not in ("", "/")
    ):
        parser.error("--base-url must be an origin URL without credentials, path, query, or fragment")

    is_local = parsed_url.hostname.lower() in ("localhost", "127.0.0.1", "::1")
    if parsed_url.scheme != "https" and not (is_local and parsed_url.scheme == "http"):
        parser.error("Use HTTPS for non-local targets")
    if not is_local and not args.confirm_authorized_target:
        parser.error("Pass --confirm-authorized-target only for a system you are authorized to test")

    for path in args.path:
        parsed_path = urllib.parse.urlsplit(path)
        if not path.startswith("/") or path.startswith("//") or parsed_path.scheme or parsed_path.netloc or parsed_path.fragment or "\\" in path:
            parser.error(f"Invalid API path: {path}")

    users = [user.strip() for user in args.users.split(",") if user.strip()]
    if not users:
        parser.error("--users must contain at least one user ID")
    if any("\r" in user or "\n" in user for user in users):
        parser.error("User IDs cannot contain newlines")
    if not 1 <= args.duration <= MAX_DURATION_SECONDS:
        parser.error(f"--duration must be between 1 and {MAX_DURATION_SECONDS} seconds")
    if not math.isfinite(args.interval) or args.interval < MIN_INTERVAL_SECONDS:
        parser.error(f"--interval must be at least {MIN_INTERVAL_SECONDS:g} second")
    if not 1 <= args.concurrency <= MAX_CONCURRENCY:
        parser.error(f"--concurrency must be between 1 and {MAX_CONCURRENCY}")
    if not args.until_stopped and (args.concurrency > 1 or args.interval < 1) and args.duration > MAX_SPIKE_DURATION_SECONDS:
        parser.error(f"Traffic spikes must not exceed {MAX_SPIKE_DURATION_SECONDS} seconds")

    return args, users, f"{parsed_url.scheme}://{parsed_url.netloc}"


def run(args, users, origin):
    deadline = math.inf if args.until_stopped else time.monotonic() + args.duration
    stop = threading.Event()
    start_lock = threading.Lock()
    last_start = None
    sent = 0
    failed = 0
    latencies = deque(maxlen=10_000)

    def send(sequence):
        nonlocal last_start
        # Pace actual starts globally; worker delays must not produce a burst.
        with start_lock:
            if last_start is not None:
                delay = max(0, last_start + args.interval - time.monotonic())
                stop.wait(min(delay, max(0, deadline - time.monotonic())))
            if stop.is_set() or time.monotonic() >= deadline:
                return None
            started_at = time.monotonic()
            last_start = started_at

        user = users[sequence % len(users)]
        path = args.path[sequence % len(args.path)]
        request = urllib.request.Request(origin + path, headers={"X-Demo-User": user})
        opener = urllib.request.build_opener(NoRedirectHandler())
        status = None
        error_text = None
        try:
            timeout = REQUEST_TIMEOUT_SECONDS if args.until_stopped else min(REQUEST_TIMEOUT_SECONDS, STOP_LATENCY_SECONDS)
            with opener.open(request, timeout=timeout) as response:
                status = response.status
                # Include body transfer in latency, with a bounded observation size.
                if len(response.read(1_048_577)) > 1_048_576:
                    error_text = "Response exceeds 1 MiB observation limit"
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            error_text = str(error)

        elapsed = time.monotonic() - started_at
        request_failed = error_text is not None or status is None or status >= 300
        slow = elapsed >= STOP_LATENCY_SECONDS
        if not args.until_stopped and (request_failed or slow):
            stop.set()
        details = f"error={error_text}" if error_text is not None else f"status={status}"
        print(f"{sequence + 1}: user={user} path={path} {details} elapsed={elapsed:.2f}s", flush=True)
        return elapsed, request_failed, slow

    print(f"Sending to {len(args.path)} path(s) as {len(users)} demo user(s); "
          f"concurrency={args.concurrency}, global interval={args.interval:g}s.")
    if args.until_stopped:
        print("Manual-stop mode: errors and slow responses do not stop traffic. Press Ctrl+C to stop.")
    pending = set()
    sequence = 0
    slow_count = 0
    interrupted = False

    def collect(futures):
        nonlocal sent, failed, slow_count
        for future in futures:
            result = future.result()
            if result is None:
                continue
            elapsed, request_failed, slow = result
            sent += 1
            failed += request_failed
            slow_count += slow
            latencies.append(elapsed)

    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        try:
            while pending or (not stop.is_set() and time.monotonic() < deadline):
                while not stop.is_set() and time.monotonic() < deadline and len(pending) < args.concurrency:
                    pending.add(executor.submit(send, sequence))
                    sequence += 1
                if not pending:
                    break
                completed, _ = wait(pending, timeout=0.1, return_when=FIRST_COMPLETED)
                collect(completed)
                pending.difference_update(completed)
        except KeyboardInterrupt:
            interrupted = True
            stop.set()
            print("\nCtrl+C received: stopping new requests and draining in-flight requests.", flush=True)
            collect(pending)
        finally:
            stop.set()

    if interrupted:
        print("Manual stop complete. In-flight requests drained.")
    elif failed or slow_count:
        print("Stopped new requests: HTTP error, transport error, or latency threshold reached. In-flight requests drained.")
    if latencies:
        window = sorted(latencies)
        print(f"Latency (last {len(window)} completed requests): "
              f"p50={window[math.ceil(len(window) * 0.50) - 1]:.2f}s "
              f"p95={window[math.ceil(len(window) * 0.95) - 1]:.2f}s max={window[-1]:.2f}s")
    print(f"Finished: {sent} request(s), {failed} failed.")
    if interrupted:
        return 130
    return 1 if failed or slow_count else 0


def main():
    args, users, origin = parse_args()
    return run(args, users, origin)


if __name__ == "__main__":
    sys.exit(main())
