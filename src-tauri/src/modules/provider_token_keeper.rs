use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::Notify;

use crate::modules::{config, logger, platform_adapter, platform_package};

const TOKEN_KEEPER_TICK_SECONDS: u64 = 60;
const TOKEN_KEEPER_STARTUP_DELAY_SECONDS: u64 = 5 * 60;
const TOKEN_KEEPER_MAX_REFRESHES_PER_PLATFORM: usize = 3;
const TOKEN_KEEPER_IDLE_SCAN_SECONDS: i64 = 10 * 60;
const TOKEN_KEEPER_ACTIVE_SCAN_SECONDS: i64 = 60;
const TOKEN_REFRESH_LEAD_SECONDS: i64 = 15 * 60;
const TOKEN_REFRESH_LEAD_MILLISECONDS: i64 = TOKEN_REFRESH_LEAD_SECONDS * 1000;
const REFRESH_FAILURE_BACKOFF_SECONDS: i64 = 15 * 60;
const TRAE_STRICT_CHECK_INTERVAL_SECONDS: i64 = 10 * 60;

static TOKEN_KEEPER_STARTED: AtomicBool = AtomicBool::new(false);
static TOKEN_KEEPER_CONFIG_CHANGED: LazyLock<Notify> = LazyLock::new(Notify::new);
static NEXT_ALLOWED_ATTEMPT_AT: LazyLock<Mutex<HashMap<String, i64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_PLATFORM_SCAN_AT: LazyLock<Mutex<HashMap<&'static str, i64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_TRAE_STRICT_CHECK_AT: LazyLock<Mutex<HashMap<String, i64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraeCheckLoginVerdict {
    is_valid: bool,
    error_code: Option<String>,
    is_login: Option<bool>,
}

pub fn ensure_started(app_handle: AppHandle) {
    if TOKEN_KEEPER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    logger::log_info("[TokenKeeper] 后端 OAuth token 保活已启动");
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(TOKEN_KEEPER_STARTUP_DELAY_SECONDS)) => {}
            _ = TOKEN_KEEPER_CONFIG_CHANGED.notified() => {}
        }

        loop {
            run_refresh_cycle(&app_handle).await;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(TOKEN_KEEPER_TICK_SECONDS)) => {}
                _ = TOKEN_KEEPER_CONFIG_CHANGED.notified() => {}
            }
        }
    });
}

pub fn notify_config_changed(app_handle: AppHandle, enabled: bool) {
    ensure_started(app_handle);
    reset_platform_scan_schedule();
    logger::log_info(&format!(
        "[TokenKeeper] 后台 OAuth token 保活设置已{}，已同步运行时状态",
        if enabled { "启用" } else { "停用" }
    ));
    TOKEN_KEEPER_CONFIG_CHANGED.notify_one();
}

