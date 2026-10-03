"""Optional SeleniumBase CDP adapter, keeping collection and evidence identical."""
import asyncio
import os
from pathlib import Path
import platform
import shutil

from seleniumbase import sb_cdp
from selenium.common.exceptions import TimeoutException


def linux_sandbox_config(options):
    from seleniumbase.undetected.cdp_driver.config import Config

    class SandboxedConfig(Config):
        def __call__(self):
            # Keep the packaged browser's SUID sandbox available where Ubuntu
            # restricts unprivileged user namespaces. Do not disable sandboxing.
            return [arg for arg in super().__call__() if arg != '--disable-setuid-sandbox']

    return SandboxedConfig(**{k: v for k, v in options.items() if k != 'headed'})


class CDPDriver:
    def __init__(self, args):
        binary = args.binary
        if not binary and args.browser == "edge" and platform.system() == "Linux":
            binary = shutil.which("microsoft-edge") or shutil.which("microsoft-edge-stable")
        if not binary and args.browser == "edge":
            choices = [Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)")) /
                       "Microsoft/Edge/Application/msedge.exe",
                       Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) /
                       "Microsoft/Edge/Application/msedge.exe"]
            binary = next((str(p) for p in choices if p.is_file()), None)
            if not binary:
                raise RuntimeError("Edge not found; use --binary or --browser chrome")
        options = {"headless": args.headless}
        if platform.system() == "Linux" and not args.headless:
            options["headed"] = True  # GitHub trial supplies an Xvfb display.
        if binary:
            options["browser_executable_path"] = binary
        if args.profile:
            options["user_data_dir"] = str(Path(args.profile).resolve())
        if platform.system() == "Linux":
            options["config"] = linux_sandbox_config(options)
        self.client = sb_cdp.Chrome(**options)
        self.timeout = args.timeout
        self.capabilities = {"browserName": args.browser, "platformName": platform.system(),
                             "browserVersion": self.client.get_user_agent()}

    def get(self, url):
        try:
            self.client.loop.run_until_complete(asyncio.wait_for(
                self.client.page.get(url), timeout=self.timeout))
        except asyncio.TimeoutError as exc:
            raise TimeoutException("CDP navigation timed out") from exc

    @property
    def current_url(self):
        return self.execute_script("return location.href")

    def execute_script(self, script):
        try:
            return self.client.loop.run_until_complete(asyncio.wait_for(
                self.client.page.evaluate("(() => {" + script + "})()"), timeout=self.timeout))
        except asyncio.TimeoutError as exc:
            raise TimeoutException("CDP evaluation timed out") from exc

    def save_screenshot(self, filename):
        try:
            self.client.loop.run_until_complete(asyncio.wait_for(
                self.client.page.save_screenshot(filename), timeout=self.timeout))
        except asyncio.TimeoutError as exc:
            raise TimeoutException("CDP screenshot timed out") from exc
        return True

    def click_checkbox_once(self):
        # One bounded helper call. Return value is never treated as proof of success.
        return self.client.loop.run_until_complete(asyncio.wait_for(
            self.client.page.solve_captcha(), timeout=min(self.timeout, 20)))

    def quit(self):
        self.client.quit()
