//! Bundled scripts and short-lived, single-use local import grants.
use super::{
    middleware::{AdminState, admin_auth_middleware},
    service::AdminService,
    types::AddCredentialRequest,
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_secs(600);
const TOKEN_HEADER: &str = "x-kiro-import-token";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_id: Option<u64>,
}
impl ImportResult {
    fn new(status: &'static str, credential_id: Option<u64>) -> Self {
        Self {
            status,
            credential_id,
        }
    }
}
struct Session {
    expires: Instant,
    result: ImportResult,
}
#[derive(Clone)]
struct ImportState {
    service: Arc<AdminService>,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    // Serialize fork imports so duplicate checks also cover simultaneous commands.
    importing: Arc<tokio::sync::Mutex<()>>,
}

pub fn router(admin: AdminState) -> Router {
    let state = ImportState {
        service: admin.service.clone(),
        sessions: Default::default(),
        importing: Default::default(),
    };
    Router::new()
        .route("/fork/import-sessions", post(create_session))
        .layer(middleware::from_fn_with_state(admin, admin_auth_middleware))
        .route("/fork/import-session", get(session_status).post(upload))
        .route(
            "/fork/scripts/macos",
            get(|| async { script(include_str!("../../scripts/fork/get-kiro-info.sh")) }),
        )
        .route(
            "/fork/scripts/windows",
            get(|| async { script(include_str!("../../scripts/fork/get-kiro-info.ps1")) }),
        )
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(state)
}
fn script(source: &'static str) -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        source,
    )
}
fn reply(status: StatusCode, result: impl Serialize) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(result)).into_response()
}
fn error(status: StatusCode) -> Response {
    // Never reflect parser errors, account data or upstream response bodies.
    reply(status, serde_json::json!({"status": "unavailable"}))
}
async fn create_session(State(state): State<ImportState>) -> Response {
    let mut sessions = state.sessions.lock();
    sessions.retain(|_, s| s.expires > Instant::now() || s.result.status == "running");
    if sessions.len() >= 64 {
        return error(StatusCode::TOO_MANY_REQUESTS);
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    sessions.insert(
        token.clone(),
        Session {
            expires: Instant::now() + TTL,
            result: ImportResult::new("awaiting", None),
        },
    );
    reply(
        StatusCode::OK,
        serde_json::json!({"token": token, "expiresIn": TTL.as_secs()}),
    )
}
fn session<'a>(
    sessions: &'a mut HashMap<String, Session>,
    headers: &HeaderMap,
) -> Option<(&'a mut Session, String)> {
    let token = headers.get(TOKEN_HEADER)?.to_str().ok()?;
    let entry = sessions.get_mut(token)?;
    if entry.expires <= Instant::now() && entry.result.status != "running" {
        return None;
    }
    Some((entry, token.to_owned()))
}
async fn session_status(State(state): State<ImportState>, headers: HeaderMap) -> Response {
    match session(&mut state.sessions.lock(), &headers) {
        Some((entry, _)) => reply(StatusCode::OK, entry.result.clone()),
        None => error(StatusCode::UNAUTHORIZED),
    }
}
fn parse_account(bytes: &[u8]) -> Option<AddCredentialRequest> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let value = match &value {
        serde_json::Value::Array(items) if items.len() == 1 => &items[0],
        serde_json::Value::Object(_) => &value,
        _ => return None,
    };
    let input = value.as_object()?;
    let mut account = serde_json::Map::new();
    for field in [
        "refreshToken",
        "email",
        "clientId",
        "clientSecret",
        "profileArn",
        "authRegion",
        "apiRegion",
        "machineId",
        "authMethod",
        "provider",
    ] {
        if let Some(value) = input.get(field).filter(|value| !value.is_null()) {
            let value = value.as_str()?.trim();
            if !value.is_empty() {
                account.insert(field.into(), value.into());
            }
        }
    }
    account.get("refreshToken")?;
    let email = account.get("email")?.as_str()?;
    let (local, domain) = email.split_once('@')?;
    if local.is_empty()
        || domain.is_empty()
        || domain.contains('@')
        || email.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return None;
    }
    let client = account.contains_key("clientId");
    if client != account.contains_key("clientSecret") {
        return None;
    }
    let method = if client { "idc" } else { "social" };
    if account
        .get("authMethod")
        .is_some_and(|v| !v.as_str().unwrap_or("").eq_ignore_ascii_case(method))
    {
        return None;
    }
    account.insert("authMethod".into(), method.into());
    if let Some(provider) = account.remove("provider") {
        let canonical = match provider.as_str()?.to_ascii_lowercase().as_str() {
            "google" => Some("Google"),
            "github" => Some("GitHub"),
            "enterprise" => Some("Enterprise"),
            _ => None,
        };
        if let Some(provider) = canonical {
            account.insert("provider".into(), provider.into());
        }
    }
    account.insert("disabled".into(), true.into());
    account.insert("priority".into(), 0.into());
    serde_json::from_value(account.into()).ok()
}
async fn upload(State(state): State<ImportState>, headers: HeaderMap, body: Bytes) -> Response {
    let token = {
        let mut sessions = state.sessions.lock();
        let Some((entry, token)) = session(&mut sessions, &headers) else {
            return error(StatusCode::UNAUTHORIZED);
        };
        if entry.result.status != "awaiting" {
            return reply(StatusCode::OK, entry.result.clone());
        }
        token
    };
    let Some(account) = parse_account(&body) else {
        return error(StatusCode::BAD_REQUEST);
    };
    {
        let mut sessions = state.sessions.lock();
        let Some((entry, _)) = session(&mut sessions, &headers) else {
            return error(StatusCode::UNAUTHORIZED);
        };
        if entry.result.status != "awaiting" {
            return reply(StatusCode::OK, entry.result.clone());
        }
        entry.result = ImportResult::new("running", None);
    }
    // Accepted work survives disconnection; retries only return its existing result.
    tokio::spawn(async move {
        let _guard = state.importing.lock().await;
        let service = &state.service;
        let hash = hex::encode(Sha256::digest(account.refresh_token.as_bytes()));
        let duplicate = service
            .get_all_credentials()
            .credentials
            .iter()
            .any(|c| c.refresh_token_hash.as_deref() == Some(hash.as_str()));
        let result = if duplicate {
            ImportResult::new("duplicate", None)
        } else {
            import_steps(
                async {
                    service
                        .add_credential(account)
                        .await
                        .map(|r| r.credential_id)
                },
                |id| service.get_balance(id),
                |id| service.set_disabled(id, false),
            )
            .await
        };
        if let Some(entry) = state.sessions.lock().get_mut(&token) {
            entry.result = result;
            entry.expires = Instant::now() + TTL;
        }
    });
    reply(StatusCode::ACCEPTED, ImportResult::new("running", None))
}
async fn import_steps<E, V, A, T>(
    add: impl Future<Output = Result<u64, E>>,
    verify: impl FnOnce(u64) -> V,
    enable: impl FnOnce(u64) -> A,
) -> ImportResult
where
    V: Future<Output = Result<T, E>>,
    A: Future<Output = Result<(), E>>,
{
    let Ok(id) = add.await else {
        return ImportResult::new("failed", None);
    };
    if verify(id).await.is_err() {
        return ImportResult::new("unverified", Some(id));
    }
    if enable(id).await.is_err() {
        return ImportResult::new("activationUnknown", Some(id));
    }
    ImportResult::new("success", Some(id))
}

#[cfg(test)]
#[path = "fork_import_tests.rs"]
mod tests;