async fn run_refresh_cycle(app_handle: &AppHandle) {
    if !config::get_user_config().token_keeper_enabled {
        return;
    }

    let mut refreshed_any = false;

    refreshed_any |= refresh_platform_if_due("codex", refresh_due_codex_accounts).await;
    refreshed_any |= refresh_platform_if_due("cursor", refresh_due_cursor_accounts).await;
    refreshed_any |= refresh_platform_if_due("gemini", refresh_due_gemini_accounts).await;
    refreshed_any |=
        refresh_platform_if_due("github_copilot", refresh_due_github_copilot_accounts).await;
    refreshed_any |= refresh_platform_if_due("windsurf", refresh_due_windsurf_accounts).await;
    refreshed_any |= refresh_platform_if_due("kiro", refresh_due_kiro_accounts).await;
    refreshed_any |= refresh_platform_if_due("codebuddy", refresh_due_codebuddy_accounts).await;
    refreshed_any |=
        refresh_platform_if_due("codebuddy_cn", refresh_due_codebuddy_cn_accounts).await;
    refreshed_any |= refresh_platform_if_due("workbuddy", refresh_due_workbuddy_accounts).await;
    refreshed_any |= refresh_platform_if_due("trae", refresh_due_trae_accounts).await;

    if refreshed_any {
        let _ = crate::modules::tray::update_tray_menu(app_handle);
    }
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

fn now_ts_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn allow_platform_scan(platform: &'static str) -> bool {
    let now = now_ts();
    let Ok(state) = NEXT_PLATFORM_SCAN_AT.lock() else {
        return true;
    };
    state.get(platform).map(|next| *next <= now).unwrap_or(true)
}

fn mark_platform_scan(platform: &'static str, refreshed_any: bool) {
    let next_delay = if refreshed_any {
        TOKEN_KEEPER_ACTIVE_SCAN_SECONDS
    } else {
        TOKEN_KEEPER_IDLE_SCAN_SECONDS
    };
    if let Ok(mut state) = NEXT_PLATFORM_SCAN_AT.lock() {
        state.insert(platform, now_ts() + next_delay);
    }
}

fn reset_platform_scan_schedule() {
    if let Ok(mut state) = NEXT_PLATFORM_SCAN_AT.lock() {
        state.clear();
    }
}

async fn refresh_platform_if_due<F, Fut>(platform: &'static str, refresh: F) -> bool
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = bool>,
{
    if !allow_platform_scan(platform) {
        return false;
    }

    let refreshed_any = refresh().await;
    mark_platform_scan(platform, refreshed_any);
    refreshed_any
}

fn decode_jwt_exp(token: &str) -> Option<i64> {
    let payload_base64 = token.split('.').nth(1)?;
    let payload_bytes = URL_SAFE_NO_PAD.decode(payload_base64).ok()?;
    let payload: Value = serde_json::from_slice(&payload_bytes).ok()?;
    payload.get("exp").and_then(Value::as_i64)
}

fn jwt_token_expires_soon(token: &str, skew_seconds: i64) -> bool {
    decode_jwt_exp(token)
        .map(|exp| exp <= now_ts() + skew_seconds)
        .unwrap_or(true)
}

fn expires_at_seconds_due(expires_at: Option<i64>) -> bool {
    expires_at
        .map(|value| value <= now_ts() + TOKEN_REFRESH_LEAD_SECONDS)
        .unwrap_or(true)
}

fn expires_at_milliseconds_due(expires_at: Option<i64>) -> bool {
    expires_at
        .map(|value| value <= now_ts_ms() + TOKEN_REFRESH_LEAD_MILLISECONDS)
        .unwrap_or(true)
}

fn allow_attempt(key: &str) -> bool {
    let now = now_ts();
    let Ok(state) = NEXT_ALLOWED_ATTEMPT_AT.lock() else {
        return true;
    };
    state.get(key).map(|next| *next <= now).unwrap_or(true)
}

fn clear_attempt_backoff(key: &str) {
    if let Ok(mut state) = NEXT_ALLOWED_ATTEMPT_AT.lock() {
        state.remove(key);
    }
}

fn mark_attempt_failure(key: &str) {
    if let Ok(mut state) = NEXT_ALLOWED_ATTEMPT_AT.lock() {
        state.insert(key.to_string(), now_ts() + REFRESH_FAILURE_BACKOFF_SECONDS);
    }
}

async fn call_trae_adapter<T>(
    method: &'static str,
    payload: Value,
    timeout: Duration,
) -> Result<T, String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        platform_adapter::call_trae_with_timeout::<T>(method, payload, timeout)
    })
    .await
    .map_err(|error| format!("Trae adapter 任务失败: {}", error))?
}

fn should_run_trae_strict_check(account_id: &str) -> bool {
    let now = now_ts();
    let Ok(state) = NEXT_TRAE_STRICT_CHECK_AT.lock() else {
        return true;
    };
    state
        .get(account_id)
        .map(|next| *next <= now)
        .unwrap_or(true)
}

fn mark_trae_strict_check_done(account_id: &str) {
    if let Ok(mut state) = NEXT_TRAE_STRICT_CHECK_AT.lock() {
        state.insert(
            account_id.to_string(),
            now_ts() + TRAE_STRICT_CHECK_INTERVAL_SECONDS,
        );
    }
}

async fn refresh_due_codex_accounts() -> bool {
    if !platform_package::is_platform_package_runtime_ready("codex") {
        return false;
    }

    match platform_adapter::call_codex_with_timeout::<i32>(
        "accounts.keepaliveDue",
        serde_json::json!({}),
        Duration::from_secs(180),
    ) {
        Ok(count) => count > 0,
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][Codex] adapter 保活失败，跳过本轮: {}",
                err
            ));
            false
        }
    }
}

