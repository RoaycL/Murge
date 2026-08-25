# Third-Party Notices

This file lists the third-party software distributed with the Windows installer
and the application runtime. It is bundled into the installer artifacts so that
distribution obligations are met without requiring a separate download.

The product name, application identifiers and the licensing of the application
itself are defined in `brand.config.json` and `docs/BRANDING.md`. This notice
covers *third-party* components only.

## Runtime dependencies

The following libraries are bundled inside the application runtime. All are
MIT-licensed. Their upstream copyright notices and license texts apply and are
reproduced in the per-package files committed in `node_modules/` and retained in
the package lockfile. For each package: `Copyright (c) <contributors>`.

| Package          | Version   | License |
| ---------------- | --------- | ------- |
| vue              | 3.x       | MIT     |
| vue-router       | 4.x       | MIT     |
| pinia            | 3.x       | MIT     |
| @vueuse/core     | 13.x      | MIT     |
| zod              | 3.x       | MIT     |
| ws               | 8.x       | MIT     |

## Electron runtime

Electron is distributed with the packaged application and is licensed under the
MIT License. Electron also bundles Chromium and Node.js. The licenses for those
bundled components and their full notices are printed in the official Electron
distribution and are the responsibility of the Electron project.

## Build-tooling dependencies

The packaging toolchain (`electron`, `electron-builder`, `electron-vite`,
`@electron-toolkit/utils`, `@electron-toolkit/preload`) is MIT-licensed and is
used to produce the installer. It is not redistributed inside the shipped
application binary except where the MIT notice requires it.

## mihomo (proxy core)

This application does **not** currently bundle, execute, or ship the mihomo
proxy core. The default configuration runs against a harmless fixture process
and a real kernel is never launched automatically. Consequently no mihomo binary
or mihomo source is distributed in this phase and no mihomo source.offer
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
