# paper-daily Deployment

## macOS: keep it running with launchd

This is the simplest local deployment for a personal Mac. It starts paper-daily
when you log in, keeps it alive, and restarts it if it crashes.

From the project directory:

```bash
mkdir -p logs
sed "s#/ABSOLUTE/PATH/TO/paper-daily#$(pwd)#g" deploy/macos/com.paper-daily.server.plist \
  > ~/Library/LaunchAgents/com.paper-daily.server.plist
launchctl unload ~/Library/LaunchAgents/com.paper-daily.server.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.paper-daily.server.plist
launchctl start com.paper-daily.server
```

Then open:

```text
http://localhost:3000
```

Check status:

```bash
launchctl list | grep com.paper-daily.server
curl http://localhost:3000/api/digest/refresh-status
```

View logs:

```bash
tail -f logs/paper-daily.out.log
tail -f logs/paper-daily.err.log
```

Stop the service:

```bash
launchctl stop com.paper-daily.server
launchctl unload ~/Library/LaunchAgents/com.paper-daily.server.plist
```

### Notes

- The provided plist uses `/opt/homebrew/bin/node`.
- The plist template uses `/ABSOLUTE/PATH/TO/paper-daily`; replace it with your
  local project path before loading it into launchd.
- The default daily refresh time is `08:10` in `Asia/Shanghai`.
- A catch-up check runs at `13:00`. On startup and page open, paper-daily also
  scans the recent backlog and refreshes missing, failed, partial, or
  interrupted days sequentially.
- By default, catch-up scans the last 7 days for missing dates, also scans the
  last 30 days for failed, partial, or interrupted refresh records, refreshes up
  to 3 dates per pass, and waits 120 seconds between dates to reduce arXiv
  rate-limit errors. Failed or partial refreshes retry up to 3 times, 30 minutes
  apart.
- Daily reports are written to `data/daily-reports/`, and macOS desktop
  notifications are enabled by default.
- The service starts only after you log in. If you need it to run before login,
  use a system LaunchDaemon or deploy it to a server.

## Local secrets and user data

Do not commit local runtime data. The `data/` directory and `.env` are ignored
by git because they can contain API keys, subscriptions, cached AI outputs, and
private reading history.

For API keys, use either the settings page or environment variables:

```bash
cp .env.example .env
```

Then fill in `LLM_API_KEY` for an OpenAI-compatible API. You can also set
`JINA_API_KEY` if you use Jina Reader for Google Scholar author tracking.

## VPS or cloud server: use systemd

On a Linux server, copy the project to a stable path, install dependencies, then
create a systemd service.

Example service file:

```ini
[Unit]
Description=paper-daily
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/paper-daily
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
Environment=PORT=3000
Environment="REFRESH_CRON=10 8 * * *"
Environment="REFRESH_CATCHUP_CRON=0 13 * * *"
Environment=REFRESH_RETRY_MINUTES=30
Environment=REFRESH_RETRY_LIMIT=3
Environment=CATCHUP_LOOKBACK_DAYS=7
Environment=CATCHUP_FAILED_LOOKBACK_DAYS=30
Environment=CATCHUP_MAX_DATES=3
Environment=CATCHUP_DELAY_MS=120000
Environment=REFRESH_TIMEZONE=Asia/Shanghai
Environment=ENABLE_DESKTOP_NOTIFICATIONS=false

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now paper-daily
sudo systemctl status paper-daily
```

If exposing it to the internet, put it behind Nginx/Caddy with HTTPS and add
authentication before opening the port publicly.