async fn refresh_due_cursor_accounts() -> bool {
    if !platform_package::is_platform_package_installed("cursor") {
        return false;
    }

    let accounts: Vec<crate::models::cursor::CursorAccount> =
        match platform_adapter::call_cursor_with_timeout(
            "accounts.list",
            serde_json::json!({}),
            Duration::from_secs(20),
        ) {
            Ok(accounts) => accounts,
            Err(err) => {
                logger::log_warn(&format!(
                    "[TokenKeeper][Cursor] 读取账号列表失败，跳过本轮保活: {}",
                    err
                ));
                return false;
            }
        };

    let current_id: Option<String> = platform_adapter::call_cursor_with_timeout(
        "accounts.current",
        serde_json::json!({}),
        Duration::from_secs(20),
    )
    .unwrap_or(None);
    let mut refreshed_any = false;
    let mut refresh_attempts = 0usize;

    for account in accounts {
        if !jwt_token_expires_soon(&account.access_token, TOKEN_REFRESH_LEAD_SECONDS) {
            continue;
        }

        let key = format!("cursor:{}", account.id);
        if !allow_attempt(&key) {
            continue;
        }
        if refresh_attempts >= TOKEN_KEEPER_MAX_REFRESHES_PER_PLATFORM {
            logger::log_info("[TokenKeeper][Cursor] 本轮达到保活处理上限，剩余账号延后处理");
            break;
        }
        refresh_attempts += 1;

        let account_id = account.id.clone();
        let refresh_result = tauri::async_runtime::spawn_blocking(move || {
            platform_adapter::call_cursor_with_timeout::<crate::models::cursor::CursorAccount>(
                "accounts.refresh",
                serde_json::json!({ "accountId": account_id }),
                Duration::from_secs(180),
            )
        })
        .await
        .map_err(|error| format!("Cursor adapter 任务失败: {}", error))
        .and_then(|result| result);

        match refresh_result {
            Ok(updated) => {
                clear_attempt_backoff(&key);
                refreshed_any = true;
                if current_id.as_deref() == Some(updated.id.as_str()) {
                    let updated_id = updated.id.clone();
                    if let Err(err) = platform_adapter::call_cursor_with_timeout::<()>(
                        "switch.injectDefaultProfile",
                        serde_json::json!({ "accountId": updated_id }),
                        Duration::from_secs(20),
                    ) {
                        logger::log_warn(&format!(
                            "[TokenKeeper][Cursor] 当前本地登录回写失败: account_id={}, error={}",
                            updated.id, err
                        ));
                    }
                }
                logger::log_info(&format!(
                    "[TokenKeeper][Cursor] Token 保活成功: account_id={}, email={}",
                    updated.id, updated.email
                ));
            }
            Err(err) => {
                mark_attempt_failure(&key);
                logger::log_warn(&format!(
                    "[TokenKeeper][Cursor] Token 保活失败，进入退避: account_id={}, error={}",
                    account.id, err
                ));
            }
        }
    }

    refreshed_any
}

