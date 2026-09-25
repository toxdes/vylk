#!/usr/bin/env python3
"""Create a GitHub release and notify configured deployment hooks."""

from __future__ import annotations

import concurrent.futures
import json
import logging
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

TAG_PATTERN = re.compile(r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
HOOK_PREFIX = "VYLK_DEPLOY_HOOK_"
HOOK_URL_SUFFIX = "_URL"
INSTALLATION_NOTES = (
    "## Installation\n"
    "Check [install instructions](https://vylk.toxdes.com/docs/#install).\n"
)
MAX_RETRIES = 5
RETRY_DELAY_SECONDS = 5 * 60
REQUEST_TIMEOUT_SECONDS = 30

logger = logging.getLogger("release-deploy")


class ReleaseError(RuntimeError):
    """Raised when a release cannot be validated or created."""


class HookError(RuntimeError):
    """Raised when a deployment hook fails all attempts."""


class HTTPSPostRedirectHandler(HTTPRedirectHandler):
    """Follow only secure redirects that preserve the hook's POST request."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if code not in (307, 308):
            return None
        source = urlparse(req.full_url)
        target = urlparse(newurl)
        if (
            source.scheme != "https"
            or target.scheme != "https"
            or not target.netloc
        ):
            return None
        request_headers = {
            name: value
            for name, value in req.header_items()
            if name.lower() not in {"content-length", "host"}
        }
        return Request(
            newurl,
            data=req.data,
            headers=request_headers,
            origin_req_host=req.origin_req_host,
            unverifiable=True,
            method=req.get_method(),
        )


@dataclass(frozen=True)
class Hook:
    name: str
    url: str


def run_git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise ReleaseError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout.strip()


def parse_release_tag(tag: str) -> tuple[int, int, int]:
    match = TAG_PATTERN.fullmatch(tag)
    if not match:
        raise ReleaseError(f"{tag!r} is not a stable vX.Y.Z release tag")
    return tuple(int(part) for part in match.groups())


def select_previous_tag(current_tag: str, candidates: Iterable[str]) -> str | None:
    current_version = parse_release_tag(current_tag)
    previous = []
    for candidate in candidates:
        if candidate == current_tag:
            continue
        try:
            version = parse_release_tag(candidate)
        except ReleaseError:
            continue
        if version < current_version:
            previous.append((version, candidate))
    return max(previous, default=(None, None))[1]


def previous_release_tag(commit: str) -> str | None:
    tags = run_git(
        "for-each-ref",
        f"--merged={commit}",
        "--format=%(refname:strip=2)",
        "refs/tags/v*",
    ).splitlines()
    return select_previous_tag(os.environ["GITHUB_REF_NAME"], tags)


def validate_tag(tag: str, commit: str) -> tuple[str, str | None]:
    version = parse_release_tag(tag)
    try:
        run_git("merge-base", "--is-ancestor", commit, "origin/main")
    except ReleaseError as error:
        raise ReleaseError(f"tag {tag} does not point to a commit on main") from error

    committed_version = run_git("show", f"{commit}:VERSION")
    expected_version = ".".join(str(part) for part in version)
    if committed_version != expected_version:
        raise ReleaseError(
            f"tag {tag} expects VERSION {expected_version}, found {committed_version}"
        )
    return committed_version, previous_release_tag(commit)


class GitHubAPI:
    def __init__(self, token: str, repository: str, api_url: str) -> None:
        self._token = token
        self._repository = repository
        self._api_url = api_url.rstrip("/")

    def request(self, method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
        body = None if payload is None else json.dumps(payload).encode()
        request = Request(
            urljoin(
                f"{self._api_url}/",
                f"repos/{self._repository}/{path.lstrip('/')}"
            ),
            data=body,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                response_body = response.read().decode()
                return response.status, json.loads(response_body or "{}")
        except HTTPError as error:
            response_body = error.read().decode()
            details = json.loads(response_body or "{}")
            if error.code == 404:
                return error.code, details
            raise ReleaseError(
                f"GitHub API {method} {path} returned HTTP {error.code}"
            ) from error
        except (URLError, TimeoutError, OSError) as error:
            raise ReleaseError(f"GitHub API {method} {path} failed") from error

    def release_for_tag(self, tag: str) -> dict | None:
        status, body = self.request("GET", f"releases/tags/{tag}")
        if status == 404:
            return None
        return body

    def generate_notes(self, tag: str, commit: str, previous_tag: str | None) -> dict:
        payload = {"tag_name": tag, "target_commitish": commit}
        if previous_tag:
            payload["previous_tag_name"] = previous_tag
        status, body = self.request("POST", "releases/generate-notes", payload)
        if status != 200:
            raise ReleaseError(f"GitHub generated-notes API returned HTTP {status}")
        return body

    def create_release(self, tag: str, commit: str, name: str, body: str) -> dict:
        status, response = self.request(
            "POST",
            "releases",
            {
                "tag_name": tag,
                "target_commitish": commit,
                "name": name,
                "body": body,
                "draft": False,
                "prerelease": False,
                "generate_release_notes": False,
                "make_latest": "true",
            },
        )
        if status != 201:
            raise ReleaseError(f"GitHub release API returned HTTP {status}")
        return response


def ensure_release(
    api: GitHubAPI, tag: str, commit: str, previous_tag: str | None
) -> dict:
    existing = api.release_for_tag(tag)
    if existing:
        logger.info("release %s already exists; reusing it", tag)
        return existing
    notes = api.generate_notes(tag, commit, previous_tag)
    body = f"{INSTALLATION_NOTES}\n{notes.get('body', '').lstrip()}"
    return api.create_release(tag, commit, notes.get("name") or tag, body)


def configured_hooks(environment: dict[str, str] | None = None) -> list[Hook]:
    values = os.environ if environment is None else environment
    hooks = []
    for variable, value in values.items():
        if not (
            variable.startswith(HOOK_PREFIX)
            and variable.endswith(HOOK_URL_SUFFIX)
            and value.strip()
        ):
            continue
        name = variable[len(HOOK_PREFIX) : -len(HOOK_URL_SUFFIX)]
        url = value.strip()
        parsed = urlparse(url)
        if not name or parsed.scheme != "https" or not parsed.netloc:
            raise ReleaseError(f"{variable} must contain a valid HTTPS URL")
        hooks.append(Hook(name=name, url=url))
    return sorted(hooks, key=lambda hook: hook.name)


def post_json(url: str, payload: dict) -> int:
    request = Request(
        url,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        opener = build_opener(HTTPSPostRedirectHandler())
        with opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            response.read(4096)
            return response.status
    except HTTPError as error:
        return error.code
    except (URLError, TimeoutError, OSError) as error:
        raise HookError("request failed") from error


def dispatch_hook(
    hook: Hook,
    payload: dict,
    request: Callable[[str, dict], int] = post_json,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    for attempt in range(MAX_RETRIES + 1):
        try:
            status = request(hook.url, payload)
            if 200 <= status < 300:
                logger.info("hook %s succeeded on attempt %d", hook.name, attempt + 1)
                return
            reason = f"HTTP {status}"
        except HookError as error:
            reason = str(error)
        if attempt == MAX_RETRIES:
            raise HookError(f"hook {hook.name} failed after {attempt + 1} attempts ({reason})")
        logger.warning(
            "hook %s failed (%s); retrying in %d seconds",
            hook.name,
            reason,
            RETRY_DELAY_SECONDS,
        )
        sleep(RETRY_DELAY_SECONDS)


def dispatch_hooks(
    hooks: list[Hook],
    payload: dict,
    request: Callable[[str, dict], int] = post_json,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(hooks)) as executor:
        futures = {
            executor.submit(dispatch_hook, hook, payload, request, sleep): hook
            for hook in hooks
        }
        for future in concurrent.futures.as_completed(futures):
            hook = futures[future]
            try:
                future.result()
            except HookError as error:
                failures.append(str(error))
                logger.error("%s", error)
    if failures:
        raise HookError("; ".join(sorted(failures)))


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    tag = os.environ.get("GITHUB_REF_NAME", "")
    commit = os.environ.get("GITHUB_SHA", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    if not tag or not commit or not token or not repository:
        logger.error("GitHub tag, commit, repository, and token context are required")
        return 1

    try:
        version, previous_tag = validate_tag(tag, commit)
        hooks = configured_hooks()
        if not hooks:
            raise ReleaseError("no VYLK_DEPLOY_HOOK_<NAME>_URL secrets are configured")
        api = GitHubAPI(
            token,
            repository,
            os.environ.get("GITHUB_API_URL", "https://api.github.com"),
        )
        ensure_release(api, tag, commit, previous_tag)
        dispatch_hooks(
            hooks,
            {
                "event": "release",
                "version": version,
                "tag": tag,
                "commit": commit,
                "repository": repository,
                "ref": f"refs/tags/{tag}",
            },
        )
    except (ReleaseError, HookError) as error:
        logger.error("%s", error)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
