//! Bearer authentication, scopes, challenges, deployment rules and Protected Resource Metadata.
//!
//! Adapted from `src/hoi4_agent_tools/mcp/security/auth.ts` (`normalizedScopes`, `bearer`,
//! `equalSecret`, `credentialId`, `tokenScopes`, `requireScopes`, `validateStaticTokenSecrets`,
//! `authenticate`, `protectedResourceMetadataUrl`, `bearerChallenge`, `isLoopbackHost`,
//! `validateHttpDeployment`, `protectedResourceMetadata`), commit 9b7dc80d.
//!
//! The JWT signature check and the JWKS fetch sit behind [`JwtVerifier`]. The claim rules that
//! follow a verified signature (subject, expiry, principal allowlist, scopes, client id) are here.
//! A server given an OAuth configuration and no verifier refuses to start.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use url::Url;

use crate::config::HttpConfig;
use crate::error::ServiceError;

/// The principal one request authenticated as. Holds no secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedPrincipal {
    pub principal: String,
    pub client_id: String,
    /// A non-secret binding for the exact bearer credential presented on this request.
    pub credential_id: String,
    pub scopes: Vec<String>,
    /// Seconds since the Unix epoch, from the token's `exp` claim.
    pub expires_at: Option<f64>,
}

/// The `error` parameter of a bearer challenge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BearerError {
    InvalidToken,
    InsufficientScope,
}

impl BearerError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidToken => "invalid_token",
            Self::InsufficientScope => "insufficient_scope",
        }
    }
}

/// A refused authentication: the HTTP status, the code in the body, and the challenge parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpAuthError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub bearer_error: Option<BearerError>,
    pub required_scopes: Vec<String>,
}

impl HttpAuthError {
    pub fn new(status: u16, code: &'static str, message: &str, bearer_error: Option<BearerError>, required_scopes: &[String]) -> Self {
        Self { status, code, message: message.to_owned(), bearer_error, required_scopes: required_scopes.to_vec() }
    }

    fn invalid(message: &str, required_scopes: &[String]) -> Self {
        Self::new(401, "AUTH_INVALID", message, Some(BearerError::InvalidToken), required_scopes)
    }
}

/// Either a malformed scope request (a server error) or a refused credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthFailure {
    Service(ServiceError),
    Http(HttpAuthError),
}

impl From<ServiceError> for AuthFailure {
    fn from(error: ServiceError) -> Self {
        Self::Service(error)
    }
}

impl From<HttpAuthError> for AuthFailure {
    fn from(error: HttpAuthError) -> Self {
        Self::Http(error)
    }
}

/// Checks a JWT's signature, issuer, audience and algorithm, and returns its payload claims.
///
/// An implementation verifies against the configured JWKS with a 5-second clock tolerance, as
/// `jwtVerify` does in the TypeScript server. Any failure is reported as `Err`.
pub trait JwtVerifier: Send + Sync {
    fn verify(&self, token: &str) -> Result<Map<String, Value>, String>;
}

fn is_scope_token(scope: &str) -> bool {
    !scope.is_empty() && scope.bytes().all(|byte| matches!(byte, 0x21 | 0x23..=0x5B | 0x5D..=0x7E))
}

/// De-duplicates scopes in first-seen order and refuses a scope outside the RFC 6750 syntax.
pub fn normalized_scopes(scopes: &[String]) -> Result<Vec<String>, ServiceError> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for scope in scopes {
        if seen.insert(scope.as_str()) {
            normalized.push(scope.clone());
        }
    }
    if normalized.iter().any(|scope| !is_scope_token(scope)) {
        return Err(ServiceError::new("HTTP_SCOPE_INVALID", "OAuth scopes must use the RFC 6750 scope syntax"));
    }
    Ok(normalized)
}

fn strip_bearer_prefix(header: &str) -> Option<&str> {
    let bytes = header.as_bytes();
    if bytes.len() < 7 || !bytes[..6].eq_ignore_ascii_case(b"bearer") {
        return None;
    }
    let rest = &header[6..];
    let trimmed = rest.trim_start_matches(|c: char| c.is_whitespace());
    if trimmed.len() == rest.len() {
        return None;
    }
    Some(trimmed)
}

