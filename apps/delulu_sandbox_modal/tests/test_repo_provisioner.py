"""Unit tests for pure-python logic in ``delulu_sandbox_modal.repo_provisioner``.

The git-subprocess helpers (``_clone_bare``, ``_fetch_bare``,
``_ensure_worktree``) aren't tested here — they're thin wrappers
around ``git`` and exercising them requires either a real git
install + temp repo fixture or extensive mocking, neither of which
pays for itself at the current project test-infra level.

What IS worth testing is ``_parse_repo_url``: it's pure, has non-
trivial branching (https vs ssh, trailing .git, owner/repo
validation), and a bug here would silently point at the wrong cache
directory. Cheap insurance.
"""

from __future__ import annotations

import os

import pytest

from delulu_sandbox_modal.repo_provisioner import _parse_repo_url


class TestParseRepoUrl:
    def test_https_github(self):
        assert _parse_repo_url("https://github.com/alice/api-service") == (
            "github.com",
            "alice",
            "api-service",
        )

    def test_https_github_trailing_git(self):
        assert _parse_repo_url("https://github.com/alice/api-service.git") == (
            "github.com",
            "alice",
            "api-service",
        )

    def test_https_github_trailing_slash(self):
        assert _parse_repo_url("https://github.com/alice/api-service/") == (
            "github.com",
            "alice",
            "api-service",
        )

    def test_https_github_trailing_git_and_slash(self):
        # Both normalized away — trailing .git is stripped first, then
        # trailing slash. Order matters.
        assert _parse_repo_url("https://github.com/alice/api-service.git/") == (
            "github.com",
            "alice",
            "api-service",
        )

    def test_https_gitlab(self):
        # Different host — the cache layout slots it under the host dir.
        assert _parse_repo_url("https://gitlab.com/bob/library") == (
            "gitlab.com",
            "bob",
            "library",
        )

    def test_ssh_github(self):
        assert _parse_repo_url("git@github.com:alice/api-service") == (
            "github.com",
            "alice",
            "api-service",
        )

    def test_ssh_github_trailing_git(self):
        assert _parse_repo_url("git@github.com:alice/api-service.git") == (
            "github.com",
            "alice",
            "api-service",
        )

    def test_repo_name_with_dots(self):
        # `.dotfiles` is a real repo name convention — make sure we don't
        # get confused about the .git suffix stripping.
        assert _parse_repo_url("https://github.com/alice/my.weird.repo") == (
            "github.com",
            "alice",
            "my.weird.repo",
        )

    def test_empty_url_rejected(self):
        with pytest.raises(ValueError, match="empty"):
            _parse_repo_url("")

    def test_whitespace_only_rejected(self):
        with pytest.raises(ValueError, match="empty"):
            _parse_repo_url("   ")

    def test_missing_owner_rejected(self):
        with pytest.raises(ValueError, match="owner/repo"):
            _parse_repo_url("https://github.com/")

    def test_missing_repo_rejected(self):
        with pytest.raises(ValueError, match="owner/repo"):
            _parse_repo_url("https://github.com/alice")

    def test_ftp_scheme_rejected(self):
        with pytest.raises(ValueError, match="scheme"):
            _parse_repo_url("ftp://github.com/alice/api-service")

    def test_ssh_without_colon_rejected(self):
        with pytest.raises(ValueError, match="SSH git URL"):
            _parse_repo_url("git@github.com/alice/api-service")

    # --- path-traversal guard ---

    def test_ssh_dotdot_in_host_rejected(self):
        with pytest.raises(ValueError, match="unsafe host"):
            _parse_repo_url("git@../../etc:alice/repo")

    def test_https_dotdot_in_host_rejected(self):
        with pytest.raises(ValueError, match="unsafe host"):
            _parse_repo_url("https://../../:80/alice/repo")

    def test_https_dotdot_in_org_rejected(self):
        with pytest.raises(ValueError, match="unsafe org"):
            _parse_repo_url("https://github.com/../etc/repo")

    def test_https_dotdot_in_repo_rejected(self):
        with pytest.raises(ValueError, match="unsafe repo"):
            _parse_repo_url("https://github.com/alice/../../etc")


