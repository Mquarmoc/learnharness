import os
from pathlib import Path
import runpy
import subprocess
import sys
import unittest

@unittest.skipUnless(os.name == "nt", "Windows job ownership")
class WindowsHost(unittest.TestCase):
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