async fn refresh_due_gemini_accounts() -> bool {
    if !platform_package::is_platform_package_installed("gemini") {
        return false;
    }

    let accounts: Vec<crate::models::gemini::GeminiAccount> =
        match platform_adapter::call_gemini_with_timeout(
            "accounts.list",
            serde_json::json!({}),
            Duration::from_secs(20),
        ) {
            Ok(accounts) => accounts,
            Err(err) => {
                logger::log_warn(&format!(
                    "[TokenKeeper][Gemini] 读取账号列表失败，跳过本轮保活: {}",
                    err
                ));
                return false;
            }
        };

    let current_id: Option<String> = platform_adapter::call_gemini_with_timeout(
        "accounts.current",
        serde_json::json!({}),
        Duration::from_secs(20),
    )
    .unwrap_or(None);
    let mut refreshed_any = false;
    let mut refresh_attempts = 0usize;

    for account in accounts {
        if !expires_at_milliseconds_due(account.expiry_date) {
            continue;
        }

        let key = format!("gemini:{}", account.id);
        if !allow_attempt(&key) {
            continue;
        }
        if refresh_attempts >= TOKEN_KEEPER_MAX_REFRESHES_PER_PLATFORM {
            logger::log_info("[TokenKeeper][Gemini] 本轮达到保活处理上限，剩余账号延后处理");
            break;
        }
        refresh_attempts += 1;

        let account_id = account.id.clone();
        let refresh_result = tauri::async_runtime::spawn_blocking(move || {
            platform_adapter::call_gemini_with_timeout::<crate::models::gemini::GeminiAccount>(
                "accounts.refresh",
                serde_json::json!({ "accountId": account_id }),
                Duration::from_secs(180),
            )
        })
        .await
        .map_err(|error| format!("Gemini adapter 任务失败: {}", error))
        .and_then(|result| result);

        match refresh_result {
            Ok(updated) => {
                clear_attempt_backoff(&key);
                refreshed_any = true;
                if current_id.as_deref() == Some(updated.id.as_str()) {
                    let updated_id = updated.id.clone();
                    if let Err(err) = platform_adapter::call_gemini_with_timeout::<()>(
                        "switch.injectDefaultProfile",
                        serde_json::json!({ "accountId": updated_id }),
                        Duration::from_secs(20),
                    ) {
                        logger::log_warn(&format!(
                            "[TokenKeeper][Gemini] 当前本地登录回写失败: account_id={}, error={}",
                            updated.id, err
                        ));
                    }
                }
                logger::log_info(&format!(
                    "[TokenKeeper][Gemini] Token 保活成功: account_id={}, email={}",
                    updated.id, updated.email
                ));
            }
            Err(err) => {
                mark_attempt_failure(&key);
                logger::log_warn(&format!(
                    "[TokenKeeper][Gemini] Token 保活失败，进入退避: account_id={}, error={}",
                    account.id, err
                ));
            }
        }
    }

    refreshed_any
}

async fn refresh_due_github_copilot_accounts() -> bool {
    if !platform_package::is_platform_package_installed("github-copilot") {
        return false;
    }

    let accounts = match tauri::async_runtime::spawn_blocking(|| {
        platform_adapter::call_github_copilot_with_timeout::<
            Vec<crate::models::github_copilot::GitHubCopilotAccount>,
        >(
            "accounts.list",
            serde_json::json!({}),
            Duration::from_secs(20),
        )
    })
    .await
    {
        Ok(Ok(accounts)) => accounts,
        Ok(Err(err)) => {
            logger::log_warn(&format!(
                "[TokenKeeper][GitHubCopilot] 读取账号列表失败，跳过本轮保活: {}",
                err
            ));
            return false;
        }
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][GitHubCopilot] 账号列表任务失败，跳过本轮保活: {}",
                err
            ));
            return false;
        }
    };

    let mut refreshed_any = false;
    let mut refresh_attempts = 0usize;
    for account in accounts {
        if !expires_at_seconds_due(account.copilot_expires_at) {
            continue;
        }

        let key = format!("github_copilot:{}", account.id);
        if !allow_attempt(&key) {
            continue;
        }
        if refresh_attempts >= TOKEN_KEEPER_MAX_REFRESHES_PER_PLATFORM {
            logger::log_info("[TokenKeeper][GitHubCopilot] 本轮达到保活处理上限，剩余账号延后处理");
            break;
        }
        refresh_attempts += 1;

        let account_id = account.id.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            platform_adapter::call_github_copilot_with_timeout::<
                crate::models::github_copilot::GitHubCopilotAccount,
            >(
                "accounts.refresh",
                serde_json::json!({ "accountId": account_id }),
                Duration::from_secs(180),
            )
        })
        .await
        {
            Ok(Ok(updated)) => {
                clear_attempt_backoff(&key);
                refreshed_any = true;
                logger::log_info(&format!(
                    "[TokenKeeper][GitHubCopilot] Token 保活成功: account_id={}, login={}",
                    updated.id, updated.github_login
                ));
            }
            Ok(Err(err)) => {
                mark_attempt_failure(&key);
                logger::log_warn(&format!(
                    "[TokenKeeper][GitHubCopilot] Token 保活失败，进入退避: account_id={}, error={}",
                    account.id, err
                ));
            }
            Err(err) => {
                mark_attempt_failure(&key);
                logger::log_warn(&format!(
                    "[TokenKeeper][GitHubCopilot] Token 保活任务失败，进入退避: account_id={}, error={}",
                    account.id, err
                ));
            }
        }
    }

    refreshed_any
}

