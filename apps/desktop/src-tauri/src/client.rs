//! Client side of the agent protocol: builds signed requests to a host.
//!
//! The URL is assembled here rather than by `reqwest`'s query builder, because
//! the signature covers the exact request target the host will see. Query
//! values are percent-encoded conservatively so URL parsing cannot rewrite the
//! string out from under the signature.

use std::time::Duration;

use crate::auth;

/// Percent-encodes everything outside the unreserved set, so the encoded form
/// survives URL parsing unchanged.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

pub fn path_with_query(path: &str, query: &[(&str, String)]) -> String {
    if query.is_empty() {
        return path.to_string();
    }
    let encoded: Vec<String> = query
        .iter()
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect();
    format!("{path}?{}", encoded.join("&"))
}

/// One request to a host agent, assembled before it is signed.
pub struct AgentRequest<'a> {
    address: &'a str,
    port: u16,
    method: reqwest::Method,
    path: &'a str,
    query: Vec<(&'a str, String)>,
    body: Vec<u8>,
    timeout: Option<Duration>,
}

impl<'a> AgentRequest<'a> {
    pub fn new(method: reqwest::Method, address: &'a str, port: u16, path: &'a str) -> Self {
        Self {
            address,
            port,
            method,
            path,
            query: vec![],
            body: vec![],
            timeout: None,
        }
    }

    pub fn get(address: &'a str, port: u16, path: &'a str) -> Self {
        Self::new(reqwest::Method::GET, address, port, path)
    }

    pub fn post(address: &'a str, port: u16, path: &'a str) -> Self {
        Self::new(reqwest::Method::POST, address, port, path)
    }

    pub fn query(mut self, query: Vec<(&'a str, String)>) -> Self {
        self.query = query;
        self
    }

    pub fn body(mut self, body: Vec<u8>) -> Self {
        self.body = body;
        self
    }

    pub fn json(self, value: &serde_json::Value) -> Result<Self, String> {
        let body = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        Ok(self.body(body))
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn target(&self) -> String {
        path_with_query(self.path, &self.query)
    }

    /// Signs and sends the request.
    pub async fn send(
        self,
        http: &reqwest::Client,
        code: &str,
    ) -> Result<reqwest::Response, String> {
        let target = self.target();
        let ts = auth::unix_now();
        let nonce = auth::new_nonce();
        let signature = auth::signature(
            code,
            self.method.as_str(),
            &target,
            ts,
            &nonce,
            &auth::body_digest(&self.body),
        );

        let address = self.address;
        let mut request = http
            .request(
                self.method.clone(),
                format!("http://{address}:{}{target}", self.port),
            )
            .header(auth::TS_HEADER, ts.to_string())
            .header(auth::NONCE_HEADER, nonce)
            .header(auth::AUTH_HEADER, signature);
        if !self.body.is_empty() {
            request = request
                .header("content-type", "application/json")
                .body(self.body);
        }
        if let Some(timeout) = self.timeout {
            request = request.timeout(timeout);
        }
        request
            .send()
            .await
            .map_err(|e| format!("can't reach {address}: {e}"))
    }

    /// Sends, and fails on any non-success status, so a caller cannot mistake
    /// a refusal for success.
    pub async fn send_ok(
        self,
        http: &reqwest::Client,
        code: &str,
    ) -> Result<reqwest::Response, String> {
        let resp = self.send(http, code).await?;
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        Err(match status.as_u16() {
            401 => "the host rejected the access code for this computer".to_string(),
            403 => "the host refused access to that location".to_string(),
            429 => "too many failed attempts — wait a minute and try again".to_string(),
            other => format!("the host returned HTTP {other}"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_encoding_is_signature_safe() {
        let target = path_with_query("/files/stat", &[("path", "C:/Users/a b/x&y.bin".into())]);
        assert_eq!(
            target,
            "/files/stat?path=C%3A%2FUsers%2Fa%20b%2Fx%26y.bin",
            "separators and spaces must be encoded so the target cannot be re-parsed"
        );
    }

    #[test]
    fn empty_query_leaves_the_path_alone() {
        assert_eq!(path_with_query("/metrics", &[]), "/metrics");
    }

    #[test]
    fn encoded_target_survives_url_parsing() {
        // If parsing rewrote the target, the host would verify a different
        // string than the one that was signed.
        let target = path_with_query("/files/download", &[("path", "C:/x/y.bin".into())]);
        let url = reqwest::Url::parse(&format!("http://host:47801{target}")).unwrap();
        let parsed = match url.query() {
            Some(q) => format!("{}?{}", url.path(), q),
            None => url.path().to_string(),
        };
        assert_eq!(parsed, target);
    }

    #[test]
    fn builder_composes_the_expected_target() {
        let request = AgentRequest::get("10.0.0.2", 47801, "/files/list")
            .query(vec![("path", "C:/Users/me".into())]);
        assert_eq!(request.target(), "/files/list?path=C%3A%2FUsers%2Fme");
    }
}
