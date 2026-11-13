<p align="center">
  <img src="assets/icon-256.png" width="96" height="96" alt="Allradione">
</p>

<h1 align="center">Allradione</h1>

<p align="center">
  Explore live radio around the world.<br>
  An analog dial, an interactive globe, and a receiver for your desktop.
</p>

<p align="center">
  <a href="https://github.com/samueltoken/Allradione/releases/latest"><strong>Download for Windows</strong></a>
  &nbsp; · &nbsp;
  <a href="https://github.com/samueltoken/Allradione/releases">Release notes</a>
  &nbsp; · &nbsp;
  <a href="https://github.com/samueltoken/Allradione/issues">Report an issue</a>
</p>

<p align="center"><sub>WINDOWS 10 / 11 &nbsp; · &nbsp; 64-BIT &nbsp; · &nbsp; OPEN SOURCE</sub></p>

---

## Radio, at your pace

| Explore | Tune | Keep listening |
| :--- | :--- | :--- |
| Rotate the 3D globe or search by country to discover live stations. | Drag the analog dial, scroll, or use the arrow keys to change stations. | Keep a transparent circular or receiver widget on your desktop. |

- **Station operators.** Each country has tabs for confirmed broadcasters, independent stations, unconfirmed operators, and the full list. Station details include the operator, relay and source when available.
- **Your stations.** Search the directory, save favorites, and return to recent listening.
- **Global chat.** Open the red speech bubble to chat across countries. Choose a nickname or use the assigned Ano number. While you are in chat, others can see the station you are playing. Click a message to report it.
- **Sound in motion.** Visualizers respond to the actual audio signal and settle when playback is silent.
- **A considered interface.** Sora, Pretendard, and IBM Plex Mono pair clear typography with an instrument-inspired layout.
- **Settings.** Choose Korean, English, Japanese, Simplified Chinese, Cantonese, Taiwanese Mandarin, Taiwanese Hokkien or Latin. Adjust background playback, the sleep timer and motion here.

## Start listening

1. Download `Allradione-Setup-<version>-x64.exe` from the [latest release](https://github.com/samueltoken/Allradione/releases/latest).
2. Run Setup, then open Allradione from the desktop or Start menu.
3. Select a country and a station. With **Settings → Background playback** enabled, closing the main window keeps the radio playing in the tray, with or without a widget.

Windows 10/11 x64 and an internet connection are required. No account or separate media player is needed.

## Stay up to date

Open **Settings → Update** to download, verify, and install the latest stable version. Allradione restarts after installation and retains settings, favorites, and recent stations. Downloads are verified with SHA-256.

Starting with version 0.2.5, **Settings → Check for updates → Download and install** opens Windows Setup. Cancelling its welcome page leaves the radio playing. The last screen lets you choose whether to reopen the app. Upgrading **from 0.2.4** still uses its existing updater.

**Moving from an older version?** If an update closes the app without installing, run the [latest Setup](https://github.com/samueltoken/Allradione/releases/latest) once over the existing installation. No uninstall is required.

<details>
<summary><strong>Installation, widgets &amp; cleanup</strong></summary>

- Setup installs for the current Windows user and creates a Start menu shortcut and a desktop `Allradione.exe` launcher. The launcher continues to work after updates.
- Widgets can shrink from their original size for a more compact view. Reopen Allradione from the widget or tray; choose **Quit** in the tray to exit.
- **Settings → Cache** clears app caches while preserving preferences and favorites.
- Updates replace obsolete application files and remove completed update staging files. Unrelated files are preserved.
- Windows **Installed apps → Allradione → Uninstall** removes the installed app, its launchers, and application-owned settings and caches.
- To migrate from a portable version, place Setup beside the old `Allradione-data` folder before the first installation. Settings and favorites are imported only when no installed profile exists. The original portable folder and downloaded installers remain separate.

</details>

<details>
<summary><strong>Station data &amp; privacy</strong></summary>

[Radio Browser](https://www.radio-browser.info/) provides the community-maintained directory. Allradione checks broadcaster records and published stream addresses to identify operators and correct country assignments. Some programmes are carried by independent relays. The Windows player also includes Korean channels with broadcaster-published addresses. Read the [classification criteria](docs/station-classification.md) and [operator sources](docs/network-operators.md).

Allradione uses a local, token-protected audio proxy for playback and visualization. It does not relay streams to other listeners.

Listening requires no account. Selecting a station submits its ID to Radio Browser's public click counter.

Opening chat connects to Allradione’s Cloudflare service. The room shares the latest 80 messages from the past day. Other participants see your nickname and messages. Your listening station stays private. A local chat token restores your nickname on reconnect. Use a message’s menu to hide its author or report it.

Station availability depends on the broadcaster, network, and region. Recording, rebroadcasting, and geographic or subscription bypass are not included. Desktop widgets may not appear above exclusive fullscreen games or Windows security screens.

</details>

<details>
<summary><strong>Development &amp; builds</strong></summary>

Requires Node.js 22+.

```sh
npm ci
npm test
npm run build
npm start
```

For renderer development, run `npm run dev`, then launch Electron with `ALLRADIONE_DEV_URL=http://localhost:5173`. Native widgets, desktop launchers, and update installation require Electron.

Build the Windows installer with Visual Studio C++ Build Tools and the Windows SDK:

```sh
npm run dist:win
```

GitHub Actions checks audio, native widgets, installation, automatic updates, preference preservation, and removal. The installer upgrade baseline is the retained, SHA-256-pinned v0.2.4 release. Same-version builds exercise the update flow with a version-comparison fixture; later versions also cover cross-version upgrades.

For a release, update the package version and lockfile, add notes under `docs/releases/`, and push the matching `v<version>` tag. The release workflow validates the build and publishes the installer with `SHA256SUMS.txt` after all checks pass.

</details>

---

[MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)  
Station logos and broadcast content belong to their respective owners.