async fn refresh_due_windsurf_accounts() -> bool {
    if !platform_package::is_platform_package_installed("windsurf") {
        return false;
    }

    let accounts =
        match tauri::async_runtime::spawn_blocking(|| {
            platform_adapter::call_windsurf_with_timeout::<
                Vec<crate::models::windsurf::WindsurfAccount>,
            >(
                "accounts.list",
                serde_json::json!({}),
                Duration::from_secs(20),
            )
        })
        .await
        {
            Ok(Ok(accounts)) => accounts,
            Ok(Err(err)) => {
                logger::log_warn(&format!(
                    "[TokenKeeper][Windsurf] 读取账号列表失败，跳过本轮保活: {}",
                    err
                ));
                return false;
            }
            Err(err) => {
                logger::log_warn(&format!(
                    "[TokenKeeper][Windsurf] 账号列表任务失败，跳过本轮保活: {}",
                    err
                ));
                return false;
            }
        };

    let current_id = match tauri::async_runtime::spawn_blocking(|| {
        platform_adapter::call_windsurf_with_timeout::<Option<String>>(
            "accounts.current",
            serde_json::json!({}),
            Duration::from_secs(20),
        )
    })
    .await
    {
        Ok(Ok(current_id)) => current_id,
        Ok(Err(err)) => {
            logger::log_warn(&format!(
                "[TokenKeeper][Windsurf] 读取当前账号失败，跳过本地回写: {}",
                err
            ));
            None
        }
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][Windsurf] 当前账号任务失败，跳过本地回写: {}",
                err
            ));
            None
        }
    };
    let mut refreshed_any = false;
    let mut refresh_attempts = 0usize;

    for account in accounts {
        if !expires_at_seconds_due(account.copilot_expires_at) {
            continue;
        }

        let key = format!("windsurf:{}", account.id);
        if !allow_attempt(&key) {
            continue;
        }
        if refresh_attempts >= TOKEN_KEEPER_MAX_REFRESHES_PER_PLATFORM {
            logger::log_info("[TokenKeeper][Windsurf] 本轮达到保活处理上限，剩余账号延后处理");
            break;
        }
        refresh_attempts += 1;

        let account_id = account.id.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            platform_adapter::call_windsurf_with_timeout::<crate::models::windsurf::WindsurfAccount>(
                "accounts.refresh",
                serde_json::json!({ "accountId": account_id }),
                Duration::from_secs(180),
            )
        })
        .await
        {
            Ok(Ok(updated)) => {
                clear_attempt_backoff(&key);
                refreshed_any = true;
                if current_id.as_deref() == Some(updated.id.as_str()) {
                    let updated_id = updated.id.clone();
                    match tauri::async_runtime::spawn_blocking(move || {
                        platform_adapter::call_windsurf_with_timeout::<Value>(
                            "switch.injectDefaultProfile",
                            serde_json::json!({ "accountId": updated_id }),
                            Duration::from_secs(20),
                        )
                    })
                    .await
                    {
                        Ok(Ok(_)) => {}
                        Ok(Err(err)) => {
                            logger::log_warn(&format!(
                                "[TokenKeeper][Windsurf] 当前本地登录回写失败: account_id={}, error={}",
                                updated.id, err
                            ));
                        }
                        Err(err) => logger::log_warn(&format!(
                            "[TokenKeeper][Windsurf] 当前本地登录回写任务失败: account_id={}, error={}",
                            updated.id, err
                        )),
                    }
                }
                logger::log_info(&format!(
                    "[TokenKeeper][Windsurf] Token 保活成功: account_id={}, login={}",
                    updated.id, updated.github_login
                ));
            }
            Ok(Err(err)) => {
                mark_attempt_failure(&key);
                logger::log_warn(&format!(
                    "[TokenKeeper][Windsurf] Token 保活失败，进入退避: account_id={}, error={}",
                    account.id, err
                ));
            }
            Err(err) => {
                mark_attempt_failure(&key);
                logger::log_warn(&format!(
                    "[TokenKeeper][Windsurf] Token 保活任务失败，进入退避: account_id={}, error={}",
                    account.id, err
                ));
            }
        }
    }

    refreshed_any
}

async fn refresh_due_kiro_accounts() -> bool {
    if !platform_package::is_platform_package_runtime_ready("kiro") {
        return false;
    }

    match platform_adapter::call_kiro_with_timeout::<i32>(
        "accounts.keepaliveDue",
        serde_json::json!({}),
        Duration::from_secs(180),
    ) {
        Ok(count) => count > 0,
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][Kiro] adapter 保活失败，跳过本轮: {}",
                err
            ));
            false
        }
    }
}

