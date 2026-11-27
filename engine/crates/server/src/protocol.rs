//! The MCP protocol gate: which revisions this server speaks and how `initialize` negotiates.
//!
//! Adapted from `src/hoi4_agent_tools/mcp/transports/protocol-gate.ts` (`gateInitializeVersion`)
//! and `rejectInvalidProtocolHeader` of `src/hoi4_agent_tools/mcp/transports/http.ts`, with the
//! revision list of `@modelcontextprotocol/sdk` `SUPPORTED_PROTOCOL_VERSIONS`, commit 9b7dc80d.
//! The TypeScript gate rewrote an unknown revision to a sentinel so the SDK answered with its
//! latest one; here [`negotiate`] answers the latest revision directly.

/// The newest revision, answered to a client that asks for one this server does not know.
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";

/// Every revision this server negotiates, newest first.
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] = [LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

/// The revision the server answers to an `initialize` request for `requested`.
pub fn negotiate(requested: Option<&str>) -> &'static str {
    requested.and_then(|requested| SUPPORTED_PROTOCOL_VERSIONS.iter().copied().find(|version| *version == requested)).unwrap_or(LATEST_PROTOCOL_VERSION)
}

/// Checks the `MCP-Protocol-Version` header. `Err` holds the 400 message.
pub fn check_protocol_header(value: Option<&str>, required: bool) -> Result<(), String> {
    let list = SUPPORTED_PROTOCOL_VERSIONS.join(", ");
    match value {
        Some(version) if SUPPORTED_PROTOCOL_VERSIONS.contains(&version) => Ok(()),
        None if !required => Ok(()),
        None => Err(format!("Missing MCP-Protocol-Version header; this server supports {list}")),
        Some(_) => Err(format!("Unsupported MCP protocol version; this server supports {list}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_revisions_fall_back_to_the_latest() {
        assert_eq!(negotiate(Some("2025-06-18")), "2025-06-18");
        assert_eq!(negotiate(Some("2024-10-07")), "2024-10-07");
        assert_eq!(negotiate(Some("2026-07-28")), LATEST_PROTOCOL_VERSION);
        assert_eq!(negotiate(Some("1999-01-01")), LATEST_PROTOCOL_VERSION);
        assert_eq!(negotiate(None), LATEST_PROTOCOL_VERSION);
    }

    #[test]
    fn the_header_must_name_a_supported_revision_when_required() {
        assert!(check_protocol_header(Some("2025-11-25"), true).is_ok());
        assert!(check_protocol_header(None, false).is_ok());
        assert!(check_protocol_header(None, true).unwrap_err().starts_with("Missing MCP-Protocol-Version header"));
        assert!(check_protocol_header(Some("2099-01-01"), false).unwrap_err().starts_with("Unsupported MCP protocol version"));
    }
}
