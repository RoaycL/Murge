# Branding and rename contract

All public identity is sourced from `brand.config.json`.

## Configured fields

- `productName`: window title, installer name and user-facing full name.
- `shortName`: compact navigation/about text.
- `appId`: package identity. Changing it creates a different installed application.
- `executableName`: Windows executable base name.
- `protocolScheme`: deep-link scheme.
- `companyName`: installer publisher text before code signing is applied.
- `repositoryUrl` and `supportUrl`: About and diagnostics links.
- `copyright`: About and metadata text.

## Rename procedure

1. Update `brand.config.json`.
2. Replace assets under `resources/icons` when that directory is introduced.
3. Run `npm run brand:check`.
4. Build an unpacked application and verify filename, process name and title.
5. Decide whether `appId` and `protocolScheme` should migrate or remain compatible.
6. If changing `appId`, document how existing profiles are imported from the old application-data directory.

## Forbidden coupling

- Do not use the product name in TypeScript class names, IPC channels or storage keys.
- Do not name environment variables after the product in new code. Existing `MURGE_DEV_*` variables are temporary development compatibility names and should be replaced with neutral `APP_DEV_*` names before the first rename.
- Do not hardcode the repository owner.
- Do not infer an application-data folder from `productName`; use a stable storage namespace with an explicit migration map.

The `brand:check` script intentionally fails when the current public name appears in source/config files outside approved branding documents.