async fn refresh_due_codebuddy_accounts() -> bool {
    if !platform_package::is_platform_package_installed("codebuddy") {
        return false;
    }

    let accounts = match platform_adapter::call_codebuddy::<
        Vec<crate::models::codebuddy::CodebuddyAccount>,
    >("accounts.list", serde_json::json!({}))
    {
        Ok(accounts) => accounts,
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][CodeBuddy] 读取账号列表失败，跳过本轮保活: {}",
                err
            ));
            return false;
        }
    };

    let current_id = match platform_adapter::call_codebuddy::<Option<String>>(
        "accounts.current",
        serde_json::json!({}),
    ) {
        Ok(current_id) => current_id,
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][CodeBuddy] 读取当前账号失败，跳过默认登录态回写: {}",
                err
            ));
            None
        }
    };
    let mut refreshed_any = false;
    let mut refresh_attempts = 0usize;

    for account in accounts {
        if !expires_at_seconds_due(account.expires_at) {
            continue;
        }

        let key = format!("codebuddy:{}", account.id);
        if !allow_attempt(&key) {
            continue;
        }
        if refresh_attempts >= TOKEN_KEEPER_MAX_REFRESHES_PER_PLATFORM {
            logger::log_info("[TokenKeeper][CodeBuddy] 本轮达到保活处理上限，剩余账号延后处理");
            break;
        }
        refresh_attempts += 1;

        match platform_adapter::call_codebuddy::<crate::models::codebuddy::CodebuddyAccount>(
            "accounts.refresh",
            serde_json::json!({ "accountId": account.id }),
        ) {
            Ok(updated) => {
                clear_attempt_backoff(&key);
                refreshed_any = true;
                if current_id.as_deref() == Some(updated.id.as_str()) {
                    if let Err(err) = platform_adapter::call_codebuddy::<serde_json::Value>(
                        "switch.injectDefaultProfile",
                        serde_json::json!({ "accountId": updated.id }),
                    ) {
                        logger::log_warn(&format!(
                            "[TokenKeeper][CodeBuddy] 当前本地登录回写失败: account_id={}, error={}",
                            updated.id, err
                        ));
                    }
                }
                logger::log_info(&format!(
                    "[TokenKeeper][CodeBuddy] Token 保活成功: account_id={}, email={}",
                    updated.id, updated.email
                ));
            }
            Err(err) => {
                mark_attempt_failure(&key);
                logger::log_warn(&format!(
                    "[TokenKeeper][CodeBuddy] Token 保活失败，进入退避: account_id={}, error={}",
                    account.id, err
                ));
            }
        }
    }

    refreshed_any
}

async fn refresh_due_codebuddy_cn_accounts() -> bool {
    if !platform_package::is_platform_package_installed("codebuddy_cn") {
        return false;
    }

    let accounts = match platform_adapter::call_codebuddy_cn::<
        Vec<crate::models::codebuddy::CodebuddyAccount>,
    >("accounts.list", serde_json::json!({}))
    {
        Ok(accounts) => accounts,
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][CodeBuddyCN] 读取账号列表失败，跳过本轮保活: {}",
                err
            ));
            return false;
        }
    };

    let current_id = match platform_adapter::call_codebuddy_cn::<Option<String>>(
        "accounts.current",
        serde_json::json!({}),
    ) {
        Ok(current_id) => current_id,
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][CodeBuddyCN] 读取当前账号失败，跳过默认登录态回写: {}",
                err
            ));
            None
        }
    };
    let mut refreshed_any = false;
    let mut refresh_attempts = 0usize;

    for account in accounts {
        if !expires_at_seconds_due(account.expires_at) {
            continue;
        }

        let key = format!("codebuddy_cn:{}", account.id);
        if !allow_attempt(&key) {
            continue;
        }
        if refresh_attempts >= TOKEN_KEEPER_MAX_REFRESHES_PER_PLATFORM {
            logger::log_info("[TokenKeeper][CodeBuddyCN] 本轮达到保活处理上限，剩余账号延后处理");
            break;
        }
        refresh_attempts += 1;

        match platform_adapter::call_codebuddy_cn::<crate::models::codebuddy::CodebuddyAccount>(
            "accounts.refresh",
            serde_json::json!({ "accountId": account.id }),
        ) {
            Ok(updated) => {
                clear_attempt_backoff(&key);
                refreshed_any = true;
                if current_id.as_deref() == Some(updated.id.as_str()) {
                    if let Err(err) = platform_adapter::call_codebuddy_cn::<serde_json::Value>(
                        "switch.injectDefaultProfile",
                        serde_json::json!({ "accountId": updated.id }),
                    ) {
                        logger::log_warn(&format!(
                            "[TokenKeeper][CodeBuddyCN] 当前本地登录回写失败: account_id={}, error={}",
                            updated.id, err
                        ));
                    }
                }
                logger::log_info(&format!(
                    "[TokenKeeper][CodeBuddyCN] Token 保活成功: account_id={}, email={}",
                    updated.id, updated.email
                ));
            }
            Err(err) => {
                mark_attempt_failure(&key);
                logger::log_warn(&format!(
                    "[TokenKeeper][CodeBuddyCN] Token 保活失败，进入退避: account_id={}, error={}",
                    account.id, err
                ));
            }
        }
    }

    refreshed_any
}

