//! IPC error wire format — the Rust mirror of `src/shared/protocol-errors.ts`.
//!
//! Electron can only carry an error string across IPC, so `ProtocolError`
//! serializes as `PROTOCOL_ERROR:<CODE>::<message>`. Tauri command errors keep
//! the identical encoding (the TS bridge decodes with the SAME
//! `decodeProtocolError` helper), so error mapping is shell-independent.

use serde::Serialize;

/// Error codes mirrored from `ProtocolErrorCode` (@shared/protocol-errors.ts).
/// Only the codes the Rust slices raise today; later slices add theirs here.
#[allow(dead_code)] // staged slices raise their codes when they land
pub mod code {
    pub const INVALID_ARGUMENT: &str = "INVALID_ARGUMENT";
    pub const NOT_FOUND: &str = "NOT_FOUND";
    pub const UNSUPPORTED: &str = "UNSUPPORTED";
    pub const INTERNAL: &str = "INTERNAL";
    pub const UNAUTHORIZED: &str = "UNAUTHORIZED";
    pub const UPSTREAM_UNREACHABLE: &str = "UPSTREAM_UNREACHABLE";
    pub const UPSTREAM_TIMEOUT: &str = "UPSTREAM_TIMEOUT";
    pub const UPSTREAM_HTTP_ERROR: &str = "UPSTREAM_HTTP_ERROR";
    pub const UPSTREAM_TEST_FAILED: &str = "UPSTREAM_TEST_FAILED";
    pub const INVALID_UPSTREAM: &str = "INVALID_UPSTREAM";
}

/// A failed IPC call. Serialized to the ProtocolError wire string so the
/// renderer-side decoder stays the single error mapping for both shells.
#[derive(Debug)]
pub struct IpcError(pub String);

impl Serialize for IpcError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl IpcError {
    /// Encode with an explicit ProtocolErrorCode.
    pub fn code(code: &str, message: impl Into<String>) -> Self {
        IpcError(format!("PROTOCOL_ERROR:{code}::{}", message.into()))
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::code(code::INVALID_ARGUMENT, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::code(code::NOT_FOUND, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::code(code::UNSUPPORTED, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::code(code::INTERNAL, message)
    }

    /// The channel has no Rust handler yet (honest fail-closed during the
    /// migration — never a silent no-op).
    pub fn unsupported_channel(channel: &str) -> Self {
        Self::unsupported(format!(
            "channel '{channel}' has no Tauri handler yet (planned Phase 3 slice)"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_format_matches_the_shared_encoder() {
        assert_eq!(
            IpcError::code(code::NOT_FOUND, "profile x not found").0,
            "PROTOCOL_ERROR:NOT_FOUND::profile x not found"
        );
    }
}