class TestBuildPushUrlWithPat:
    """URL-embedded PAT credentials for the /commit push path.

    The token is placed in the **password** field of the Basic auth
    component, with ``git`` as a placeholder username:

        https://git:<pat>@github.com/owner/repo

    See ``_build_push_url_with_pat``'s docstring for the full
    four-attempt saga. The test_no_xaccesstoken_regression and
    test_pat_in_password_not_username_field tests guard against
    the two failure modes we've already hit.
    """

    def test_https_github_url_gets_credentials_embedded(self):
        from delulu_sandbox_modal.repo_provisioner import _build_push_url_with_pat

        url = _build_push_url_with_pat(
            "https://github.com/alice/api-service.git",
            "ghp_abcdef123456",
        )
        assert url == "https://git:ghp_abcdef123456@github.com/alice/api-service.git"

    def test_https_github_url_without_dot_git_suffix(self):
        from delulu_sandbox_modal.repo_provisioner import _build_push_url_with_pat

        url = _build_push_url_with_pat(
            "https://github.com/alice/api-service",
            "ghp_abcdef123456",
        )
        assert url == "https://git:ghp_abcdef123456@github.com/alice/api-service"

    def test_pat_in_password_not_username_field(self):
        """Regression guard — PR #58's mistake was putting the PAT alone in userinfo.

        GitHub rejected token-only userinfo (``<pat>@github.com``)
        because it wants the PAT in the password field. Git then
        tried to read a password interactively and failed with
        "could not read Password: No such device or address."

        The userinfo must contain a ``:`` splitting a non-empty
        username from the PAT, and the PAT must be AFTER the
        colon (the password field).
        """
        from delulu_sandbox_modal.repo_provisioner import _build_push_url_with_pat

        token = "ghp_abcdef"
        url = _build_push_url_with_pat("https://github.com/alice/api-service", token)
        # Extract the userinfo component
        assert "://" in url and "@" in url
        userinfo = url.split("://", 1)[1].split("@", 1)[0]
        # Must have a colon splitting username:password
        assert ":" in userinfo, f"userinfo must be 'user:pat' form, got {userinfo!r}"
        username, _, password = userinfo.partition(":")
        assert username, "username field must be non-empty"
        assert password == token, f"PAT must be in password field, not username; got {userinfo!r}"

    def test_no_xaccesstoken_regression(self):
        """Regression guard — PR #56's mistake was ``x-access-token:<pat>``.

        The ``x-access-token`` username is for GitHub App installation
        tokens, not Personal Access Tokens. GitHub's auth layer routes
        it to the App-token handler, which rejects PATs with a
        misleading "password authentication not supported" error. This
        test fails loudly if anyone ever re-adds that username.
        """
        from delulu_sandbox_modal.repo_provisioner import _build_push_url_with_pat

        url = _build_push_url_with_pat(
            "https://github.com/alice/api-service",
            "ghp_abcdef",
        )
        assert "x-access-token" not in url

    def test_fine_grained_pat_format_roundtrips(self):
        """Fine-grained PATs have underscores and longer length — should be fine."""
        from delulu_sandbox_modal.repo_provisioner import _build_push_url_with_pat

        token = "github_pat_11ABCDEFG_xyz123"
        url = _build_push_url_with_pat("https://github.com/alice/api-service", token)
        assert f":{token}@github.com" in url

    def test_non_default_port_preserved(self):
        from delulu_sandbox_modal.repo_provisioner import _build_push_url_with_pat

        url = _build_push_url_with_pat(
            "https://github.example.com:8443/alice/api-service.git",
            "ghp_abcdef",
        )
        assert "git:ghp_abcdef@github.example.com:8443" in url

    def test_ssh_url_rejected(self):
        """v1 only supports HTTPS remotes; SSH urls have no place for a PAT."""
        from delulu_sandbox_modal.repo_provisioner import _build_push_url_with_pat

        with pytest.raises(ValueError, match="non-HTTPS origin"):
            _build_push_url_with_pat(
                "git@github.com:alice/api-service.git",
                "ghp_abcdef",
            )

    def test_empty_token_rejected(self):
        from delulu_sandbox_modal.repo_provisioner import _build_push_url_with_pat

        with pytest.raises(ValueError, match="github_token must not be empty"):
            _build_push_url_with_pat(
                "https://github.com/alice/api-service.git",
                "",
            )