fn bearer<'a>(header: Option<&'a str>, required: &[String]) -> Result<&'a str, HttpAuthError> {
    let Some(rest) = header.and_then(strip_bearer_prefix) else {
        return Err(HttpAuthError::new(401, "AUTH_REQUIRED", "A bearer token is required", None, required));
    };
    let token = rest.trim();
    // The TypeScript limit counts UTF-16 code units.
    let length = token.encode_utf16().count();
    if length == 0 || length > 16_384 {
        return Err(HttpAuthError::new(401, "AUTH_INVALID", "Bearer token is invalid", Some(BearerError::InvalidToken), required));
    }
    Ok(token)
}

/// Compares two secrets in time that depends only on their lengths.
pub fn equal_secret(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    std::hint::black_box(difference) == 0
}

fn hex_sha256(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `sha256:<hex>` of the presented token: binds a session to one credential without keeping it.
pub fn credential_id(token: &str) -> String {
    format!("sha256:{}", hex_sha256(token))
}

fn token_scopes(payload: &Map<String, Value>) -> Result<Vec<String>, ServiceError> {
    if let Some(Value::String(scope)) = payload.get("scope") {
        let scopes: Vec<String> = scope.split_whitespace().map(str::to_owned).collect();
        return normalized_scopes(&scopes);
    }
    if let Some(Value::Array(values)) = payload.get("scp")
        && values.iter().all(Value::is_string)
    {
        let scopes: Vec<String> = values.iter().filter_map(|value| value.as_str().map(str::to_owned)).collect();
        return normalized_scopes(&scopes);
    }
    Ok(Vec::new())
}

fn require_scopes(actual: &[String], required: &[String]) -> Result<(), AuthFailure> {
    let required = normalized_scopes(required)?;
    if required.iter().all(|scope| actual.contains(scope)) {
        return Ok(());
    }
    Err(HttpAuthError::new(403, "AUTH_SCOPE_INSUFFICIENT", "Bearer token lacks a required scope", Some(BearerError::InsufficientScope), &required).into())
}

/// The scopes every MCP request needs: the OAuth `requiredScopes`, or `hoi4:read`.
pub fn default_required_scopes(config: &HttpConfig) -> Result<Vec<String>, ServiceError> {
    match &config.oauth {
        Some(oauth) => normalized_scopes(&oauth.required_scopes),
        None => Ok(vec!["hoi4:read".to_owned()]),
    }
}

/// Looks up an environment variable; tests pass a map instead of the process environment.
pub type SecretLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

fn validate_static_token_secrets(config: &HttpConfig, secrets: SecretLookup<'_>) -> Result<(), ServiceError> {
    let mut fingerprints = BTreeSet::new();
    for configured in &config.tokens {
        let secret = secrets(&configured.token_env);
        let Some(secret) = secret.filter(|secret| secret.encode_utf16().count() >= 32) else {
            return Err(ServiceError::new("HTTP_STATIC_TOKEN_INVALID", "Every configured static-token environment variable must contain at least 32 characters"));
        };
        if !fingerprints.insert(hex_sha256(&secret)) {
            return Err(ServiceError::new("HTTP_STATIC_TOKEN_DUPLICATE", "Configured static bearer tokens must have distinct secret values"));
        }
    }
    Ok(())
}

struct StaticToken {
    principal: String,
    secret: String,
}

/// Authenticates bearer credentials for one server. Secrets are read once, at start.
pub struct Authenticator {
    config: HttpConfig,
    static_tokens: Vec<StaticToken>,
    verifier: Option<Box<dyn JwtVerifier>>,
}

impl std::fmt::Debug for Authenticator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Authenticator").field("static_tokens", &self.static_tokens.len()).field("oauth", &self.verifier.is_some()).finish()
    }
}