async fn refresh_due_workbuddy_accounts() -> bool {
    if !platform_package::is_platform_package_runtime_ready("workbuddy") {
        return false;
    }

    let accounts = match platform_adapter::call_workbuddy::<
        Vec<crate::models::workbuddy::WorkbuddyAccount>,
    >("accounts.list", serde_json::json!({}))
    {
        Ok(accounts) => accounts,
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][WorkBuddy] 读取账号列表失败，跳过本轮保活: {}",
                err
            ));
            return false;
        }
    };

    let current_id = match platform_adapter::call_workbuddy::<Option<String>>(
        "accounts.current",
        serde_json::json!({}),
    ) {
        Ok(value) => value,
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][WorkBuddy] 读取当前账号失败，跳过本轮保活: {}",
                err
            ));
            return false;
        }
    };
    let mut refreshed_any = false;
    let mut refresh_attempts = 0usize;

    for account in accounts {
        if !expires_at_seconds_due(account.expires_at) {
            continue;
        }

        let key = format!("workbuddy:{}", account.id);
        if !allow_attempt(&key) {
            continue;
        }
        if refresh_attempts >= TOKEN_KEEPER_MAX_REFRESHES_PER_PLATFORM {
            logger::log_info("[TokenKeeper][WorkBuddy] 本轮达到保活处理上限，剩余账号延后处理");
            break;
        }
        refresh_attempts += 1;

        match platform_adapter::call_workbuddy::<crate::models::workbuddy::WorkbuddyAccount>(
            "accounts.refresh",
            serde_json::json!({ "accountId": account.id }),
        ) {
            Ok(updated) => {
                clear_attempt_backoff(&key);
                refreshed_any = true;
                if current_id.as_deref() == Some(updated.id.as_str()) {
                    if let Err(err) = platform_adapter::call_workbuddy::<serde_json::Value>(
                        "switch.injectDefaultProfile",
                        serde_json::json!({ "accountId": updated.id }),
                    ) {
                        logger::log_warn(&format!(
                            "[TokenKeeper][WorkBuddy] 当前本地登录回写失败: account_id={}, error={}",
                            updated.id, err
                        ));
                    }
                }
                logger::log_info(&format!(
                    "[TokenKeeper][WorkBuddy] Token 保活成功: account_id={}, email={}",
                    updated.id, updated.email
                ));
            }
            Err(err) => {
                mark_attempt_failure(&key);
                logger::log_warn(&format!(
                    "[TokenKeeper][WorkBuddy] Token 保活失败，进入退避: account_id={}, error={}",
                    account.id, err
                ));
            }
        }
    }

    refreshed_any
}

