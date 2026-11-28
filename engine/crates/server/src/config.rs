//! The `http` section of the server configuration, with its defaults, ranges and cross-field rules.
//!
//! Adapted from `src/hoi4_agent_tools/core/configuration.ts` (`tokenSchema`, `principalSchema`,
//! `allowedOriginSchema`, the `http` object with its `superRefine`, the HTTP timeout and event-byte
//! refinements of `serverConfigurationSchema`, and the grant checks of `loadConfiguration`),
//! commit 9b7dc80d. Unknown fields are refused as the strict zod objects refuse them.

use std::collections::BTreeSet;

use serde::Deserialize;
use url::Url;

use crate::error::ServiceError;

pub const HTTP_MAX_BODY_BYTES: u64 = 67_108_864;
pub const HTTP_MAX_AGGREGATE_BODY_BYTES: u64 = 134_217_728;
pub const HTTP_MAX_SAFE_CONCURRENT_REQUESTS: u64 = 1024;
pub const HTTP_DEFAULT_CONCURRENT_REQUESTS: u64 = 128;
pub const HTTP_DEFAULT_SESSION_EVENT_BYTES: u64 = 2_097_152;
pub const WORKSPACE_MAX_REGISTRATIONS: usize = 1_000;

/// One static bearer token: a principal, the environment variable that holds its secret, and grants.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TokenConfig {
    pub principal: String,
    pub token_env: String,
    #[serde(default)]
    pub workspace_ids: Vec<String>,
    #[serde(default)]
    pub allow_discovered_mods: bool,
}

/// One OAuth principal (a token subject) and its grants.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PrincipalConfig {
    pub principal: String,
    #[serde(default)]
    pub workspace_ids: Vec<String>,
    #[serde(default)]
    pub allow_discovered_mods: bool,
}

/// OAuth/OIDC JWT verification settings.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OAuthConfig {
    pub issuer: String,
    pub jwks_uri: String,
    pub audience: String,
    pub authorization_servers: Vec<String>,
    #[serde(default = "default_required_scopes")]
    pub required_scopes: Vec<String>,
    #[serde(default = "default_algorithms")]
    pub algorithms: Vec<String>,
}

fn default_required_scopes() -> Vec<String> {
    vec!["hoi4:read".to_owned()]
}

fn default_algorithms() -> Vec<String> {
    vec!["RS256".to_owned()]
}

const JWT_ALGORITHMS: [&str; 7] = ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "EdDSA"];

/// The Streamable HTTP deployment settings.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", default)]
pub struct HttpConfig {
    pub host: String,
    pub port: u16,
    pub public_url: Option<String>,
    pub allowed_origins: Vec<String>,
    pub trusted_proxy_addresses: Vec<String>,
    pub tokens: Vec<TokenConfig>,
    pub principals: Vec<PrincipalConfig>,
    pub oauth: Option<OAuthConfig>,
    pub max_body_bytes: u64,
    pub headers_timeout_ms: u64,
    pub request_timeout_ms: u64,
    pub keep_alive_timeout_ms: u64,
    pub max_connections: u64,
    pub max_requests_per_socket: u64,
    pub max_concurrent_requests: u64,
    pub max_sessions: u64,
    pub max_sessions_per_principal: u64,
    pub max_event_streams: u64,
    pub max_event_streams_per_principal: u64,
    pub max_session_event_bytes: u64,
    pub max_event_store_bytes: u64,
    pub requests_per_minute: u64,
    pub session_ttl_seconds: u64,
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_owned(),
            port: 3210,
            public_url: None,
            allowed_origins: Vec::new(),
            trusted_proxy_addresses: Vec::new(),
            tokens: Vec::new(),
            principals: Vec::new(),
            oauth: None,
            max_body_bytes: HTTP_MAX_BODY_BYTES,
            headers_timeout_ms: 10_000,
            request_timeout_ms: 30_000,
            keep_alive_timeout_ms: 5_000,
            max_connections: 512,
            max_requests_per_socket: 100,
            max_concurrent_requests: HTTP_DEFAULT_CONCURRENT_REQUESTS,
            max_sessions: 128,
            max_sessions_per_principal: 32,
            max_event_streams: 128,
            max_event_streams_per_principal: 32,
            max_session_event_bytes: HTTP_DEFAULT_SESSION_EVENT_BYTES,
            max_event_store_bytes: 16_777_216,
            requests_per_minute: 6_000,
            session_ttl_seconds: 3600,
        }
    }
}

