import unittest
from urllib.request import Request
from unittest.mock import Mock, patch

import release_deploy


class ReleaseTagTests(unittest.TestCase):
    def test_selects_latest_prior_stable_tag(self):
        self.assertEqual(
            release_deploy.select_previous_tag(
                "v3.0.5", ["v3.0.1", "v3.0.4", "v3.0.3", "nightly"]
            ),
            "v3.0.4",
        )

    def test_ignores_current_and_future_tags(self):
        self.assertEqual(
            release_deploy.select_previous_tag("v3.0.5", ["v3.0.5", "v3.0.6"]),
            None,
        )

    def test_rejects_non_release_tag(self):
        with self.assertRaises(release_deploy.ReleaseError):
            release_deploy.parse_release_tag("nightly")

    def test_rejects_version_older_than_latest_stable_tag(self):
        message = "older than stable tag v3.0.4"
        with self.assertRaisesRegex(release_deploy.ReleaseError, message):
            release_deploy.ensure_not_older_than_latest(
                "v3.0.2", ["v3.0.1", "v3.0.4"]
            )

    def test_allows_newer_version_than_latest_stable_tag(self):
        release_deploy.ensure_not_older_than_latest("v3.0.5", ["v3.0.4", "nightly"])

    def test_ignores_non_stable_tags_when_finding_latest(self):
        self.assertEqual(
            release_deploy.latest_stable_tag(["nightly", "v3.0.2", "v3.0.4-rc.1"]),
            "v3.0.2",
        )

    def test_validate_tag_rejects_old_version_on_main(self):
        def git(*args):
            if args[0] == "show":
                return "3.0.2"
            if args[0] == "tag" and "origin/main" in args:
                return "v3.0.4\nv3.0.2"
            return ""

        with patch.object(release_deploy, "run_git", side_effect=git):
            with self.assertRaisesRegex(
                release_deploy.ReleaseError, "older than stable tag v3.0.4"
            ):
                release_deploy.validate_tag("v3.0.2", "commit")

    def test_manual_rollback_requires_main_and_exact_confirmation(self):
        environment = {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main",
            "VYLK_ROLLBACK_TAG": "v3.0.2",
            "VYLK_ROLLBACK_CONFIRMATION": "ROLLBACK v3.0.2",
        }
        with patch.object(release_deploy, "run_git", return_value="commit") as run_git:
            self.assertEqual(
                release_deploy.release_target(environment),
                ("v3.0.2", "commit", True),
            )
        run_git.assert_called_once_with(
            "rev-parse", "--verify", "refs/tags/v3.0.2^{commit}"
        )

    def test_manual_rollback_rejects_wrong_branch_or_confirmation(self):
        base_environment = {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main",
            "VYLK_ROLLBACK_TAG": "v3.0.2",
            "VYLK_ROLLBACK_CONFIRMATION": "ROLLBACK v3.0.2",
        }
        invalid_environments = (
            {**base_environment, "GITHUB_REF": "refs/heads/feature"},
            {**base_environment, "VYLK_ROLLBACK_CONFIRMATION": "ROLLBACK v3.0.4"},
        )
        for environment in invalid_environments:
            with self.subTest(environment=environment):
                with patch.object(release_deploy, "run_git") as run_git:
                    with self.assertRaises(release_deploy.ReleaseError):
                        release_deploy.release_target(environment)
                run_git.assert_not_called()

    def test_validate_tag_allows_explicit_rollback(self):
        def git(*args):
            if args[0] == "show":
                return "3.0.2"
            if args[0] == "tag":
                return "v3.0.1\nv3.0.2"
            return ""

        with patch.object(release_deploy, "run_git", side_effect=git):
            self.assertEqual(
                release_deploy.validate_tag("v3.0.2", "commit", allow_rollback=True),
                ("3.0.2", "v3.0.1"),
            )


