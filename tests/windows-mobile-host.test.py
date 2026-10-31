import os
from pathlib import Path
import runpy
import subprocess
import sys
import unittest
import tempfile
from unittest.mock import patch, Mock

@unittest.skipUnless(os.name == "nt", "Windows job ownership")
class WindowsHost(unittest.TestCase):
    def test_shortcut_requests_the_scheduled_owner_without_starting_another_host(self):
        module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "windows-mobile-host.pyw"))
        with tempfile.TemporaryDirectory() as folder:
            fake_script = Path(folder) / "windows-mobile-host.pyw"
            with patch.dict(module["main"].__globals__, {"__file__": str(fake_script)}), \
                    patch.object(sys, "argv", [str(fake_script), "--open"]), \
                    patch("subprocess.run") as run, patch("subprocess.Popen") as spawn:
                self.assertEqual(module["main"](), 0)
                self.assertEqual((Path(folder) / "run" / "request-pairing").read_text(), "show")
                self.assertEqual(run.call_args.args[0][-3:], ["/Run", "/TN", "LearnHarness-Mobile-Host"])
                self.assertEqual(run.call_args.kwargs["creationflags"], subprocess.CREATE_NO_WINDOW)
                spawn.assert_not_called()

    def test_failed_host_is_restarted_by_its_existing_owner_and_successful_quit_stops_retries(self):
        module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "windows-mobile-host.pyw"))
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            (base / "LearnHarness.exe").touch()
            (base / "profile" / "data" / "chats").mkdir(parents=True)
            (base / "host-config.json").write_text(__import__("json").dumps({"profile":str(base / "profile"),"origin":"https://pc.example"}))
            failed, stopped = Mock(pid=1), Mock(pid=2)
            failed.wait.return_value, stopped.wait.return_value = 1, 0
            kernel = Mock()
            with patch.dict(module["main"].__globals__, {"__file__": str(base / "windows-mobile-host.pyw"), "own_process_tree": Mock(return_value=(kernel,1))}), \
                    patch.object(sys, "argv", ["host"]), patch("subprocess.Popen", side_effect=[failed,stopped]) as spawn, patch("time.sleep") as sleep:
                self.assertEqual(module["main"](), 0)
                self.assertEqual(spawn.call_count, 2)
                self.assertIn("--mobile-background", spawn.call_args.args[0])
                sleep.assert_called_once_with(5)
                self.assertEqual(kernel.CloseHandle.call_count, 2)

    def test_repeated_host_failure_has_a_bounded_retry_count(self):
        module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "windows-mobile-host.pyw"))
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            (base / "LearnHarness.exe").touch()
            (base / "profile" / "data" / "chats").mkdir(parents=True)
            (base / "host-config.json").write_text(__import__("json").dumps({"profile":str(base / "profile"),"origin":"https://pc.example"}))
            failed = Mock(pid=1)
            failed.wait.return_value = 1
            with patch.dict(module["main"].__globals__, {"__file__": str(base / "windows-mobile-host.pyw"), "own_process_tree": Mock(return_value=(Mock(),1))}), \
                    patch.object(sys, "argv", ["host"]), patch("subprocess.Popen", return_value=failed) as spawn, patch("time.sleep") as sleep:
                self.assertEqual(module["main"](), 1)
                self.assertEqual(spawn.call_count, 6)
                self.assertEqual(sleep.call_count, 5)

    def test_closing_supervisor_job_terminates_its_child(self):
        module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "windows-mobile-host.pyw"))
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
            creationflags=subprocess.CREATE_NO_WINDOW | 0x4, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            kernel, job = module["own_process_tree"](child)
            self.assertIsNone(child.poll())
            kernel.CloseHandle(job)
            child.wait(timeout=5)
            self.assertIsNotNone(child.poll())
        finally:
            if child.poll() is None:
                child.kill()

if __name__ == "__main__":
    unittest.main()
