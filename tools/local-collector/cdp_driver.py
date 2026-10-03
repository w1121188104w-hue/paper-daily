"""Optional SeleniumBase CDP adapter, keeping collection and evidence identical."""
import asyncio
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import time
import urllib.request

from seleniumbase import sb_cdp
from seleniumbase.undetected.cdp_driver import cdp_util
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
        self.process = None
        self.timeout = args.timeout
        # Windows/system proxies must never receive loopback DevTools traffic.
        # SeleniumBase's urllib and WebSocket clients honor this process-local
        # bypass; publisher traffic retains the user's browser proxy settings.
        bypass = os.environ.get('NO_PROXY', os.environ.get('no_proxy', ''))
        os.environ['NO_PROXY'] = os.environ['no_proxy'] = ','.join(filter(None, [bypass, '127.0.0.1', 'localhost', '::1']))
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
        # Start explicitly on both platforms, with a bounded DevTools readiness
        # check. The library's implicit Windows startup can otherwise wait
        # indefinitely when a profile is locked or the browser cannot launch.
        if platform.system() in ("Linux", "Windows"):
            config = linux_sandbox_config(options)
            config.host = '127.0.0.1'
            with socket.socket() as available:
                available.bind((config.host, 0))
                config.port = available.getsockname()[1]
            log_root = Path(args.profile).parent if args.profile else Path.cwd()
            log_path = Path(os.environ.get('PAPER_CDP_STARTUP_LOG', str(log_root / 'browser-startup.log')))
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open('wb') as log:
                self.process = subprocess.Popen([str(config.browser_executable_path), *config()], stdout=log, stderr=log,
                                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            deadline = time.monotonic() + 60
            ready = False
            while time.monotonic() < deadline and self.process.poll() is None:
                try:
                    with opener.open(f'http://127.0.0.1:{config.port}/json/version', timeout=1) as response:
                        ready = response.status == 200
                    if ready:
                        break
                except OSError:
                    pass
                time.sleep(0.5)
            if not ready:
                self.stop_process()
                print(log_path.read_text(encoding='utf-8', errors='replace')[-6000:], flush=True)
                raise RuntimeError('Browser startup readiness failed; see browser-startup.log')
            options.update(config=config, host=config.host, port=config.port)
        try:
            loop = asyncio.new_event_loop()
            driver = loop.run_until_complete(asyncio.wait_for(cdp_util.start(**options), timeout=45))
            page = loop.run_until_complete(asyncio.wait_for(driver.get('about:blank'), timeout=self.timeout))
            self.client = sb_cdp.CDPMethods(loop, page, driver)
        except Exception:
            self.stop_process()
            raise
        self.capabilities = {"browserName": args.browser, "platformName": platform.system(),
                             "browserVersion": self.execute_script('return navigator.userAgent')}

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
        try:
            self.client.quit()
        finally:
            self.stop_process()

    def stop_process(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