class TestScrubPat:
    """Sanitize git error messages so the PAT doesn't leak to Discord/logs."""

    def test_scrubs_pat_from_message(self):
        from delulu_sandbox_modal.repo_provisioner import _scrub_pat

        token = "ghp_abcdef123456"
        msg = (
            "git -C /vol/workspaces/42 push "
            "https://x-access-token:ghp_abcdef123456@github.com/alice/api-service.git "
            "claude/42 failed with exit code 128: stderr='fatal: auth failed'"
        )
        scrubbed = _scrub_pat(msg, token)
        assert token not in scrubbed
        assert "***PAT***" in scrubbed

    def test_handles_multiple_occurrences(self):
        from delulu_sandbox_modal.repo_provisioner import _scrub_pat

        token = "ghp_xyz"
        msg = f"URL1: {token} URL2: {token}"
        scrubbed = _scrub_pat(msg, token)
        assert token not in scrubbed
        assert scrubbed.count("***PAT***") == 2

    def test_empty_token_leaves_message_unchanged(self):
        from delulu_sandbox_modal.repo_provisioner import _scrub_pat

        msg = "some error message"
        assert _scrub_pat(msg, "") == msg

    def test_missing_token_leaves_message_unchanged(self):
        """Defensive: if the token isn't in the message, don't touch it."""
        from delulu_sandbox_modal.repo_provisioner import _scrub_pat

        assert _scrub_pat("no secrets here", "ghp_xxx") == "no secrets here"


class TestMakeBranchName:
    """Branch naming from conventional-commit messages."""

    def test_feat_prefix(self):
        from delulu_sandbox_modal.repo_provisioner import _make_branch_name

        assert (
            _make_branch_name(1234567890, "feat: add rate limiting")
            == "feat/add-rate-limiting-567890"
        )

    def test_fix_prefix(self):
        from delulu_sandbox_modal.repo_provisioner import _make_branch_name

        assert (
            _make_branch_name(1234567890, "fix: resolve timeout bug")
            == "fix/resolve-timeout-bug-567890"
        )

    def test_docs_prefix(self):
        from delulu_sandbox_modal.repo_provisioner import _make_branch_name

        assert _make_branch_name(42, "docs: update README") == "docs/update-readme-42"

    def test_scoped_type(self):
        from delulu_sandbox_modal.repo_provisioner import _make_branch_name

        result = _make_branch_name(99, "fix(auth): resolve timeout")
        assert result.startswith("fix/")
        assert "resolve-timeout" in result

    def test_no_type_prefix_falls_back_to_claude(self):
        from delulu_sandbox_modal.repo_provisioner import _make_branch_name

        result = _make_branch_name(42, "just update the readme")
        assert result.startswith("claude/")
        assert "update-the-readme" in result

    def test_long_subject_truncated(self):
        from delulu_sandbox_modal.repo_provisioner import _make_branch_name

        long_msg = "feat: " + "a" * 200
        result = _make_branch_name(42, long_msg)
        slug_part = result.split("/", 1)[1].rsplit("-", 1)[0]
        assert len(slug_part) <= 50

    def test_special_chars_slugified(self):
        from delulu_sandbox_modal.repo_provisioner import _make_branch_name

        result = _make_branch_name(42, "feat: add rate-limiting & auth!")
        assert result.startswith("feat/")
        assert "&" not in result
        assert "!" not in result

    def test_case_insensitive_type(self):
        from delulu_sandbox_modal.repo_provisioner import _make_branch_name

        result = _make_branch_name(42, "FEAT: add something")
        assert result.startswith("feat/")

    def test_thread_id_suffix_is_last_6_digits(self):
        from delulu_sandbox_modal.repo_provisioner import _make_branch_name

        result = _make_branch_name(1494242875117011085, "feat: test")
        assert result.endswith("-011085")


