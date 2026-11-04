#!/usr/bin/env python3
"""Send bounded, sequential demo traffic to configured API paths."""

import argparse
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


MAX_DURATION_SECONDS = 300
MIN_INTERVAL_SECONDS = 1.0
REQUEST_TIMEOUT_SECONDS = 5


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="HTTPS API origin, such as https://demo.example.com")
    parser.add_argument("--path", action="append", required=True, help="API path; repeat to cycle through endpoints")
    parser.add_argument("--users", required=True, help="Comma-separated demo user IDs")
    parser.add_argument("--duration", type=float, default=60, help="Run time in seconds (1-300; default: 60)")
    parser.add_argument("--interval", type=float, default=1, help="Seconds between requests (minimum: 1)")
    parser.add_argument(
        "--confirm-authorized-target",
        action="store_true",
        help="Required when sending traffic to a non-local target you are authorized to test",
    )
    args = parser.parse_args()

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

    return args, users, f"{parsed_url.scheme}://{parsed_url.netloc}"


def main():
    args, users, origin = parse_args()
    opener = urllib.request.build_opener(NoRedirectHandler())
    deadline = time.monotonic() + args.duration
    next_request_at = time.monotonic()
    sent = 0
    failed = 0

    print(f"Sending sequential requests to {len(args.path)} path(s) as {len(users)} demo user(s).")
    while time.monotonic() < deadline:
        if sent and next_request_at > time.monotonic():
            time.sleep(min(next_request_at - time.monotonic(), max(0, deadline - time.monotonic())))
        if time.monotonic() >= deadline:
            break

        user = users[sent % len(users)]
        path = args.path[sent % len(args.path)]
        request = urllib.request.Request(origin + path, headers={"X-Demo-User": user})
        started_at = time.monotonic()
        try:
            with opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            failed += 1
            print(f"{sent + 1}: user={user} path={path} error={error}")
            sent += 1
            next_request_at = started_at + args.interval
            continue

        elapsed = time.monotonic() - started_at
        if status >= 300:
            failed += 1
        print(f"{sent + 1}: user={user} path={path} status={status} elapsed={elapsed:.2f}s")
        sent += 1
        next_request_at = started_at + args.interval

    print(f"Finished: {sent} request(s), {failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