fn invalid(message: impl Into<String>) -> ServiceError {
    ServiceError::new("CONFIG_INVALID", message)
}

fn check_range(name: &str, value: u64, min: u64, max: u64) -> Result<(), ServiceError> {
    if value < min || value > max {
        return Err(invalid(format!("http.{name} must be between {min} and {max}")));
    }
    Ok(())
}

fn matches_charset(value: &str, min: usize, max: usize, allowed: impl Fn(char) -> bool) -> bool {
    let count = value.chars().count();
    (min..=max).contains(&count) && value.chars().all(allowed)
}

fn is_absolute_url(value: &str) -> bool {
    Url::parse(value).is_ok()
}

/// An exact HTTP(S) origin without credentials, a path, a query or a fragment.
pub fn is_allowed_origin(value: &str) -> bool {
    let Ok(parsed) = Url::parse(value) else { return false };
    matches!(parsed.scheme(), "http" | "https")
        && parsed.origin().is_tuple()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.path() == "/"
        && parsed.query().is_none()
        && parsed.fragment().is_none()
}

fn is_ip_address(value: &str) -> bool {
    value.parse::<std::net::IpAddr>().is_ok()
}

impl HttpConfig {
    /// Parses the `http` object and applies every rule of the TypeScript schema.
    pub fn from_json(value: &serde_json::Value) -> Result<Self, ServiceError> {
        let config: Self = serde_json::from_value(value.clone()).map_err(|error| invalid(format!("Configuration failed schema validation: {error}")))?;
        config.validate()?;
        Ok(config)
    }

