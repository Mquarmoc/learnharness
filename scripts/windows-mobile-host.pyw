"""Run the configured LearnHarness desktop host quietly under Task Scheduler."""
import json
import ctypes
from ctypes import wintypes
import msvcrt
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

def own_process_tree(child):
    # Closing this non-inherited handle kills descendants when Task Scheduler stops us.
    class Limits(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
            ("flags", wintypes.DWORD), ("min_working", ctypes.c_size_t), ("max_working", ctypes.c_size_t),
            ("active", wintypes.DWORD), ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
    class Extended(ctypes.Structure):
        _fields_ = [("basic", Limits), ("io", ctypes.c_ulonglong * 6),
            ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
            ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        child.kill()
        raise ctypes.WinError(ctypes.get_last_error())
    limits = Extended()
    limits.basic.flags = 0x2000
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job, int(child._handle)):
        error = ctypes.get_last_error()
        kernel.CloseHandle(job)
        child.kill()
        raise ctypes.WinError(error)
    # The process is still suspended: assign ownership before its first instruction.
    class Thread(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("usage", wintypes.DWORD), ("id", wintypes.DWORD),
            ("owner", wintypes.DWORD), ("priority", wintypes.LONG), ("delta", wintypes.LONG), ("flags", wintypes.DWORD)]
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(Thread)]
    kernel.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(Thread)]
    kernel.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenThread.restype = wintypes.HANDLE
    kernel.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel.ResumeThread.restype = wintypes.DWORD
    snapshot = kernel.CreateToolhelp32Snapshot(4, 0)
    entry = Thread()
    entry.size = ctypes.sizeof(entry)
    try:
        more = kernel.Thread32First(snapshot, ctypes.byref(entry))
        while more:
            if entry.owner == child.pid:
                thread = kernel.OpenThread(2, False, entry.id)
                try:
                    if not thread or kernel.ResumeThread(thread) == 0xFFFFFFFF:
                        raise ctypes.WinError(ctypes.get_last_error())
                finally:
                    if thread:
                        kernel.CloseHandle(thread)
                break
            more = kernel.Thread32Next(snapshot, ctypes.byref(entry))
        else:
            raise RuntimeError("The suspended host thread could not be found.")
    except Exception:
        kernel.CloseHandle(job)
        raise
    finally:
        kernel.CloseHandle(snapshot)
    return kernel, job

def main():
    base = Path(__file__).resolve().parent
    config = json.loads((base / "host-config.json").read_text(encoding="utf-8-sig"))
    executable = base / "LearnHarness.exe"
    profile = Path(config["profile"])
    if not executable.is_file() or not (profile / "data" / "chats").is_dir():
        raise RuntimeError("The installed host or existing learner profile is missing.")
    runtime = base / "run"
    runtime.mkdir(exist_ok=True)
    with (runtime / "host.lock").open("a+b") as lock:
        lock.seek(0)
        if (runtime / "host.lock").stat().st_size == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return 0
        allowed = {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATH", "PATHEXT", "COMSPEC"}
        env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        env["SystemRoot"] = os.environ.get("SystemRoot", r"C:\Windows")
        env.update({
            "LH_USER_DATA_DIR": str(profile),
            "LH_MOBILE_ORIGIN": config["origin"],
            "LH_MOBILE_PORT": str(config.get("port", 8792)),
            "LH_MOBILE_AUTO_START": "1",
            "LH_MOBILE_PAIRING_FILE": str(runtime / "pairing.json"),
            "LH_MOBILE_CONTROL_FILE": str(runtime / "request-pairing"),
            "LH_MOBILE_STATE_FILE": str(runtime / "phone-sessions.json"),
            "LH_DISABLE_AUTO_UPDATE": "1",
            "NEXT_TELEMETRY_DISABLED": "1",
        })
        log = runtime / "host.log"
        if log.exists() and log.stat().st_size > 2_000_000:
            log.replace(runtime / "host.previous.log")
        with log.open("ab") as output:
            child = subprocess.Popen([str(executable)], cwd=base, env=env, stdin=subprocess.DEVNULL,
                stdout=output, stderr=output, creationflags=subprocess.CREATE_NO_WINDOW | 0x4)
            kernel, job = own_process_tree(child)
            (runtime / "runtime.json").write_text(json.dumps({
                "pid": child.pid, "startedAt": datetime.now(timezone.utc).isoformat(),
                "executable": str(executable), "profile": str(profile), "origin": config["origin"],
            }), encoding="utf-8")
            try:
                return child.wait()
            finally:
                kernel.CloseHandle(job)

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        (Path(__file__).resolve().parent / "startup-error.txt").write_text(str(error), encoding="utf-8")
        sys.exit(1)