class TestResolveBranchName:
    """Branch name caching via .commit-branch marker."""

    def test_first_call_creates_marker(self, tmp_path):
        from delulu_sandbox_modal.repo_provisioner import _resolve_branch_name

        workspace = str(tmp_path / "ws")
        os.makedirs(workspace)
        branch = _resolve_branch_name(workspace, 42, "feat: add X")
        assert branch.startswith("feat/")
        marker = tmp_path / "ws" / ".commit-branch"
        assert marker.exists()
        assert marker.read_text().strip() == branch

    def test_second_call_reuses_cached(self, tmp_path):
        from delulu_sandbox_modal.repo_provisioner import _resolve_branch_name

        workspace = str(tmp_path / "ws")
        os.makedirs(workspace)
        first = _resolve_branch_name(workspace, 42, "feat: add X")
        second = _resolve_branch_name(workspace, 42, "fix: different message")
        assert first == second


class TestCommitWorkspaceChanges:
    """Pre-flight checks on commit_workspace_changes.

    The full git path is integration-tested by hand against a real
    Modal deploy — the unit test surface is limited to the
    parameter validation branches that don't shell out to git.
    """

    def test_empty_token_raises_value_error(self):
        from delulu_sandbox_modal.repo_provisioner import commit_workspace_changes

        # Defensive check inside the function — caller is supposed
        # to have refused on empty PAT before calling, but we
        # belt-and-suspender it.
        with pytest.raises(ValueError, match="github_token must not be empty"):
            commit_workspace_changes(thread_id=42, message="test", github_token="")

    def test_no_workspace_returns_status(self, tmp_path, monkeypatch):
        """If the workspace dir doesn't exist, return no_workspace cleanly."""
        from delulu_sandbox_modal import repo_provisioner

        # Point WORKSPACES_ROOT at a tmpdir that has no thread
        # subdirs — commit_workspace_changes should detect the
        # missing dir and return a status, not raise.
        monkeypatch.setattr(repo_provisioner, "WORKSPACES_ROOT", str(tmp_path))

        result = repo_provisioner.commit_workspace_changes(
            thread_id=999,
            message="test",
            github_token="ghp_dummy",
        )
        assert result.status == "no_workspace"
        assert "999" in (result.error or "")