    /// The field ranges and the cross-field rules of the `http` schema and its parent refinements.
    pub fn validate(&self) -> Result<(), ServiceError> {
        if let Some(public_url) = &self.public_url
            && !is_absolute_url(public_url)
        {
            return Err(invalid("http.publicUrl must be a URL"));
        }
        if self.allowed_origins.iter().any(|origin| !is_allowed_origin(origin)) {
            return Err(invalid("Allowed origins must be exact HTTP(S) origins without credentials or paths"));
        }
        if self.trusted_proxy_addresses.iter().any(|address| !is_ip_address(address)) {
            return Err(invalid("http.trustedProxyAddresses must be IPv4 or IPv6 addresses"));
        }
        if self.tokens.len() > WORKSPACE_MAX_REGISTRATIONS || self.principals.len() > WORKSPACE_MAX_REGISTRATIONS {
            return Err(invalid("Too many HTTP tokens or principals"));
        }
        for token in &self.tokens {
            if !matches_charset(&token.principal, 1, 128, |c| c.is_ascii_alphanumeric() || "._@-".contains(c)) {
                return Err(invalid("Static-token principal has an invalid form"));
            }
            let env = &token.token_env;
            if !(2..=128).contains(&env.len())
                || !env.starts_with(|c: char| c.is_ascii_uppercase())
                || !env.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            {
                return Err(invalid("Static-token environment name has an invalid form"));
            }
            if token.workspace_ids.len() > WORKSPACE_MAX_REGISTRATIONS {
                return Err(invalid("Too many workspace grants"));
            }
        }
        for principal in &self.principals {
            if !matches_charset(&principal.principal, 1, 256, |c| c.is_ascii_alphanumeric() || "._@:-".contains(c)) {
                return Err(invalid("OAuth principal has an invalid form"));
            }
            if principal.workspace_ids.len() > WORKSPACE_MAX_REGISTRATIONS {
                return Err(invalid("Too many workspace grants"));
            }
        }
        if let Some(oauth) = &self.oauth {
            let urls = [&oauth.issuer, &oauth.jwks_uri].into_iter().chain(oauth.authorization_servers.iter());
            if urls.into_iter().any(|url| !is_absolute_url(url)) {
                return Err(invalid("OAuth URLs must be URLs"));
            }
            if oauth.audience.is_empty() || oauth.authorization_servers.is_empty() {
                return Err(invalid("OAuth needs an audience and at least one authorization server"));
            }
            if oauth.required_scopes.iter().any(String::is_empty) {
                return Err(invalid("OAuth required scopes must not be empty"));
            }
            if oauth.algorithms.iter().any(|algorithm| !JWT_ALGORITHMS.contains(&algorithm.as_str())) {
                return Err(invalid("OAuth algorithms must be JOSE asymmetric algorithms"));
            }
        }
        check_range("maxBodyBytes", self.max_body_bytes, 1024, HTTP_MAX_BODY_BYTES)?;
        check_range("headersTimeoutMs", self.headers_timeout_ms, 1_000, 120_000)?;
        check_range("requestTimeoutMs", self.request_timeout_ms, 1_000, 300_000)?;
        check_range("keepAliveTimeoutMs", self.keep_alive_timeout_ms, 1_000, 120_000)?;
        check_range("maxConnections", self.max_connections, 1, 100_000)?;
        check_range("maxRequestsPerSocket", self.max_requests_per_socket, 1, 100_000)?;
        check_range("maxConcurrentRequests", self.max_concurrent_requests, 1, HTTP_MAX_SAFE_CONCURRENT_REQUESTS)?;
        check_range("maxSessions", self.max_sessions, 1, 10_000)?;
        check_range("maxSessionsPerPrincipal", self.max_sessions_per_principal, 1, 10_000)?;
        check_range("maxEventStreams", self.max_event_streams, 1, 10_000)?;
        check_range("maxEventStreamsPerPrincipal", self.max_event_streams_per_principal, 1, 10_000)?;
        check_range("maxSessionEventBytes", self.max_session_event_bytes, 65_536, 67_108_864)?;
        check_range("maxEventStoreBytes", self.max_event_store_bytes, 65_536, 268_435_456)?;
        check_range("requestsPerMinute", self.requests_per_minute, 1, 100_000)?;
        check_range("sessionTtlSeconds", self.session_ttl_seconds, 60, 86_400)?;

        if self.oauth.is_some() && !self.tokens.is_empty() {
            return Err(invalid("OAuth and static bearer tokens are mutually exclusive deployment modes"));
        }
        let mut token_principals = BTreeSet::new();
        let mut token_environments = BTreeSet::new();
        for token in &self.tokens {
            if !token_principals.insert(token.principal.as_str()) {
                return Err(invalid("Static-token principals must be unique"));
            }
            if !token_environments.insert(token.token_env.as_str()) {
                return Err(invalid("Static-token environment names must be unique"));
            }
        }
        let mut oauth_principals = BTreeSet::new();
        for principal in &self.principals {
            if !oauth_principals.insert(principal.principal.as_str()) {
                return Err(invalid("OAuth principals must be unique"));
            }
            if token_principals.contains(principal.principal.as_str()) {
                return Err(invalid("Static-token and OAuth principal namespaces must be disjoint"));
            }
        }
        if self.max_session_event_bytes > self.max_event_store_bytes {
            return Err(invalid("Per-session event bytes cannot exceed the global event-store ceiling"));
        }
        if self.headers_timeout_ms > self.request_timeout_ms {
            return Err(invalid("HTTP header timeout cannot exceed the complete-request timeout"));
        }
        if self.keep_alive_timeout_ms >= self.headers_timeout_ms {
            return Err(invalid("HTTP keep-alive timeout must be shorter than the header timeout"));
        }
        Ok(())
    }