impl Authenticator {
    /// Reads the configured static-token secrets. A secret shorter than 32 characters is skipped
    /// here, as the TypeScript server skips it; [`validate_http_deployment`] refuses it at start.
    pub fn new(config: &HttpConfig, secrets: SecretLookup<'_>, verifier: Option<Box<dyn JwtVerifier>>) -> Self {
        let static_tokens = config
            .tokens
            .iter()
            .filter_map(|token| {
                let secret = secrets(&token.token_env)?;
                (secret.encode_utf16().count() >= 32).then(|| StaticToken { principal: token.principal.clone(), secret })
            })
            .collect();
        Self { config: config.clone(), static_tokens, verifier }
    }

    pub fn config(&self) -> &HttpConfig {
        &self.config
    }

    /// Authenticates an `Authorization` header value against the required scopes.
    pub fn authenticate(&self, authorization: Option<&str>, required_scopes: &[String], now_seconds: f64) -> Result<AuthenticatedPrincipal, AuthFailure> {
        let required = normalized_scopes(required_scopes)?;
        let token = bearer(authorization, &required)?;
        let presented = credential_id(token);
        if self.config.oauth.is_some() {
            return self.authenticate_oauth(token, presented, &required, now_seconds);
        }
        for configured in &self.static_tokens {
            if equal_secret(token, &configured.secret) {
                let principal = AuthenticatedPrincipal {
                    principal: configured.principal.clone(),
                    client_id: configured.principal.clone(),
                    credential_id: presented,
                    scopes: vec!["hoi4:read".to_owned(), "hoi4:write".to_owned()],
                    expires_at: None,
                };
                require_scopes(&principal.scopes, &required)?;
                return Ok(principal);
            }
        }
        Err(HttpAuthError::invalid("Bearer token verification failed", &required).into())
    }

    fn authenticate_oauth(&self, token: &str, presented: String, required: &[String], now_seconds: f64) -> Result<AuthenticatedPrincipal, AuthFailure> {
        let failed = || AuthFailure::Http(HttpAuthError::invalid("Bearer token verification failed", required));
        let Some(verifier) = &self.verifier else { return Err(failed()) };
        let payload = verifier.verify(token).map_err(|_| failed())?;
        let subject = match payload.get("sub") {
            Some(Value::String(subject)) if !subject.is_empty() => subject.clone(),
            _ => return Err(failed()),
        };
        let expires_at = match payload.get("exp").and_then(Value::as_f64) {
            Some(exp) if exp.is_finite() => exp,
            _ => return Err(failed()),
        };
        if expires_at <= now_seconds {
            return Err(failed());
        }
        if !self.config.principals.iter().any(|entry| entry.principal == subject) {
            return Err(HttpAuthError::new(403, "AUTH_PRINCIPAL_FORBIDDEN", "Bearer-token subject is not an allowlisted principal", None, required).into());
        }
        // A malformed scope claim is a failed verification, not a server error.
        let scopes = token_scopes(&payload).map_err(|_| failed())?;
        require_scopes(&scopes, required)?;
        let client_id = match (payload.get("client_id"), payload.get("azp")) {
            (Some(Value::String(client)), _) => client.clone(),
            (_, Some(Value::String(azp))) => azp.clone(),
            _ => presented.clone(),
        };
        Ok(AuthenticatedPrincipal { principal: subject, client_id, credential_id: presented, scopes, expires_at: Some(expires_at) })
    }
}

fn join_url(base: &str, path: &str) -> Option<String> {
    Url::parse(base).ok()?.join(path).ok().map(String::from)
}

/// The Protected Resource Metadata URL, when OAuth and a public URL are configured.
pub fn protected_resource_metadata_url(config: &HttpConfig) -> Option<String> {
    config.oauth.as_ref()?;
    join_url(config.public_url.as_deref()?, "/.well-known/oauth-protected-resource/mcp")
}