class HookTests(unittest.TestCase):
    def test_follows_https_redirects_that_preserve_post(self):
        handler = release_deploy.HTTPSPostRedirectHandler()
        request = Request(
            "https://hooks.example.test/start",
            data=b'{"event":"release"}',
            method="POST",
        )

        for status in (307, 308):
            with self.subTest(status=status):
                redirected = handler.redirect_request(
                    request,
                    None,
                    status,
                    "Temporary Redirect",
                    {},
                    "https://hooks.example.test/final",
                )
                self.assertIsNotNone(redirected)
                self.assertEqual(redirected.get_method(), "POST")
                self.assertEqual(redirected.data, request.data)

    def test_rejects_redirects_that_downgrade_or_change_method(self):
        handler = release_deploy.HTTPSPostRedirectHandler()
        request = Request(
            "https://hooks.example.test/start", data=b"{}", method="POST"
        )

        rejected_redirects = (
            (307, "http://hooks.example.test/final"),
            (301, "https://hooks.example.test/final"),
            (302, "https://hooks.example.test/final"),
            (303, "https://hooks.example.test/final"),
            (308, "https:///final"),
        )
        for status, target in rejected_redirects:
            with self.subTest(status=status, target=target):
                redirected = handler.redirect_request(
                    request, None, status, "Redirect", {}, target
                )
                self.assertIsNone(redirected)

    def test_discovers_named_hooks_without_exposing_values(self):
        hooks = release_deploy.configured_hooks(
            {
                "VYLK_DEPLOY_HOOK_RENDER_URL": "https://example.test/render",
                "VYLK_DEPLOY_HOOK_LANDER_URL": " https://example.test/lander ",
                "UNRELATED": "ignored",
            }
        )
        self.assertEqual(
            [(hook.name, hook.url) for hook in hooks],
            [
                ("LANDER", "https://example.test/lander"),
                ("RENDER", "https://example.test/render"),
            ],
        )

    def test_rejects_non_https_hook_urls(self):
        with self.assertRaises(release_deploy.ReleaseError):
            release_deploy.configured_hooks(
                {"VYLK_DEPLOY_HOOK_RENDER_URL": "http://example.test/render"}
            )

    def test_ignores_non_url_hook_variables(self):
        self.assertEqual(
            release_deploy.configured_hooks(
                {"VYLK_DEPLOY_HOOK_RENDER_TOKEN": "secret"}
            ),
            [],
        )

    def test_accepts_any_successful_two_xx_response(self):
        for status in (200, 201, 202, 204):
            with self.subTest(status=status):
                release_deploy.dispatch_hook(
                    release_deploy.Hook("test", "https://example.test"),
                    {},
                    request=lambda _url, _payload, status=status: status,
                    sleep=lambda _delay: self.fail("successful hook should not sleep"),
                )

    def test_retries_only_until_success(self):
        responses = iter((500, 503, 202))
        delays = []
        release_deploy.dispatch_hook(
            release_deploy.Hook("test", "https://example.test"),
            {},
            request=lambda _url, _payload: next(responses),
            sleep=delays.append,
        )
        self.assertEqual(delays, [release_deploy.RETRY_DELAY_SECONDS] * 2)

    def test_exhausted_hook_raises(self):
        attempts = []
        with self.assertRaises(release_deploy.HookError):
            release_deploy.dispatch_hook(
                release_deploy.Hook("test", "https://example.test"),
                {},
                request=lambda _url, _payload: attempts.append(500) or 500,
                sleep=lambda _delay: None,
            )
        self.assertEqual(len(attempts), release_deploy.MAX_RETRIES + 1)

    def test_dispatches_other_hooks_when_one_fails(self):
        attempts = []

        def request(url, _payload):
            attempts.append(url)
            return 500 if url.endswith("/failed") else 202

        with self.assertRaises(release_deploy.HookError):
            release_deploy.dispatch_hooks(
                [
                    release_deploy.Hook("failed", "https://example.test/failed"),
                    release_deploy.Hook("healthy", "https://example.test/healthy"),
                ],
                {},
                request=request,
                sleep=lambda _delay: None,
            )

        self.assertEqual(attempts.count("https://example.test/failed"), 6)
        self.assertEqual(attempts.count("https://example.test/healthy"), 1)


class ReleaseBodyTests(unittest.TestCase):
    def test_existing_release_is_reused(self):
        api = Mock()
        api.release_for_tag.return_value = {"tag_name": "v3.0.5"}
        self.assertEqual(
            release_deploy.ensure_release(api, "v3.0.5", "abc", "v3.0.4"),
            {"tag_name": "v3.0.5"},
        )
        api.generate_notes.assert_not_called()
        api.create_release.assert_not_called()

    def test_new_release_prepends_installation_notes(self):
        api = Mock()
        api.release_for_tag.return_value = None
        api.generate_notes.return_value = {
            "name": "Release v3.0.5",
            "body": "## What's changed\n- Improvements",
        }
        api.create_release.return_value = {"tag_name": "v3.0.5"}

        release_deploy.ensure_release(api, "v3.0.5", "abc", "v3.0.4")

        api.create_release.assert_called_once_with(
            "v3.0.5",
            "abc",
            "Release v3.0.5",
            "## Installation\n"
            "Check [install instructions](https://vylk.toxdes.com/docs/#install).\n\n"
            "## What's changed\n- Improvements",
        )

    def test_new_release_uses_legacy_latest_selection(self):
        api = release_deploy.GitHubAPI("token", "owner/repo", "https://api.github.com")
        with patch.object(api, "request", return_value=(201, {})) as request:
            api.create_release("v3.0.5", "abc", "Release v3.0.5", "notes")

        self.assertEqual(request.call_args.args[2]["make_latest"], "legacy")


class HookIdempotencyTests(unittest.TestCase):
    def test_post_sends_the_stable_idempotency_key_header(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.status = 202
        opener = Mock()
        opener.open.return_value = response
        payload = {"idempotency_key": "release:v3.0.5:abc"}

        with patch.object(release_deploy, "build_opener", return_value=opener):
            self.assertEqual(release_deploy.post_json("https://example.test", payload), 202)

        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header("Idempotency-key"), payload["idempotency_key"])


if __name__ == "__main__":
    unittest.main()
