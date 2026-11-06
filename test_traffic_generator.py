import argparse
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import threading
import time
import unittest
import urllib.error
from unittest.mock import patch

import traffic_generator as pinger


class TrafficGeneratorTests(unittest.TestCase):
    def arguments(self, *extra):
        return pinger.parse_args([
            "--base-url", "http://127.0.0.1",
            "--users", "demo-1,demo-2",
            *extra,
        ])

    def test_defaults_and_user_controlled_load(self):
        args, _, _ = self.arguments()
        self.assertEqual((args.concurrency, args.interval), (1, 1))
        args, _, _ = self.arguments("--concurrency", "5", "--interval", "0.2")
        self.assertEqual((args.concurrency, args.interval, args.duration), (5, 0.2, 60))
        args, users, _ = self.arguments(
            "--until-stopped", "--concurrency", "100", "--interval", "0.01",
            "--users", ",".join(f"demo-{index}" for index in range(1, 101)),
        )
        self.assertEqual((args.concurrency, args.interval), (100, 0.01))
        self.assertEqual(len(users), 100)
        self.assertEqual((users[0], users[-1]), ("demo-1", "demo-100"))
        args, _, _ = self.arguments("--concurrency", "1000", "--interval", "0.001", "--duration", "3600")
        self.assertEqual((args.concurrency, args.interval, args.duration), (1000, 0.001, 3600))
        for extra in [
            ("--concurrency", "0"), ("--concurrency", "-1"),
            ("--interval", "0"), ("--interval", "-0.1"),
            ("--interval", "nan"), ("--interval", "inf"),
            ("--duration", "nan"), ("--duration", "inf"),
            ("--duration", "0"), ("--duration", "-1"),
        ]:
            with self.subTest(extra=extra), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.arguments(*extra)

    def test_target_authorization_and_path_guards_remain(self):
        for extra in [
            ("--base-url", "https://example.com"),
            ("--base-url", "http://example.com", "--confirm-authorized-target"),
            ("--base-url", "https://user:password@example.com", "--confirm-authorized-target"),
            ("--path", "//example.com/api/offers"),
        ]:
            with self.subTest(extra=extra), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.arguments(*extra)
        handler = pinger.NoRedirectHandler()
        self.assertIsNone(handler.redirect_request(None, None, 302, "", {}, "https://example.com"))

    def run_with_response(self, response, *, duration=1, interval=0.2, concurrency=5):
        args = argparse.Namespace(
            duration=duration, interval=interval, concurrency=concurrency,
            until_stopped=False,
            path=["/api/offers", "/api/festival"],
        )
        output = io.StringIO()
        with patch.object(pinger.urllib.request, "build_opener", return_value=response):
            with contextlib.redirect_stdout(output):
                result = pinger.run(args, ["demo-1", "demo-2"], "http://127.0.0.1")
        return result, output.getvalue()

    def test_global_rate_concurrency_body_timing_and_rotation(self):
        lock = threading.Lock()
        starts = []
        requests = []
        active = 0
        peak = 0

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                nonlocal active
                with lock:
                    active -= 1

            def read(self, limit):
                time.sleep(0.85)
                return b"[]"

        class Opener:
            def open(self, request, timeout):
                nonlocal active, peak
                with lock:
                    starts.append(time.monotonic())
                    requests.append(request)
                    active += 1
                    peak = max(peak, active)
                return Response()

        result, output = self.run_with_response(Opener(), duration=1.1)
        self.assertEqual(result, 0)
        self.assertGreaterEqual(peak, 2)
        self.assertLessEqual(peak, 5)
        self.assertLessEqual(len(starts), 6)
        self.assertTrue(all(b - a >= 0.19 for a, b in zip(starts, starts[1:])))
        self.assertEqual(requests[0].get_header("X-demo-user"), "demo-1")
        self.assertEqual(requests[1].get_header("X-demo-user"), "demo-2")
        self.assertTrue(requests[0].full_url.endswith("/api/offers"))
        self.assertTrue(requests[1].full_url.endswith("/api/festival"))
        self.assertEqual(active, 0)
        self.assertIn("p95=", output)
        self.assertNotIn("elapsed=0.00s", output)

    def test_error_stops_new_requests_and_drains_inflight(self):
        started = []
        finished = []
        error = urllib.error.HTTPError("http://127.0.0.1", 503, "unavailable", {}, None)

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                finished.append(True)

            def read(self, limit):
                time.sleep(0.2)
                return b"[]"

        class Opener:
            def open(self, request, timeout):
                started.append(time.monotonic())
                if len(started) == 1:
                    time.sleep(0.3)
                    raise error
                return Response()

        result, output = self.run_with_response(Opener())
        self.assertEqual(result, 1)
        self.assertEqual(len(started), 2)
        self.assertEqual(len(finished), 1)
        self.assertIn("status=503", output)
        self.assertIn("2 request(s), 1 failed", output)
        self.assertIn("Stopped new requests", output)

    def test_timeout_and_slow_success_stop(self):
        class TimeoutOpener:
            def open(self, request, timeout):
                raise TimeoutError("simulated timeout")

        result, output = self.run_with_response(TimeoutOpener())
        self.assertEqual(result, 1)
        self.assertIn("1 request(s), 1 failed", output)

        class SlowResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                pass

            def read(self, limit):
                time.sleep(0.08)
                return b"[]"

        class SlowOpener:
            def open(self, request, timeout):
                return SlowResponse()

        with patch.object(pinger, "STOP_LATENCY_SECONDS", 0.05):
            result, output = self.run_with_response(SlowOpener())
        self.assertEqual(result, 1)
        self.assertIn("1 request(s), 0 failed", output)
        self.assertIn("Stopped new requests", output)

    def test_sequential_default_over_local_http(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((time.monotonic(), self.path, self.headers["X-Demo-User"]))
                body = b"[]"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            args, users, _ = self.arguments()
            args.duration = 1.1
            with contextlib.redirect_stdout(io.StringIO()):
                result = pinger.run(args, users, f"http://127.0.0.1:{server.server_port}")
            self.assertEqual(result, 0)
            self.assertEqual(len(requests), 2)
            self.assertGreaterEqual(requests[1][0] - requests[0][0], 0.99)
            self.assertEqual(requests[0][1:], ("/api/offers", "demo-1"))
            self.assertEqual(requests[1][1:], ("/api/offers", "demo-2"))
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_manual_mode_continues_through_errors_until_interrupt(self):
        args, users, origin = self.arguments("--until-stopped", "--interval", "0.05", "--concurrency", "20")
        self.assertTrue(args.until_stopped)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.arguments("--until-stopped", "--duration", "60")

        calls = []

        class SlowResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                pass

            def read(self, limit):
                time.sleep(0.06)
                return b"[]"

        class Opener:
            def open(self, request, timeout):
                calls.append(timeout)
                if len(calls) == 1:
                    raise urllib.error.HTTPError(request.full_url, 503, "unavailable", {}, None)
                if len(calls) == 2:
                    return SlowResponse()
                raise TimeoutError("simulated timeout")

        original_wait = pinger.wait
        started = time.monotonic()

        def interrupt_after_errors(*a, **kw):
            if len(calls) >= 4:
                raise KeyboardInterrupt
            if time.monotonic() - started > 3:
                raise AssertionError("Manual mode did not send enough requests")
            return original_wait(*a, **kw)

        output = io.StringIO()
        with patch.object(pinger.urllib.request, "build_opener", return_value=Opener()), patch.object(pinger, "STOP_LATENCY_SECONDS", 0.01):
            with patch.object(pinger, "wait", side_effect=interrupt_after_errors):
                with contextlib.redirect_stdout(output):
                    result = pinger.run(args, users, origin)
        self.assertEqual(result, 130)
        self.assertGreaterEqual(len(calls), 4)
        self.assertTrue(all(timeout == 5 for timeout in calls))
        self.assertIn("status=503", output.getvalue())
        self.assertIn("status=200", output.getvalue())
        self.assertIn("simulated timeout", output.getvalue())
        self.assertIn("Manual stop complete", output.getvalue())


if __name__ == "__main__":
    unittest.main()