/// The `WWW-Authenticate` value for a refused request.
pub fn bearer_challenge(config: &HttpConfig, bearer_error: Option<BearerError>, required_scopes: &[String]) -> String {
    let mut parameters = Vec::new();
    if let Some(error) = bearer_error {
        parameters.push(format!("error=\"{}\"", error.as_str()));
    }
    let scopes = normalized_scopes(required_scopes).unwrap_or_default();
    if !scopes.is_empty() {
        parameters.push(format!("scope=\"{}\"", scopes.join(" ")));
    }
    if let Some(metadata) = protected_resource_metadata_url(config) {
        parameters.push(format!("resource_metadata=\"{metadata}\""));
    }
    if parameters.is_empty() { "Bearer".to_owned() } else { format!("Bearer {}", parameters.join(", ")) }
}

/// `127.0.0.1`, `localhost` or `::1`, with or without IPv6 brackets.
pub fn is_loopback_host(host: &str) -> bool {
    let normalized = host.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')).unwrap_or(host);
    matches!(normalized, "127.0.0.1" | "localhost" | "::1")
}

fn url_hostname(url: &Url) -> String {
    match url.host() {
        Some(url::Host::Ipv6(address)) => format!("[{address}]"),
        Some(host) => host.to_string(),
        None => String::new(),
    }
}

/// Refuses a deployment that would expose the server without the protections its exposure needs.
pub fn validate_http_deployment(config: &HttpConfig, secrets: SecretLookup<'_>) -> Result<(), ServiceError> {
    default_required_scopes(config)?;
    if config.oauth.is_none() && config.tokens.is_empty() {
        return Err(ServiceError::new("HTTP_AUTH_NOT_CONFIGURED", "Streamable HTTP requires authentication"));
    }
    let public_url = match &config.public_url {
        Some(value) => Some(Url::parse(value).map_err(|_| ServiceError::new("HTTP_PUBLIC_URL_INVALID", "Streamable HTTP publicUrl must be a URL"))?),
        None => None,
    };
    if config.oauth.is_some() && public_url.is_none() {
        return Err(ServiceError::new("HTTP_OAUTH_PUBLIC_URL_REQUIRED", "OAuth Streamable HTTP requires a canonical publicUrl for Protected Resource Metadata"));
    }
    if let Some(url) = &public_url
        && (!matches!(url.scheme(), "http" | "https")
            || !matches!(url.path(), "/" | "/mcp")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some_and(|query| !query.is_empty())
            || url.fragment().is_some_and(|fragment| !fragment.is_empty()))
    {
        return Err(ServiceError::new(
            "HTTP_PUBLIC_URL_INVALID",
            "Streamable HTTP publicUrl must be an HTTP(S) origin or exact /mcp endpoint without credentials, a query, or a fragment",
        ));
    }
    let publicly_exposed = !is_loopback_host(&config.host) || public_url.as_ref().is_some_and(|url| !is_loopback_host(&url_hostname(url)));
    if !publicly_exposed {
        if config.oauth.is_some() && config.principals.is_empty() {
            return Err(ServiceError::new("HTTP_PRINCIPAL_ALLOWLIST_REQUIRED", "OAuth Streamable HTTP requires an explicit principal allowlist"));
        }
        return validate_static_token_secrets(config, secrets);
    }
    let Some(oauth) = &config.oauth else {
        return Err(ServiceError::new("HTTP_PUBLIC_OAUTH_REQUIRED", "Non-loopback HTTP requires OAuth/OIDC JWT verification; static tokens are loopback-only"));
    };
    if public_url.as_ref().map(Url::scheme) != Some("https") {
        return Err(ServiceError::new("HTTP_PUBLIC_HTTPS_REQUIRED", "Non-loopback HTTP requires an HTTPS publicUrl"));
    }
    let authorization_urls = [&oauth.issuer, &oauth.jwks_uri].into_iter().chain(oauth.authorization_servers.iter());
    if authorization_urls.into_iter().any(|url| Url::parse(url).map(|url| url.scheme() != "https").unwrap_or(true)) {
        return Err(ServiceError::new("HTTP_PUBLIC_OAUTH_HTTPS_REQUIRED", "Non-loopback OAuth issuer, JWKS, and authorization server URLs must use HTTPS"));
    }
    if config.allowed_origins.is_empty() {
        return Err(ServiceError::new("HTTP_ORIGIN_ALLOWLIST_REQUIRED", "Non-loopback HTTP requires allowed origins"));
    }
    if config.principals.is_empty() {
        return Err(ServiceError::new("HTTP_PRINCIPAL_ALLOWLIST_REQUIRED", "OAuth Streamable HTTP requires an explicit principal allowlist"));
    }
    Ok(())
}

