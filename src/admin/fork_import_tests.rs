use super::*;

#[test]
fn validates_fields_and_forces_disabled_creation() {
    let req = parse_account(br#"[{"refreshToken":" fake ","email":"test@example.invalid","disabled":false,"priority":9,"proxyUrl":"https://example.invalid"}]"#).unwrap();
    assert_eq!(req.refresh_token, "fake");
    assert_eq!(req.auth_method, "social");
    assert!(req.disabled);
    assert_eq!(req.priority, 0);
    assert!(req.proxy_url.is_none());
    for value in [
        "null",
        "[]",
        "[{},{}]",
        r#"{"refreshToken":"t"}"#,
        r#"{"refreshToken":"t","email":"invalid"}"#,
        r#"{"refreshToken":123,"email":"a@b"}"#,
        r#"{"refreshToken":"t","email":"a@b","authMethod":"idc"}"#,
        r#"{"refreshToken":"t","email":"a@b","clientId":"id"}"#,
    ] {
        assert!(parse_account(value.as_bytes()).is_none(), "{value}");
    }
    assert!(parse_account(br#"{"refreshToken":"t","email":"a@b","clientId":"id","clientSecret":"secret","authMethod":"IdC"}"#).is_some());
}

#[tokio::test]
async fn preserves_import_phase_and_never_enables_failed_verification() {
    use std::cell::RefCell;
    for (fail, expected) in [
        (0, "failed"),
        (1, "unverified"),
        (2, "activationUnknown"),
        (3, "success"),
    ] {
        let calls = RefCell::new(vec![]);
        let result = import_steps(
            async {
                calls.borrow_mut().push("add");
                if fail == 0 { Err(()) } else { Ok(7) }
            },
            |_| async {
                calls.borrow_mut().push("verify");
                if fail == 1 { Err(()) } else { Ok(()) }
            },
            |_| async {
                calls.borrow_mut().push("enable");
                if fail == 2 { Err(()) } else { Ok(()) }
            },
        )
        .await;
        assert_eq!(result.status, expected);
        assert_eq!(calls.borrow().len(), (fail + 1).min(3));
        assert_eq!(result.credential_id, if fail == 0 { None } else { Some(7) });
    }
}

#[test]
fn expires_pending_and_completed_grants_but_keeps_running_work_queryable() {
    let mut sessions = HashMap::new();
    let mut headers = HeaderMap::new();
    headers.insert(TOKEN_HEADER, "synthetic".parse().unwrap());
    for status in ["awaiting", "running", "success"] {
        sessions.insert(
            "synthetic".into(),
            Session {
                expires: Instant::now() - Duration::from_secs(1),
                result: ImportResult::new(status, None),
            },
        );
        assert_eq!(
            session(&mut sessions, &headers).is_some(),
            status == "running"
        );
    }
    assert!(session(&mut sessions, &HeaderMap::new()).is_none());
}

#[tokio::test]
async fn routes_enforce_auth_limits_and_idempotent_upload_without_real_credentials() {
    use crate::{
        kiro::{model::credentials::KiroCredentials, token_manager::MultiTokenManager},
        model::config::Config,
    };
    let credential = KiroCredentials {
        id: Some(1),
        refresh_token: Some("synthetic-existing-token".into()),
        disabled: true,
        ..Default::default()
    };
    let manager =
        MultiTokenManager::new(Config::default(), vec![credential], None, None, false).unwrap();
    let admin = AdminState::new(
        Arc::new(parking_lot::RwLock::new("test-admin-key".into())),
        AdminService::new(Arc::new(manager)),
    );
    let service = admin.service.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, crate::admin::create_admin_router(admin))
            .await
            .unwrap();
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("{base}/fork/import-sessions");
    assert_eq!(
        client.post(&url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(&url)
            .header("x-api-key", "wrong")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = client
        .post(&url)
        .header("x-api-key", "test-admin-key")
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let grant: serde_json::Value = response.json().await.unwrap();
    let token = grant["token"].as_str().unwrap();
    assert_eq!(token.len(), 64);
    assert_eq!(grant["expiresIn"], 600);
    let url = format!("{base}/fork/import-session");
    assert_eq!(
        client
            .post(&url)
            .body("secret")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = client
        .post(&url)
        .header(TOKEN_HEADER, token)
        .body("secret")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(!response.text().await.unwrap().contains("secret"));
    let response: serde_json::Value = client
        .get(&url)
        .header(TOKEN_HEADER, token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["status"], "awaiting");
    assert_eq!(
        client
            .post(&url)
            .header(TOKEN_HEADER, token)
            .body("x".repeat(2 * 1024 * 1024 + 1))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let request = client.post(&url).header(TOKEN_HEADER, token).json(&serde_json::json!({"refreshToken":"synthetic-existing-token", "email":"test@example.invalid"}));
    let (first, second) = tokio::join!(request.try_clone().unwrap().send(), request.send());
    for response in [first.unwrap(), second.unwrap()] {
        assert!(response.status().is_success());
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let result: serde_json::Value = client
                .get(&url)
                .header(TOKEN_HEADER, token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if result["status"] != "running" {
                assert_eq!(result["status"], "duplicate");
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // A consumed grant ignores a different body instead of creating another account.
    let result: serde_json::Value = client
        .post(&url)
        .header(TOKEN_HEADER, token)
        .body("different-body")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(result["status"], "duplicate");
    assert_eq!(service.get_all_credentials().credentials.len(), 1);
    for platform in ["macos", "windows"] {
        let response = client
            .get(format!("{base}/fork/scripts/{platform}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(response.text().await.unwrap().contains("KIRO_EXPORT_ROOT"));
    }
    server.abort();
}
