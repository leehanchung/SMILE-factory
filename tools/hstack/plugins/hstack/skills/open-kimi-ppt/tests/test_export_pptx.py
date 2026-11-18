#!/usr/bin/env python3
import importlib.util
import os
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_pptx.py"
SPEC = importlib.util.spec_from_file_location("export_pptx", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class ExportPptxTests(unittest.TestCase):
    def test_parse_agent_browser_version(self):
        self.assertEqual(MODULE.parse_version("agent-browser 0.33.2"), (0, 33, 2))
        self.assertEqual(MODULE.parse_version("v1.4.0-beta.1"), (1, 4, 0))

    @patch.object(MODULE, "run_command")
    @patch.object(MODULE.shutil, "which")
    def test_old_agent_browser_is_upgraded(self, which, run_command):
        which.side_effect = [
            "/bin/node",
            "/bin/npm",
            "/bin/agent-browser",
            "/bin/npm",
            "/bin/agent-browser",
        ]
        run_command.side_effect = [
            MODULE.subprocess.CompletedProcess([], 0, "v22.11.0\n"),
            MODULE.subprocess.CompletedProcess([], 0, "agent-browser 0.17.1\n"),
            MODULE.subprocess.CompletedProcess([], 0, "changed 1 package\n"),
            MODULE.subprocess.CompletedProcess([], 0, "agent-browser 0.33.2\n"),
        ]
        self.assertEqual(MODULE.ensure_agent_browser(), "/bin/agent-browser")
        self.assertEqual(run_command.call_args_list[2].args[0], [
            "/bin/npm", "install", "-g", "agent-browser@latest"
        ])

    @patch.object(MODULE, "run_command")
    @patch.object(MODULE.shutil, "which")
    def test_missing_nodejs_raises_clear_error(self, which, run_command):
        which.return_value = None
        with self.assertRaisesRegex(MODULE.ExportError, "Node.js is not installed"):
            MODULE.ensure_nodejs()
        run_command.assert_not_called()

    @patch.object(MODULE, "run_command")
    @patch.object(MODULE.shutil, "which")
    def test_old_nodejs_raises_clear_error(self, which, run_command):
        which.return_value = "/bin/node"
        run_command.return_value = MODULE.subprocess.CompletedProcess([], 0, "v16.20.2\n")
        with self.assertRaisesRegex(MODULE.ExportError, "Node.js 18\\+ is required"):
            MODULE.ensure_nodejs()

    @patch.object(MODULE, "run_command")
    @patch.object(MODULE.shutil, "which")
    def test_missing_npm_raises_clear_error(self, which, run_command):
        which.side_effect = ["/bin/node", None]
        run_command.return_value = MODULE.subprocess.CompletedProcess([], 0, "v22.11.0\n")
        with self.assertRaisesRegex(MODULE.ExportError, "npm is not installed"):
            MODULE.ensure_nodejs()

    def test_parse_node_version(self):
        self.assertEqual(MODULE.parse_node_version("v22.11.0"), (22, 11, 0))
        self.assertEqual(MODULE.parse_node_version("18.20.4"), (18, 20, 4))

    def test_fade_is_inserted_before_timing(self):
        source = (
            b'<?xml version="1.0" encoding="UTF-8"?>'
            b'<p:sld xmlns:p="urn:test"><p:cSld><p:spTree><p:extLst/>'
            b'</p:spTree></p:cSld><p:clrMapOvr/><p:timing/><p:extLst/></p:sld>'
        )
        result_bytes = MODULE.replace_transition(source, "fade")
        result = result_bytes.decode("utf-8")
        self.assertIn("<p:transition", result)
        self.assertIn("<p:fade/>", result)
        self.assertGreater(result.index("<p:transition"), result.index("<p:clrMapOvr"))
        self.assertLess(result.index("<p:transition"), result.index("<p:timing"))
        MODULE.validate_transition_order(result_bytes, "fade")

    def test_existing_transition_is_replaced_or_removed(self):
        source = (
            b'<p:sld xmlns:p="urn:test"><p:cSld/>'
            b'<p:transition><p:wipe/></p:transition><p:extLst/></p:sld>'
        )
        faded = MODULE.replace_transition(source, "fade").decode("utf-8")
        self.assertNotIn("p:wipe", faded)
        self.assertEqual(faded.count("<p:transition"), 1)
        MODULE.validate_transition_order(faded.encode("utf-8"), "fade")
        cleared = MODULE.replace_transition(source, "none").decode("utf-8")
        self.assertNotIn("p:transition", cleared)
        MODULE.validate_transition_order(cleared.encode("utf-8"), "none")

    def test_nested_transition_is_relocated_to_slide_root(self):
        source = (
            b'<p:sld xmlns:p="urn:test"><p:cSld><p:spTree>'
            b'<p:transition><p:fade/></p:transition><p:extLst/>'
            b'</p:spTree></p:cSld><p:clrMapOvr/><p:extLst/></p:sld>'
        )
        result = MODULE.replace_transition(source, "fade")
        MODULE.validate_transition_order(result, "fade")
        self.assertEqual(MODULE.root_child_names(result), [
            "cSld", "clrMapOvr", "transition", "extLst"
        ])

    def test_patch_transitions_preserves_a_valid_zip(self):
        with tempfile.TemporaryDirectory() as name:
            deck = Path(name) / "test.pptx"
            with zipfile.ZipFile(deck, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(
                    "[Content_Types].xml",
                    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                    '<Override PartName="/ppt/presentation.xml" '
                    f'ContentType="{MODULE.PPTX_CONTENT_TYPE}"/></Types>',
                )
                archive.writestr("ppt/presentation.xml", "<p:presentation xmlns:p=\"urn:test\"/>")
                archive.writestr(
                    "ppt/slides/slide1.xml",
                    '<p:sld xmlns:p="urn:test"><p:cSld/></p:sld>',
                )
            self.assertEqual(MODULE.patch_transitions(deck, "fade"), 1)
            with zipfile.ZipFile(deck) as archive:
                self.assertIsNone(archive.testzip())
                slide = archive.read("ppt/slides/slide1.xml")
                self.assertIn(b"<p:fade/>", slide)

    @patch.object(MODULE.subprocess, "call", return_value=0)
    def test_run_command_captures_utf8_via_temp_file(self, call):
        def write_sink(*_args, **kwargs):
            kwargs["stdout"].write("agent-browser 0.33.2\n")
            return 0

        call.side_effect = write_sink
        process = MODULE.run_command(["agent-browser", "--version"], timeout=5)
        self.assertEqual(process.returncode, 0)
        self.assertIn("0.33.2", process.stdout)
        self.assertEqual(call.call_args.kwargs["stderr"], MODULE.subprocess.STDOUT)

    def test_find_download_ignores_files_older_than_since(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            old = root / "old.pptx"
            new = root / "new.pptx"
            for path in (old, new):
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr(
                        "[Content_Types].xml",
                        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                        '<Override PartName="/ppt/presentation.xml" '
                        f'ContentType="{MODULE.PPTX_CONTENT_TYPE}"/></Types>',
                    )
                    archive.writestr("ppt/presentation.xml", "<p:presentation/>")

            older = time.time() - 60
            os.utime(old, (older, older))
            since = time.time() - 5
            found = MODULE.find_download([root], timeout=2.0, since=since)
            self.assertEqual(found.resolve(), new.resolve())

    def test_find_download_survives_files_vanishing_mid_scan(self):
        # Chrome renames "*.crdownload" files away between directory listing
        # and stat(); a vanished file must be skipped, not crash the export.
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            deck = root / "deck.pptx"
            with zipfile.ZipFile(deck, "w") as archive:
                archive.writestr(
                    "[Content_Types].xml",
                    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                    '<Override PartName="/ppt/presentation.xml" '
                    f'ContentType="{MODULE.PPTX_CONTENT_TYPE}"/></Types>',
                )
                archive.writestr("ppt/presentation.xml", "<p:presentation/>")
            ghost = root / "ghost.crdownload"
            ghost.write_bytes(b"partial download")

            real_stat = Path.stat
            seen = {"count": 0}

            def racy_stat(self, **kwargs):
                if self.name == "ghost.crdownload":
                    seen["count"] += 1
                    if seen["count"] > 1:
                        raise FileNotFoundError(2, "vanished mid-scan", str(self))
                return real_stat(self, **kwargs)

            with patch.object(Path, "stat", racy_stat):
                found = MODULE.find_download([root], timeout=2.0)
            self.assertEqual(found.resolve(), deck.resolve())

    def test_browser_open_does_not_pass_download_path(self):
        session = MODULE.BrowserSession(
            "/bin/agent-browser",
            "test-session",
            Path("."),
            Path("/tmp/downloads"),
        )
        with patch.object(session, "run") as run:
            session.open("http://127.0.0.1:9/?ndExport=1")
        run.assert_called_once_with(
            ["open", "http://127.0.0.1:9/?ndExport=1"],
            timeout=90,
        )

    def test_ensure_debug_chrome_is_windows_only(self):
        with patch.object(MODULE.sys, "platform", "linux"):
            self.assertIsNone(MODULE.ensure_debug_chrome())

    @patch.object(MODULE, "cdp_alive", return_value=True)
    def test_ensure_debug_chrome_prefers_working_explicit_port(self, cdp_alive):
        with patch.object(MODULE.sys, "platform", "win32"), \
                patch.dict(MODULE.os.environ, {"AGENT_BROWSER_CDP": "9444"}):
            self.assertEqual(MODULE.ensure_debug_chrome(), 9444)
        cdp_alive.assert_called_once_with(9444)

    def test_browser_session_exports_cdp_port_to_env(self):
        with patch.dict(MODULE.os.environ, {}, clear=False):
            MODULE.os.environ.pop("AGENT_BROWSER_CDP", None)
            with_port = MODULE.BrowserSession(
                "/bin/agent-browser", "s", Path("."), Path("/tmp/d"), cdp_port=9337
            )
            self.assertEqual(with_port.env["AGENT_BROWSER_CDP"], "9337")
            without_port = MODULE.BrowserSession(
                "/bin/agent-browser", "s", Path("."), Path("/tmp/d")
            )
            self.assertNotIn("AGENT_BROWSER_CDP", without_port.env)


if __name__ == "__main__":
    unittest.main()
