//! Fork-only runtime configuration. Keep deployment URLs out of source and static assets.

use axum::{Json, http::header, response::IntoResponse};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportConfig {
    script_url: Option<String>,
}

fn configured_url(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.to_string())
}

/// Only mount inside the existing admin-authenticated router. No URL logging or caching.
pub async fn get_import_config() -> impl IntoResponse {
    let value = std::env::var("KIRO_IMPORT_SCRIPT_URL").ok();
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(ImportConfig {
            script_url: configured_url(value.as_deref()),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_runtime_http_and_https_urls() {
        for url in [
            "https://example.invalid/export.sh",
            "http://localhost:8080/export.sh",
        ] {
            assert_eq!(configured_url(Some(url)).as_deref(), Some(url));
        }
    }

    #[test]
    fn missing_or_invalid_configuration_has_no_fallback_url() {
        assert_eq!(configured_url(None), None);
        for value in [
            "",
            "  ",
            "file:///tmp/export.sh",
            "javascript:alert(1)",
            "https://u:p@example.invalid/a",
            "https://example.invalid/a\nb",
        ] {
            assert_eq!(configured_url(Some(value)), None);
        }
    }

    #[tokio::test]
    async fn response_cannot_be_cached() {
        let response = get_import_config().await.into_response();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn runtime_config_route_requires_admin_authentication() {
        use crate::admin::{AdminService, AdminState, create_admin_router};
        use crate::kiro::token_manager::MultiTokenManager;
        use crate::model::config::Config;
        use parking_lot::RwLock;
        use std::sync::Arc;

        let manager = MultiTokenManager::new(Config::default(), vec![], None, None, false).unwrap();
        let state = AdminState::new(
            Arc::new(RwLock::new("test-only-admin-key".to_owned())),
            AdminService::new(Arc::new(manager)),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/fork/import-config",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, create_admin_router(state))
                .await
                .unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for key in [None, Some("wrong-key")] {
            let mut request = client.get(&url);
            if let Some(key) = key {
                request = request.header("x-api-key", key);
            }
            let response = request.send().await.unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
            assert!(!response.text().await.unwrap().contains("scriptUrl"));
        }
        let response = client
            .get(&url)
            .header("x-api-key", "test-only-admin-key")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        server.abort();
    }
}