async fn refresh_due_trae_accounts() -> bool {
    if !platform_package::is_platform_package_installed("trae") {
        return false;
    }

    let accounts: Vec<crate::models::trae::TraeAccount> = match call_trae_adapter(
        "accounts.list",
        serde_json::json!({}),
        Duration::from_secs(20),
    )
    .await
    {
        Ok(accounts) => accounts,
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][Trae] 读取账号列表失败，跳过本轮保活: {}",
                err
            ));
            return false;
        }
    };

    let current_id: Option<String> = match call_trae_adapter(
        "accounts.current",
        serde_json::json!({}),
        Duration::from_secs(20),
    )
    .await
    {
        Ok(current_id) => current_id,
        Err(err) => {
            logger::log_warn(&format!(
                "[TokenKeeper][Trae] 读取当前账号失败，跳过本地回写: {}",
                err
            ));
            None
        }
    };
    let mut refreshed_any = false;
    let mut refresh_attempts = 0usize;

    for account in accounts {
        let refresh_due = match call_trae_adapter::<bool>(
            "accounts.shouldRefreshToken",
            serde_json::json!({ "accountId": account.id.clone() }),
            Duration::from_secs(20),
        )
        .await
        {
            Ok(value) => value,
            Err(err) => {
                let key = format!("trae_refresh:{}", account.id);
                mark_attempt_failure(&key);
                logger::log_warn(&format!(
                    "[TokenKeeper][Trae] 判断 Token 保活窗口失败，进入退避: account_id={}, error={}",
                    account.id, err
                ));
                continue;
            }
        };

        if refresh_due {
            let key = format!("trae_refresh:{}", account.id);
            if !allow_attempt(&key) {
                continue;
            }
            if refresh_attempts >= TOKEN_KEEPER_MAX_REFRESHES_PER_PLATFORM {
                logger::log_info("[TokenKeeper][Trae] 本轮达到保活处理上限，剩余账号延后处理");
                break;
            }
            refresh_attempts += 1;

            let account_id = account.id.clone();
            match call_trae_adapter::<crate::models::trae::TraeAccount>(
                "accounts.refresh",
                serde_json::json!({ "accountId": account_id }),
                Duration::from_secs(180),
            )
            .await
            {
                Ok(updated) => {
                    clear_attempt_backoff(&key);
                    mark_trae_strict_check_done(updated.id.as_str());
                    refreshed_any = true;
                    if current_id.as_deref() == Some(updated.id.as_str()) {
                        let updated_id = updated.id.clone();
                        if let Err(err) = call_trae_adapter::<Value>(
                            "switch.injectDefaultProfile",
                            serde_json::json!({ "accountId": updated_id }),
                            Duration::from_secs(20),
                        )
                        .await
                        {
                            logger::log_warn(&format!(
                                "[TokenKeeper][Trae] 当前本地登录回写失败: account_id={}, error={}",
                                updated.id, err
                            ));
                        }
                    }
                    logger::log_info(&format!(
                        "[TokenKeeper][Trae] Token 保活成功: account_id={}, email={}",
                        updated.id, updated.email
                    ));
                }
                Err(err) => {
                    mark_attempt_failure(&key);
                    logger::log_warn(&format!(
                        "[TokenKeeper][Trae] Token 保活失败，进入退避: account_id={}, error={}",
                        account.id, err
                    ));
                }
            }
            continue;
        }

        if current_id.as_deref() != Some(account.id.as_str()) {
            continue;
        }
        if !should_run_trae_strict_check(account.id.as_str()) {
            continue;
        }

        let strict_key = format!("trae_strict:{}", account.id);
        if !allow_attempt(&strict_key) {
            continue;
        }

        match call_trae_adapter::<TraeCheckLoginVerdict>(
            "accounts.checkLogin",
            serde_json::json!({ "accountId": account.id.clone() }),
            Duration::from_secs(60),
        )
        .await
        {
            Ok(verdict) => {
                clear_attempt_backoff(&strict_key);
                mark_trae_strict_check_done(account.id.as_str());
                if verdict.is_valid {
                    logger::log_info(&format!(
                        "[TokenKeeper][Trae] 严格校验通过: account_id={}",
                        account.id
                    ));
                } else {
                    logger::log_warn(&format!(
                        "[TokenKeeper][Trae] 严格校验未通过: account_id={}, error_code={}, is_login={}",
                        account.id,
                        verdict.error_code.as_deref().unwrap_or("-"),
                        verdict
                            .is_login
                            .map(|value| if value { "true" } else { "false" })
                            .unwrap_or("-")
                    ));
                }
            }
            Err(err) => {
                mark_attempt_failure(&strict_key);
                logger::log_warn(&format!(
                    "[TokenKeeper][Trae] 严格校验失败，进入退避: account_id={}, error={}",
                    account.id, err
                ));
            }
        }
    }

    refreshed_any
}
