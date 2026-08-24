# Verified framework status

Verified on macOS on 2026-08-24:

- `npm install`: passed; lockfile generated.
- `npm run brand:check`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed for main, preload and renderer bundles.
- `npm run dev`: Electron process and Vite development server started.
- `http://localhost:5173/`: returned HTTP 200 while the development process was active.
- Activity, Overview, Processes, Devices, Policies, Rules, Capture, Decrypt, Rewrite and Settings visual shells are present.
- Controller WebSocket streams (`/traffic`, `/logs`, `/connections`) via the in-process mock controller; reconnect backoff, jitter and listener cleanup verified.

Not verified in this milestone:

- Windows x64/arm64 packaging.
- Windows code signing.
- Actual mihomo binary supervision.
- Windows system proxy mutation/restoration.
- TUN installation and traffic capture.

The GitHub remote is not created because the local GitHub CLI credential is invalid. Re-authenticate before repository creation.
