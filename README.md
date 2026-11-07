<p align="center"><img src="assets/icon-256.png" width="112" alt="Allradione"></p>
<h1 align="center">Allradione</h1>
<p align="center">One world. Always on air.</p>

A Windows internet-radio player with a draggable analog tuner, an interactive 3D globe and transparent desktop widgets. Open source under the MIT license.

## Install

Download `Allradione-Setup-<version>-x64.exe` from [Releases](https://github.com/samueltoken/Allradione/releases/latest). The setup wizard installs Allradione for the current Windows user and creates a Start menu shortcut and a small `Allradione.exe` launcher on the desktop. The desktop launcher is a real executable, so it has no shortcut-arrow overlay. It opens the installed app and stays valid after updates; Settings can recreate it. Windows 10/11 x64; no separate VLC, web browser or runtime installation is required.

Version 0.2.0 switches from the previous portable distribution to a Windows installer. Run the new setup once; later versions can be installed from **Settings → Update**. For automatic migration, place Setup beside the old executable's `Allradione-data` folder on the first install. Only settings/favorites are copied when there is no existing installed profile; the original folder remains untouched.

## Listen

- Drag the globe to rotate and scroll to zoom, then select a country. Country search also works without WebGL. Bundled flag images appear throughout the country views.
- Search the station list, save favorites, or revisit recent stations.
- Turn the circular dial by dragging. The needle follows the pointer; the station changes when you release it. Mouse wheel and arrow keys also tune stations. Internet-only stations are labeled without inventing an FM frequency.
- Settings enables a **small circular** or **medium receiver** desktop widget. Both have transparent outer backgrounds and sit at the lower-right above ordinary windows. Closing the main window with a widget enabled keeps playback running. Reopen the app from its widget or tray, or choose **Quit** in the tray to exit.
- The waveform uses the actual audio signal with logarithmic frequency bands, adaptive gain and fast attack/release. The occupied frequency range spans the entire display, including bandwidth-limited radio streams. The medium receiver combines a black instrument face, a rounded metal rim, a large live volume readout and a curved volume scale. The circular widget responds through arc speed, thickness and glow. Silent, muted or paused streams do not produce fake activity. Reduced motion and a sleep timer are available.
- The interface bundles Sora, Pretendard and IBM Plex Mono fonts for consistent English and Korean typography.

## Updates, cache and removal

**Settings → Update** checks this repository's latest stable release. Downloads must pass SHA-256 verification before the setup process runs. The installer updates the existing installation and preserves preferences, favorites and recent stations. The app restarts after a successful installed update. Obsolete program files are replaced during installation, owned desktop launchers are refreshed, and completed update staging files are removed. On version changes, compiled-code caches are refreshed without discarding listening preferences or the station directory. Interrupted, marked update staging folders are cleaned only after 24 hours and after their owning process has exited. Unrelated files are never used as cleanup targets.

From 0.2.2, installing refreshes the release metadata so an earlier check cannot retain a missing or withdrawn installer. Releases become public only after the Windows checks pass and both the installer and checksum finish uploading. If a newer release is still preparing its installer, Settings offers a recheck instead of opening a download page.

If an older app closes without installing the update, run the 0.2.2 Setup once over the existing installation. Publishing a new installer cannot repair an old updater that stops before running it. The 0.2.2 updater waits for its helper's verified readiness before closing and verifies restart using canonical Windows file paths.

**Settings → Cache** shows cache usage and clears this app's network, compiled-code and station-directory caches. Favorites, preferences and unrelated files are retained. The result reports any cache that could not be removed; live playback remains available.

Use Windows **Installed apps → Allradione → Uninstall** to remove the installed application, its desktop launcher, Start menu shortcut and application-owned settings/cache data. Upgrade installation preserves that data. Data folders beside an old portable executable and downloaded installer files are not part of the installed application's files.

## Data and network

Radio Browser supplies the station directory. Audio comes from the selected broadcaster through an internal loopback proxy, which handles mixed stream formats and visualizer access. The proxy uses a random port and token and does not relay audio to other listeners. No account, telemetry or application server is required. Selecting a station submits its ID to Radio Browser's public click counter as requested by its API guidelines.

Availability depends on the station, network and region. Some domestic Japanese and other services restrict overseas access. No geographic or subscription bypass, recording or rebroadcasting is included. A normal topmost window cannot cover the Windows secure desktop/UAC screen or guarantee display over every exclusive fullscreen game.

## Develop

Requires Node.js 22+.

```sh
npm ci
npm test
npm run build
npm start
```

For renderer development, run `npm run dev`, then launch Electron with `ALLRADIONE_DEV_URL=http://localhost:5173`. The browser-only preview cannot create native widgets, create a Windows desktop launcher or install updates.

```sh
npm run dist:win
```

Build on Windows with the Visual Studio C++ build tools and Windows SDK; the desktop launcher is compiled with the static runtime and needs no separately installed runtime. GitHub Actions verifies audio decoding, actual widget corner transparency, dial interactions, fonts and flags, cache preservation, install/upgrade/uninstall behavior (including a SHA-256-pinned v0.2.0 to current-version upgrade), then produces the NSIS setup executable and `SHA256SUMS.txt`. Live station playback is probed separately because broadcaster availability is external.

To release, increment `package.json` and the lockfile, commit and publish a matching `v<version>` GitHub release. The release workflow tests the version and attaches the Windows setup and checksums. Resolve any failing workflow before distributing the release.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Radio station logos and broadcast content retain their original ownership.