    /// Refuses a token or principal that grants a workspace the configuration does not register.
    pub fn check_grants(&self, registered: &BTreeSet<String>) -> Result<(), ServiceError> {
        let unknown = |ids: &[String]| ids.iter().any(|id| !registered.contains(id));
        if self.tokens.iter().any(|token| unknown(&token.workspace_ids)) {
            return Err(ServiceError::new("CONFIG_UNKNOWN_WORKSPACE_GRANT", "HTTP token grants unknown workspaces"));
        }
        if self.principals.iter().any(|principal| unknown(&principal.workspace_ids)) {
            return Err(ServiceError::new("CONFIG_UNKNOWN_WORKSPACE_GRANT", "HTTP principal grants unknown workspaces"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_the_typescript_schema() {
        let config = HttpConfig::from_json(&json!({})).unwrap();
        assert_eq!(config, HttpConfig::default());
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.max_body_bytes, HTTP_MAX_BODY_BYTES);
    }

    #[test]
    fn refuses_unknown_fields_and_out_of_range_values() {
        assert!(HttpConfig::from_json(&json!({ "unexpected": true })).is_err());
        assert!(HttpConfig::from_json(&json!({ "maxBodyBytes": 10 })).is_err());
        assert!(HttpConfig::from_json(&json!({ "sessionTtlSeconds": 59 })).is_err());
        assert!(HttpConfig::from_json(&json!({ "tokens": [{ "principal": "a", "tokenEnv": "A", "extra": 1 }] })).is_err());
    }

    #[test]
    fn refuses_origins_with_paths_credentials_or_odd_schemes() {
        for origin in ["https://a.test/path", "https://u:p@a.test", "ftp://a.test", "https://a.test/?q", "https://a.test/#x", "not a url"] {
            assert!(HttpConfig::from_json(&json!({ "allowedOrigins": [origin] })).is_err(), "{origin}");
        }
        assert!(HttpConfig::from_json(&json!({ "allowedOrigins": ["https://a.test"] })).is_ok());
    }

    #[test]
    fn refuses_mixed_modes_duplicates_and_shared_namespaces() {
        let oauth = json!({ "issuer": "https://i.test/", "jwksUri": "https://i.test/jwks", "audience": "a", "authorizationServers": ["https://i.test/"] });
        let token = json!({ "principal": "user", "tokenEnv": "TOKEN_A" });
        assert!(HttpConfig::from_json(&json!({ "oauth": oauth, "tokens": [token] })).is_err());
        assert!(HttpConfig::from_json(&json!({ "tokens": [token, { "principal": "user", "tokenEnv": "TOKEN_B" }] })).is_err());
        assert!(HttpConfig::from_json(&json!({ "tokens": [token, { "principal": "other", "tokenEnv": "TOKEN_A" }] })).is_err());
        assert!(HttpConfig::from_json(&json!({ "tokens": [token], "principals": [{ "principal": "user" }] })).is_err());
        assert!(HttpConfig::from_json(&json!({ "principals": [{ "principal": "p" }, { "principal": "p" }] })).is_err());
    }

    #[test]
    fn refuses_inconsistent_timeouts_and_event_budgets() {
        assert!(HttpConfig::from_json(&json!({ "headersTimeoutMs": 40_000 })).is_err());
        assert!(HttpConfig::from_json(&json!({ "keepAliveTimeoutMs": 10_000 })).is_err());
        assert!(HttpConfig::from_json(&json!({ "maxSessionEventBytes": 67_108_864, "maxEventStoreBytes": 65_536 })).is_err());
    }

    #[test]
    fn refuses_grants_of_unregistered_workspaces() {
        let config = HttpConfig::from_json(&json!({ "tokens": [{ "principal": "u", "tokenEnv": "TOKEN_A", "workspaceIds": ["ghost"] }] })).unwrap();
        let registered = BTreeSet::from(["fixture".to_owned()]);
        assert_eq!(config.check_grants(&registered).unwrap_err().code, "CONFIG_UNKNOWN_WORKSPACE_GRANT");
        let config = HttpConfig::from_json(&json!({ "principals": [{ "principal": "u", "workspaceIds": ["ghost"] }] })).unwrap();
        assert_eq!(config.check_grants(&registered).unwrap_err().code, "CONFIG_UNKNOWN_WORKSPACE_GRANT");
    }
}