/// The RFC 9728 metadata document served at the two well-known paths.
pub fn protected_resource_metadata(config: &HttpConfig) -> Result<Value, ServiceError> {
    let not_configured = || ServiceError::new("HTTP_OAUTH_NOT_CONFIGURED", "OAuth metadata is not configured");
    let oauth = config.oauth.as_ref().ok_or_else(not_configured)?;
    let resource = join_url(config.public_url.as_deref().ok_or_else(not_configured)?, "/mcp").ok_or_else(not_configured)?;
    let mut scopes: BTreeSet<Vec<u16>> = oauth.required_scopes.iter().map(|scope| scope.encode_utf16().collect()).collect();
    scopes.insert("hoi4:write".encode_utf16().collect());
    let scopes: Vec<String> = scopes.iter().map(|units| String::from_utf16_lossy(units)).collect();
    Ok(json!({
        "resource": resource,
        "authorization_servers": oauth.authorization_servers,
        "bearer_methods_supported": ["header"],
        "scopes_supported": scopes,
        "resource_name": "HOI4 Agent Tools",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const ENVS: [&str; 5] = ["HOI4_TOKEN_MISSING", "HOI4_TOKEN_SHORT", "HOI4_TOKEN_DIFFERENT_LENGTH", "HOI4_TOKEN_WRONG", "HOI4_TOKEN_MATCH"];

    fn static_config() -> HttpConfig {
        let tokens: Vec<Value> = ENVS
            .iter()
            .enumerate()
            .map(|(index, env)| json!({ "principal": if index == ENVS.len() - 1 { "matched-user".to_owned() } else { format!("user-{index}") }, "tokenEnv": env, "workspaceIds": ["fixture"] }))
            .collect();
        HttpConfig::from_json(&json!({ "tokens": tokens })).unwrap()
    }

    fn lookup(map: &BTreeMap<&str, String>) -> impl Fn(&str) -> Option<String> + '_ {
        move |name| map.get(name).cloned()
    }

    fn scopes(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn http_error(failure: AuthFailure) -> HttpAuthError {
        match failure {
            AuthFailure::Http(error) => error,
            AuthFailure::Service(error) => panic!("expected an HTTP refusal, got {error}"),
        }
    }

    fn oauth_json() -> Value {
        json!({ "issuer": "https://identity.example.test/", "jwksUri": "https://identity.example.test/.well-known/jwks.json", "audience": "hoi4-agent-tools", "authorizationServers": ["https://identity.example.test/"], "requiredScopes": ["hoi4:read"] })
    }

    // Ported from tests/unit/auth-edge-cases.test.ts.
    #[test]
    fn rejects_missing_malformed_empty_oversized_and_invalid_scope_inputs() {
        let auth = Authenticator::new(&HttpConfig::default(), &|_| None, None);
        let read = scopes(&["hoi4:read"]);
        let missing = http_error(auth.authenticate(None, &read, 0.0).unwrap_err());
        assert_eq!((missing.code, missing.bearer_error), ("AUTH_REQUIRED", None));
        assert_eq!(http_error(auth.authenticate(Some("Basic fixture"), &read, 0.0).unwrap_err()).code, "AUTH_REQUIRED");
        let empty = http_error(auth.authenticate(Some("Bearer   "), &read, 0.0).unwrap_err());
        assert_eq!((empty.code, empty.bearer_error), ("AUTH_INVALID", Some(BearerError::InvalidToken)));
        let oversized = format!("Bearer {}", "x".repeat(16_385));
        assert_eq!(http_error(auth.authenticate(Some(&oversized), &read, 0.0).unwrap_err()).code, "AUTH_INVALID");
        match auth.authenticate(Some("Bearer valid-shape"), &scopes(&["invalid scope"]), 0.0).unwrap_err() {
            AuthFailure::Service(error) => assert_eq!(error.code, "HTTP_SCOPE_INVALID"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn skips_unusable_secrets_and_compares_equal_length_tokens() {
        let matching = "a".repeat(32);
        let env = BTreeMap::from([
            ("HOI4_TOKEN_SHORT", "short".to_owned()),
            ("HOI4_TOKEN_DIFFERENT_LENGTH", "b".repeat(33)),
            ("HOI4_TOKEN_WRONG", "b".repeat(32)),
            ("HOI4_TOKEN_MATCH", matching.clone()),
        ]);
        let auth = Authenticator::new(&static_config(), &lookup(&env), None);
        let principal = auth.authenticate(Some(&format!("Bearer {matching}")), &scopes(&["hoi4:read"]), 0.0).unwrap();
        assert_eq!(principal.principal, "matched-user");
        assert_eq!(principal.client_id, "matched-user");
        assert_eq!(principal.credential_id, format!("sha256:{}", hex_sha256(&matching)));
        assert_eq!(principal.scopes, scopes(&["hoi4:read", "hoi4:write"]));
        assert!(!format!("{principal:?}").contains(&matching));
        // A short configured secret never authenticates, even when presented exactly.
        assert!(auth.authenticate(Some("Bearer short"), &scopes(&["hoi4:read"]), 0.0).is_err());
        let both = auth.authenticate(Some(&format!("Bearer {matching}")), &scopes(&["hoi4:read", "hoi4:write"]), 0.0).unwrap();
        assert_eq!(both.scopes, scopes(&["hoi4:read", "hoi4:write"]));
    }

    #[test]
    fn fails_startup_for_missing_short_or_duplicate_secrets() {
        let env = BTreeMap::from([("HOI4_TOKEN_SHORT", "short".to_owned())]);
        assert_eq!(validate_http_deployment(&static_config(), &lookup(&env)).unwrap_err().code, "HTTP_STATIC_TOKEN_INVALID");
        let config = HttpConfig::from_json(&json!({ "tokens": [
            { "principal": "first-user", "tokenEnv": "HOI4_TOKEN_WRONG" },
            { "principal": "second-user", "tokenEnv": "HOI4_TOKEN_MATCH" },
        ] }))
        .unwrap();
        let duplicate = "d".repeat(32);
        let env = BTreeMap::from([("HOI4_TOKEN_WRONG", duplicate.clone()), ("HOI4_TOKEN_MATCH", duplicate)]);
        assert_eq!(validate_http_deployment(&config, &lookup(&env)).unwrap_err().code, "HTTP_STATIC_TOKEN_DUPLICATE");
    }

    #[test]
    fn builds_empty_and_complete_bearer_challenges() {
        let unconfigured = HttpConfig::default();
        assert_eq!(bearer_challenge(&unconfigured, None, &[]), "Bearer");
        assert_eq!(protected_resource_metadata_url(&unconfigured), None);
        assert_eq!(protected_resource_metadata(&unconfigured).unwrap_err().code, "HTTP_OAUTH_NOT_CONFIGURED");
        let missing_public = HttpConfig::from_json(&json!({ "oauth": oauth_json() })).unwrap();
        assert_eq!(protected_resource_metadata_url(&missing_public), None);
        let configured = HttpConfig::from_json(&json!({ "publicUrl": "https://tools.example.test/base", "oauth": oauth_json() })).unwrap();
        let metadata_url = "https://tools.example.test/.well-known/oauth-protected-resource/mcp";
        assert_eq!(protected_resource_metadata_url(&configured).as_deref(), Some(metadata_url));
        assert_eq!(
            bearer_challenge(&configured, Some(BearerError::InsufficientScope), &scopes(&["hoi4:write", "hoi4:write"])),
            format!("Bearer error=\"insufficient_scope\", scope=\"hoi4:write\", resource_metadata=\"{metadata_url}\"")
        );
        let metadata = protected_resource_metadata(&configured).unwrap();
        assert_eq!(metadata["resource"], "https://tools.example.test/mcp");
        assert_eq!(metadata["scopes_supported"], json!(["hoi4:read", "hoi4:write"]));
    }

    struct FixedClaims(Map<String, Value>);

    impl JwtVerifier for FixedClaims {
        fn verify(&self, token: &str) -> Result<Map<String, Value>, String> {
            if token == "signed" { Ok(self.0.clone()) } else { Err("bad signature".to_owned()) }
        }
    }

    fn oauth_auth(claims: Value) -> Authenticator {
        let config = HttpConfig::from_json(&json!({ "publicUrl": "https://tools.example.test", "oauth": oauth_json(), "principals": [{ "principal": "fixture-user" }] })).unwrap();
        Authenticator::new(&config, &|_| None, Some(Box::new(FixedClaims(claims.as_object().unwrap().clone()))))
    }

    // Ported from tests/unit/oauth-auth.test.ts (the claim rules after a verified signature).
    #[test]
    fn oauth_applies_subject_expiry_allowlist_scope_and_client_rules() {
        let read = scopes(&["hoi4:read"]);
        let good = json!({ "sub": "fixture-user", "exp": 2000.0, "scope": "hoi4:read", "client_id": "fixture-client" });
        let principal = oauth_auth(good.clone()).authenticate(Some("Bearer signed"), &read, 1000.0).unwrap();
        assert_eq!((principal.principal.as_str(), principal.client_id.as_str()), ("fixture-user", "fixture-client"));
        assert_eq!(principal.expires_at, Some(2000.0));
        assert_eq!(http_error(oauth_auth(good.clone()).authenticate(Some("Bearer forged"), &read, 1000.0).unwrap_err()).code, "AUTH_INVALID");
        assert_eq!(http_error(oauth_auth(good.clone()).authenticate(Some("Bearer signed"), &read, 2000.0).unwrap_err()).code, "AUTH_INVALID");
        let no_exp = json!({ "sub": "fixture-user", "scope": "hoi4:read" });
        assert_eq!(http_error(oauth_auth(no_exp).authenticate(Some("Bearer signed"), &read, 0.0).unwrap_err()).code, "AUTH_INVALID");
        let no_sub = json!({ "sub": "", "exp": 2000.0, "scope": "hoi4:read" });
        assert_eq!(http_error(oauth_auth(no_sub).authenticate(Some("Bearer signed"), &read, 0.0).unwrap_err()).code, "AUTH_INVALID");
        let stranger = json!({ "sub": "stranger", "exp": 2000.0, "scope": "hoi4:read" });
        assert_eq!(http_error(oauth_auth(stranger).authenticate(Some("Bearer signed"), &read, 0.0).unwrap_err()).code, "AUTH_PRINCIPAL_FORBIDDEN");
        let write = http_error(oauth_auth(good).authenticate(Some("Bearer signed"), &scopes(&["hoi4:read", "hoi4:write"]), 0.0).unwrap_err());
        assert_eq!((write.status, write.code), (403, "AUTH_SCOPE_INSUFFICIENT"));
        let scp = json!({ "sub": "fixture-user", "exp": 2000.0, "scp": ["hoi4:read"], "azp": "azp-client" });
        let principal = oauth_auth(scp).authenticate(Some("Bearer signed"), &read, 0.0).unwrap();
        assert_eq!(principal.client_id, "azp-client");
        let bare = json!({ "sub": "fixture-user", "exp": 2000.0, "scope": "hoi4:read" });
        let principal = oauth_auth(bare).authenticate(Some("Bearer signed"), &read, 0.0).unwrap();
        assert_eq!(principal.client_id, credential_id("signed"));
    }

    #[test]
    fn oauth_without_a_verifier_refuses_every_token() {
        let config = HttpConfig::from_json(&json!({ "publicUrl": "https://tools.example.test", "oauth": oauth_json(), "principals": [{ "principal": "fixture-user" }] })).unwrap();
        let auth = Authenticator::new(&config, &|_| None, None);
        assert_eq!(http_error(auth.authenticate(Some("Bearer signed"), &scopes(&["hoi4:read"]), 0.0).unwrap_err()).code, "AUTH_INVALID");
    }

    // Ported from tests/unit/http-deployment.test.ts.
    #[test]
    fn deployment_rules_refuse_unsafe_exposure() {
        let env = BTreeMap::from([("TOKEN_A", "a".repeat(32))]);
        let secrets = lookup(&env);
        let code = |value: Value| validate_http_deployment(&HttpConfig::from_json(&value).unwrap(), &secrets).map_err(|error| error.code);
        let token = json!([{ "principal": "u", "tokenEnv": "TOKEN_A" }]);
        assert_eq!(code(json!({})), Err("HTTP_AUTH_NOT_CONFIGURED"));
        assert_eq!(code(json!({ "tokens": token })), Ok(()));
        assert_eq!(code(json!({ "tokens": token, "host": "0.0.0.0" })), Err("HTTP_PUBLIC_OAUTH_REQUIRED"));
        assert_eq!(code(json!({ "tokens": token, "publicUrl": "https://tools.example.test" })), Err("HTTP_PUBLIC_OAUTH_REQUIRED"));
        assert_eq!(code(json!({ "tokens": token, "publicUrl": "http://127.0.0.1:3210/other" })), Err("HTTP_PUBLIC_URL_INVALID"));
        assert_eq!(code(json!({ "tokens": token, "publicUrl": "http://u:p@127.0.0.1/" })), Err("HTTP_PUBLIC_URL_INVALID"));
        assert_eq!(code(json!({ "tokens": token, "publicUrl": "http://127.0.0.1/mcp?x=1" })), Err("HTTP_PUBLIC_URL_INVALID"));
        assert_eq!(code(json!({ "tokens": token, "publicUrl": "http://[::1]:3210/mcp" })), Ok(()));
        assert_eq!(code(json!({ "oauth": oauth_json() })), Err("HTTP_OAUTH_PUBLIC_URL_REQUIRED"));
        assert_eq!(code(json!({ "oauth": oauth_json(), "publicUrl": "http://localhost:3210" })), Err("HTTP_PRINCIPAL_ALLOWLIST_REQUIRED"));
        let principals = json!([{ "principal": "p" }]);
        assert_eq!(code(json!({ "oauth": oauth_json(), "publicUrl": "http://tools.example.test", "principals": principals })), Err("HTTP_PUBLIC_HTTPS_REQUIRED"));
        let mut http_issuer = oauth_json();
        http_issuer["jwksUri"] = json!("http://identity.example.test/jwks");
        assert_eq!(code(json!({ "oauth": http_issuer, "publicUrl": "https://tools.example.test", "principals": principals })), Err("HTTP_PUBLIC_OAUTH_HTTPS_REQUIRED"));
        assert_eq!(code(json!({ "oauth": oauth_json(), "publicUrl": "https://tools.example.test", "principals": principals })), Err("HTTP_ORIGIN_ALLOWLIST_REQUIRED"));
        assert_eq!(code(json!({ "oauth": oauth_json(), "publicUrl": "https://tools.example.test", "allowedOrigins": ["https://client.example.test"] })), Err("HTTP_PRINCIPAL_ALLOWLIST_REQUIRED"));
        assert_eq!(code(json!({ "oauth": oauth_json(), "publicUrl": "https://tools.example.test", "allowedOrigins": ["https://client.example.test"], "principals": principals })), Ok(()));
    }

    #[test]
    fn loopback_hosts_and_constant_time_compare() {
        for host in ["127.0.0.1", "localhost", "::1", "[::1]"] {
            assert!(is_loopback_host(host), "{host}");
        }
        for host in ["0.0.0.0", "127.0.0.2", "example.test", "[::2]"] {
            assert!(!is_loopback_host(host), "{host}");
        }
        assert!(equal_secret("abc", "abc"));
        assert!(!equal_secret("abc", "abd"));
        assert!(!equal_secret("abc", "abcd"));
    }
}
