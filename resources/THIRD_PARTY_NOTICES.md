# Third-Party Notices

This file lists the third-party software distributed with the Windows installer
and the application runtime. It is bundled into the installer artifacts so that
distribution obligations are met without requiring a separate download.

The product name and application identifiers are defined in
`brand.config.json` and `docs/BRANDING.md`. Murge itself is licensed under
GPL-3.0-only; the complete application license is installed as `LICENSE.txt`.
This notice covers *third-party* components only and does not replace their
individual license texts.

## Runtime dependencies

The following libraries are bundled inside the application runtime. All are
MIT-licensed except `yaml`, which is ISC-licensed (both permissive). The full
upstream copyright notices and license texts are shipped
alongside the application in the `licenses/` resource directory (one file per
package) and are the authoritative copies for preserving notices.
Each bundle is reproduced verbatim from the package's own LICENSE file, so the
copyright owners and license terms are retained exactly as published upstream.

| Package            | License file in the artifact | Version | License |
| ------------------ | ---------------------------- | ------- | ------- |
| vue                | `licenses/vue.txt`           | 3.x     | MIT     |
| vue-router         | `licenses/vue-router.txt`    | 4.x     | MIT     |
| pinia              | `licenses/pinia.txt`         | 3.x     | MIT     |
| @vueuse/core       | `licenses/vueuse-core.txt`   | 13.x    | MIT     |
| zod                | `licenses/zod.txt`           | 3.x     | MIT     |
| ws                 | `licenses/ws.txt`            | 8.x     | MIT     |
| yaml               | `licenses/yaml.txt`          | 2.x     | ISC     |

## Electron runtime

Electron is distributed with the packaged application and is licensed under the
MIT License (reproduced at `licenses/electron.txt`). Electron also bundles
Chromium and Node.js. The licenses for those bundled components and their full
notices are printed in the official Electron distribution and are the
responsibility of the Electron project.

## Build-tooling dependencies

The packaging toolchain (`electron-vite`, `@electron-toolkit/utils`,
`@electron-toolkit/preload`) is MIT-licensed and, where it is linked into the
application runtime, its notice is retained at
`licenses/electron-toolkit-utils.txt` and `licenses/electron-toolkit-preload.txt`.
`electron-builder` is used only to produce the installer and is not shipped as
part of the application runtime.

## mihomo (proxy core)

This application does **not** currently bundle, execute, or ship the mihomo
proxy core. The default configuration runs against a harmless fixture process
and a real kernel is never launched automatically. Consequently no mihomo binary
or mihomo source is distributed in this phase and no mihomo source-offer
obligation is triggered yet.

mihomo is a separate project distributed under the GNU General Public License
version 3 (GPL-3.0). When a later milestone enables and distributes a real
mihomo binary, this notice must be updated to provide the corresponding GPL
compliance materials: the exact license text, a written offer to supply source
(or the source itself), and any corresponding source used to build the shipped
binary. See `docs/MIHOMO_API.md` for the integration boundary. This separation
is intentional: the proxy core runs as an independent child process and is not
linked into the application's own code, so the application's own source and
license remain independent of mihomo's GPL terms.