class TestAskpassEnv:
    """Cover the GIT_ASKPASS env-builder used by clone/fetch/ls-remote.

    The auth pattern is shared with /commit's _push_with_askpass — both
    write a tiny shell script that responds with the PAT. These tests
    pin the script's contract: shape, perms, env wiring, cleanup on
    exit.
    """

    def test_no_token_yields_none(self):
        from delulu_sandbox_modal.repo_provisioner import _askpass_env

        with _askpass_env(None) as env:
            assert env is None
        with _askpass_env("") as env:
            assert env is None

    def test_with_token_writes_executable_script(self):
        from delulu_sandbox_modal.repo_provisioner import _askpass_env

        with _askpass_env("ghp_test_token_12345") as env:
            assert env is not None
            askpass_path = env["GIT_ASKPASS"]
            assert env["GIT_TERMINAL_PROMPT"] == "0"
            assert os.path.isfile(askpass_path)
            # Owner-only rwx — the script holds the PAT in plaintext
            # so it must not be world-readable.
            mode = os.stat(askpass_path).st_mode & 0o777
            assert mode == 0o700
            assert env["DELULU_GIT_ASKPASS_TOKEN"] == "ghp_test_token_12345"
            with open(askpass_path) as f:
                contents = f.read()
            # The token travels only via the subprocess env — never
            # interpolated into (or written to disk in) the script.
            assert "ghp_test_token_12345" not in contents
            assert "$DELULU_GIT_ASKPASS_TOKEN" in contents

        # After context exit, the script is removed so the PAT
        # doesn't outlive the operation.
        assert not os.path.exists(askpass_path)

    @pytest.mark.parametrize(
        "token",
        [
            "ghp_it's'quoted",
            'tok$(touch /tmp/pwned)`id`$HOME\\n"x"; rm -rf /',
            "  leading and trailing spaces  ",
            "-n",
        ],
    )
    def test_script_returns_token_verbatim_with_special_chars(self, token):
        import subprocess

        from delulu_sandbox_modal.repo_provisioner import _askpass_env

        with _askpass_env(token) as env:
            askpass_path = env["GIT_ASKPASS"]
            with open(askpass_path) as f:
                assert token not in f.read()
            password = subprocess.run(
                [askpass_path, "Password for 'https://github.com': "],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            ).stdout
            username = subprocess.run(
                [askpass_path, "Username for 'https://github.com': "],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        assert password == token + "\n"
        assert username == "git\n"

    def test_cleanup_runs_even_on_exception(self):
        from delulu_sandbox_modal.repo_provisioner import _askpass_env

        captured_path = None
        try:
            with _askpass_env("ghp_x") as env:
                captured_path = env["GIT_ASKPASS"]
                raise RuntimeError("simulated failure")
        except RuntimeError:
            pass

        assert captured_path is not None
        assert not os.path.exists(captured_path)


class TestAskpassTokenHandling:
    """The PAT must reach git only via env and be scrubbed from errors."""

    TOKEN = "ghp_a'b\"c$d`e"

    def test_push_passes_token_via_env_and_scrubs_errors(self, monkeypatch):
        import subprocess

        from delulu_sandbox_modal import repo_provisioner

        seen = {}

        def fake_run(cmd, **kwargs):
            if "config" in cmd:
                return subprocess.CompletedProcess(cmd, 0, stdout="https://github.com/o/r\n")
            env = kwargs["env"]
            with open(env["GIT_ASKPASS"]) as f:
                seen["script"] = f.read()
            seen["mode"] = os.stat(env["GIT_ASKPASS"]).st_mode & 0o777
            seen["path"] = env["GIT_ASKPASS"]
            seen["env_token"] = env["DELULU_GIT_ASKPASS_TOKEN"]
            raise subprocess.CalledProcessError(
                128, cmd, output="", stderr=f"fatal: auth failed for {self.TOKEN}"
            )

        monkeypatch.setattr(repo_provisioner.subprocess, "run", fake_run)
        with pytest.raises(RuntimeError) as excinfo:
            repo_provisioner._push_with_askpass("/ws", "feat/x", self.TOKEN)

        assert seen["env_token"] == self.TOKEN
        assert self.TOKEN not in seen["script"]
        assert seen["mode"] == 0o700
        assert not os.path.exists(seen["path"])
        assert self.TOKEN not in str(excinfo.value)
        assert "***PAT***" in str(excinfo.value)

    def test_run_git_scrubs_token_from_errors(self, monkeypatch):
        import subprocess

        from delulu_sandbox_modal import repo_provisioner

        def fake_run(cmd, **kwargs):
            assert kwargs["env"]["DELULU_GIT_ASKPASS_TOKEN"] == self.TOKEN
            raise subprocess.CalledProcessError(
                128, cmd, output=self.TOKEN, stderr=f"bad creds {self.TOKEN}"
            )

        monkeypatch.setattr(repo_provisioner.subprocess, "run", fake_run)
        with pytest.raises(RuntimeError) as excinfo:
            repo_provisioner._run_git(["fetch"], github_token=self.TOKEN)
        assert self.TOKEN not in str(excinfo.value)


class TestValidateRepoAccess:
    """Classification logic for /admin_addrepo's validation.

    Stubs out ``_ls_remote_succeeds`` so the tests don't actually
    shell out to git — the classification logic is what's worth
    pinning, not the git invocation itself.
    """

    def test_public_when_anonymous_succeeds(self, monkeypatch):
        from delulu_sandbox_modal import repo_provisioner

        calls: list[str | None] = []

        def fake_ls_remote(url, *, github_token):
            calls.append(github_token)
            return github_token is None  # anonymous succeeds

        monkeypatch.setattr(repo_provisioner, "_ls_remote_succeeds", fake_ls_remote)
        result = repo_provisioner.validate_repo_access(
            "https://github.com/alice/api-service",
            github_token="ghp_x",
        )
        assert result.status == repo_provisioner.ACCESS_PUBLIC
        # Anonymous probe ran; authenticated did NOT (short-circuit).
        assert calls == [None]

    def test_private_when_anonymous_fails_authed_succeeds(self, monkeypatch):
        from delulu_sandbox_modal import repo_provisioner

        def fake_ls_remote(url, *, github_token):
            return github_token is not None  # only authed succeeds

        monkeypatch.setattr(repo_provisioner, "_ls_remote_succeeds", fake_ls_remote)
        result = repo_provisioner.validate_repo_access(
            "https://github.com/alice/private-svc",
            github_token="ghp_x",
        )
        assert result.status == repo_provisioner.ACCESS_PRIVATE

    def test_not_found_when_both_fail(self, monkeypatch):
        from delulu_sandbox_modal import repo_provisioner

        monkeypatch.setattr(
            repo_provisioner,
            "_ls_remote_succeeds",
            lambda url, *, github_token: False,
        )
        result = repo_provisioner.validate_repo_access(
            "https://github.com/alice/ghost",
            github_token="ghp_x",
        )
        assert result.status == repo_provisioner.ACCESS_NOT_FOUND

    def test_not_found_when_no_token_and_anonymous_fails(self, monkeypatch):
        """Without a token, only the anonymous probe runs.

        A private repo + no token surfaces as not_found, which
        is the right /admin_addrepo failure mode (admin gets a
        clear instruction to fix the secret and retry).
        """
        from delulu_sandbox_modal import repo_provisioner

        monkeypatch.setattr(
            repo_provisioner,
            "_ls_remote_succeeds",
            lambda url, *, github_token: False,
        )
        result = repo_provisioner.validate_repo_access(
            "https://github.com/alice/private-svc",
            github_token=None,
        )
        assert result.status == repo_provisioner.ACCESS_NOT_FOUND

    def test_error_on_malformed_url(self):
        """Infrastructural failures are ``error``, not ``not_found``.

        The bot surfaces the error message verbatim so an admin can
        see what went wrong without inferring it from a generic
        not_found.
        """
        from delulu_sandbox_modal import repo_provisioner

        result = repo_provisioner.validate_repo_access("not-a-url")
        assert result.status == repo_provisioner.ACCESS_ERROR
        assert result.error


class TestEnsureWorktreeAuth:
    """``_ensure_worktree`` must thread ``github_token`` to its
    ``_run_git`` calls.

    Without it, ``git checkout <ref>`` and ``git worktree add ... HEAD``
    against a ``--filter=blob:none`` bare cache lazy-fetch missing
    blobs from the promisor remote (origin); on a private repo that
    fetch dies with "could not read Username for 'https://github.com'"
    the moment a missing blob has to be materialized — the exact
    failure the user reported in the original traceback. The clone
    and fetch already had auth (PR #72); only this last hop was
    missed.
    """

    def test_passes_token_to_worktree_add(self, tmp_path, monkeypatch):
        from delulu_sandbox_modal import repo_provisioner

        calls: list[tuple[list[str], dict]] = []

        def fake_run_git(args, *, check=True, github_token=None):
            calls.append((list(args), {"github_token": github_token}))

        monkeypatch.setattr(repo_provisioner, "_run_git", fake_run_git)

        # Don't pre-create either dir — the "workspace exists?" check
        # is False, so we hit the `worktree add` branch.
        bare_path = str(tmp_path / "bare.git")
        workspace_path = str(tmp_path / "ws")

        repo_provisioner._ensure_worktree(
            bare_path,
            workspace_path,
            "HEAD",
            github_token="ghp_test",
        )

        worktree_add = next(c for c in calls if "add" in c[0])
        assert worktree_add[1]["github_token"] == "ghp_test"

    def test_passes_token_to_checkout(self, tmp_path, monkeypatch):
        # Warm path — existing worktree with a .git marker → just
        # `git checkout <ref>`. Same lazy-fetch hazard.
        from delulu_sandbox_modal import repo_provisioner

        calls: list[tuple[list[str], dict]] = []

        def fake_run_git(args, *, check=True, github_token=None):
            calls.append((list(args), {"github_token": github_token}))

        monkeypatch.setattr(repo_provisioner, "_run_git", fake_run_git)

        workspace_path = str(tmp_path / "ws")
        os.makedirs(workspace_path)
        # The .git marker file is what triggers the warm path.
        with open(os.path.join(workspace_path, ".git"), "w") as f:
            f.write("gitdir: ../bare.git/worktrees/ws\n")

        repo_provisioner._ensure_worktree(
            str(tmp_path / "bare.git"),
            workspace_path,
            "HEAD",
            github_token="ghp_test",
        )

        checkout = next(c for c in calls if "checkout" in c[0])
        assert checkout[1]["github_token"] == "ghp_test"

    def test_no_token_passes_none(self, tmp_path, monkeypatch):
        # Public-repo path stays unauthenticated — explicit None,
        # not the literal string "None" or any default sentinel.
        from delulu_sandbox_modal import repo_provisioner

        calls: list[tuple[list[str], dict]] = []

        def fake_run_git(args, *, check=True, github_token=None):
            calls.append((list(args), {"github_token": github_token}))

        monkeypatch.setattr(repo_provisioner, "_run_git", fake_run_git)

        repo_provisioner._ensure_worktree(
            str(tmp_path / "bare.git"),
            str(tmp_path / "ws"),
            "HEAD",
        )

        worktree_add = next(c for c in calls if "add" in c[0])
        assert worktree_add[1]["github_token"] is None


class TestEnsureMarkerExcluded:
    """``_ensure_marker_excluded`` writes ``info/exclude`` so the bare
    cache's worktrees ignore ``.provision.json`` in ``git status``.

    Without this helper, every ``/commit`` against a workspace would
    stage the bot's per-thread marker via ``git add -A`` and push it
    to the user's branch — the bug surfaced by the e2e test
    ``test_commit_no_changes_returns_status``.
    """

    def test_creates_exclude_file_when_missing(self, tmp_path):
        from delulu_sandbox_modal.repo_provisioner import (
            PROVISION_MARKER_NAME,
            _ensure_marker_excluded,
        )

        bare = tmp_path / "bare.git"
        bare.mkdir()
        # ``info/`` doesn't exist — the helper must create it.
        _ensure_marker_excluded(str(bare))

        contents = (bare / "info" / "exclude").read_text()
        assert PROVISION_MARKER_NAME in contents.splitlines()

    def test_appends_to_existing_exclude(self, tmp_path):
        from delulu_sandbox_modal.repo_provisioner import (
            PROVISION_MARKER_NAME,
            _ensure_marker_excluded,
        )

        bare = tmp_path / "bare.git"
        (bare / "info").mkdir(parents=True)
        existing = "# user content\nbuild/\n*.tmp\n"
        (bare / "info" / "exclude").write_text(existing)

        _ensure_marker_excluded(str(bare))

        contents = (bare / "info" / "exclude").read_text()
        # Existing rules are preserved verbatim — appending must
        # not rewrite or reorder pre-existing user rules.
        assert contents.startswith(existing)
        assert PROVISION_MARKER_NAME in contents.splitlines()

    def test_idempotent(self, tmp_path):
        from delulu_sandbox_modal.repo_provisioner import (
            PROVISION_MARKER_NAME,
            _ensure_marker_excluded,
        )

        bare = tmp_path / "bare.git"
        bare.mkdir()
        for _ in range(3):
            _ensure_marker_excluded(str(bare))

        contents = (bare / "info" / "exclude").read_text()
        # Marker appears exactly once even after multiple calls.
        assert contents.splitlines().count(PROVISION_MARKER_NAME) == 1

    def test_appends_newline_when_existing_lacks_trailing(self, tmp_path):
        # Defensive: a hand-edited info/exclude may have no trailing
        # newline. Naive append would put the marker on the same line
        # as the previous entry, silently breaking the previous rule.
        from delulu_sandbox_modal.repo_provisioner import (
            PROVISION_MARKER_NAME,
            _ensure_marker_excluded,
        )

        bare = tmp_path / "bare.git"
        (bare / "info").mkdir(parents=True)
        (bare / "info" / "exclude").write_text("build/")  # no trailing \n

        _ensure_marker_excluded(str(bare))

        lines = (bare / "info" / "exclude").read_text().splitlines()
        assert "build/" in lines
        assert PROVISION_MARKER_NAME in lines
