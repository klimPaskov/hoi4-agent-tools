//! Principal-to-workspace grants and the scopes a request needs.
//!
//! Adapted from `src/hoi4_agent_tools/core/workspace.ts` (`allowedWorkspaceIds`,
//! `discoveredModsAllowed`, the principal check of `get`) and
//! `src/hoi4_agent_tools/mcp/transports/http.ts` (`WRITE_SCOPED_TOOLS`,
//! `requiredScopesForMcpRequest`), commit 9b7dc80d.
//!
//! Remote access never broadens a grant: a principal reaches only the workspaces its token or
//! OAuth entry names, plus discovered mods when that entry allows them.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::config::HttpConfig;
use crate::error::ServiceError;

/// Tools that need the `hoi4:write` scope over HTTP.
pub const WRITE_SCOPED_TOOLS: [&str; 11] = [
    "hoi4.focus_rewrite",
    "hoi4.gui_rewrite",
    "hoi4.map_rewrite",
    "hoi4.localisation_write",
    "hoi4.idea_write",
    "hoi4.character_write",
    "hoi4.event_write",
    "hoi4.decision_write",
    "hoi4.tech_write",
    "hoi4.doctrine_write",
    "hoi4.common_write",
];

/// The scopes one JSON-RPC body needs: the base scopes, plus `hoi4:write` for a write tool call.
pub fn required_scopes_for_mcp_request(config: &HttpConfig, body: Option<&Value>) -> Vec<String> {
    let mut scopes = match &config.oauth {
        Some(oauth) => oauth.required_scopes.clone(),
        None => vec!["hoi4:read".to_owned()],
    };
    let tool = body
        .filter(|body| body.get("method").and_then(Value::as_str) == Some("tools/call"))
        .and_then(|body| body.get("params"))
        .filter(|params| params.is_object())
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str);
    if tool.is_some_and(|name| WRITE_SCOPED_TOOLS.contains(&name)) {
        scopes.push("hoi4:write".to_owned());
    }
    let mut seen = BTreeSet::new();
    scopes.retain(|scope| seen.insert(scope.clone()));
    scopes
}

/// The workspace grants of every configured principal.
#[derive(Debug, Clone)]
pub struct Grants {
    config: HttpConfig,
}

impl Grants {
    pub fn new(config: &HttpConfig) -> Self {
        Self { config: config.clone() }
    }

    fn discovered_mods_allowed(&self, principal: &str) -> bool {
        self.config.tokens.iter().any(|entry| entry.principal == principal && entry.allow_discovered_mods)
            || self.config.principals.iter().any(|entry| entry.principal == principal && entry.allow_discovered_mods)
    }

    /// The workspace ids a principal may reach, given the ids of the discovered mod workspaces.
    pub fn allowed_workspace_ids(&self, principal: &str, discovered: &[String]) -> BTreeSet<String> {
        let mut allowed = BTreeSet::new();
        for token in self.config.tokens.iter().filter(|entry| entry.principal == principal) {
            allowed.extend(token.workspace_ids.iter().cloned());
        }
        for entry in self.config.principals.iter().filter(|entry| entry.principal == principal) {
            allowed.extend(entry.workspace_ids.iter().cloned());
        }
        if self.discovered_mods_allowed(principal) {
            allowed.extend(discovered.iter().cloned());
        }
        allowed
    }

    /// Refuses a workspace the principal is not granted with the same code and message whether or
    /// not the workspace exists, so a refusal does not reveal other principals' workspaces.
    pub fn check(&self, principal: &str, workspace_id: &str, discovered: &[String]) -> Result<(), ServiceError> {
        if self.allowed_workspace_ids(principal, discovered).contains(workspace_id) {
            Ok(())
        } else {
            Err(ServiceError::new("WORKSPACE_INACCESSIBLE", "Workspace is unavailable to the authenticated principal"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> HttpConfig {
        HttpConfig::from_json(&json!({
            "tokens": [
                { "principal": "alice", "tokenEnv": "TOKEN_A", "workspaceIds": ["mod_a"] },
                { "principal": "bob", "tokenEnv": "TOKEN_B", "workspaceIds": ["mod_b"], "allowDiscoveredMods": true },
            ],
        }))
        .unwrap()
    }

    #[test]
    fn a_principal_reaches_only_its_grants() {
        let grants = Grants::new(&config());
        let discovered = vec!["found_mod".to_owned()];
        assert!(grants.check("alice", "mod_a", &discovered).is_ok());
        assert_eq!(grants.check("alice", "mod_b", &discovered).unwrap_err().code, "WORKSPACE_INACCESSIBLE");
        assert_eq!(grants.check("alice", "found_mod", &discovered).unwrap_err().code, "WORKSPACE_INACCESSIBLE");
        assert_eq!(grants.check("alice", "no_such", &discovered).unwrap_err(), grants.check("alice", "mod_b", &discovered).unwrap_err());
        assert!(grants.check("bob", "found_mod", &discovered).is_ok());
        assert!(grants.check("mallory", "mod_a", &discovered).is_err());
        assert_eq!(grants.allowed_workspace_ids("bob", &discovered), BTreeSet::from(["mod_b".to_owned(), "found_mod".to_owned()]));
    }

    #[test]
    fn write_tools_need_the_write_scope() {
        let config = config();
        let call = |name: &str| json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name } });
        assert_eq!(required_scopes_for_mcp_request(&config, None), vec!["hoi4:read"]);
        assert_eq!(required_scopes_for_mcp_request(&config, Some(&call("hoi4.focus_rewrite"))), vec!["hoi4:read", "hoi4:write"]);
        assert_eq!(required_scopes_for_mcp_request(&config, Some(&call("hoi4.focus_inspect"))), vec!["hoi4:read"]);
        // A read-only token reaches only the read scope, so a call of the common writer needs more.
        assert_eq!(required_scopes_for_mcp_request(&config, Some(&call("hoi4.common_write"))), vec!["hoi4:read", "hoi4:write"]);
        let listed = json!({ "method": "tools/list", "params": { "name": "hoi4.map_rewrite" } });
        assert_eq!(required_scopes_for_mcp_request(&config, Some(&listed)), vec!["hoi4:read"]);
    }
}
