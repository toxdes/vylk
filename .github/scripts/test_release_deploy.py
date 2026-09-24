import unittest
from unittest.mock import Mock

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


class HookTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
