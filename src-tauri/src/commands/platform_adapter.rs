use std::time::Duration;

use serde_json::{Map, Value};

use crate::modules::platform_adapter;

const DEFAULT_PLATFORM_ADAPTER_CALL_TIMEOUT_MS: u64 = 30_000;
const MAX_PLATFORM_ADAPTER_CALL_TIMEOUT_MS: u64 = 10 * 60 * 1000;

fn normalize_platform_adapter_timeout(timeout_ms: Option<u64>) -> Duration {
    let timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_PLATFORM_ADAPTER_CALL_TIMEOUT_MS)
        .clamp(1_000, MAX_PLATFORM_ADAPTER_CALL_TIMEOUT_MS);
    Duration::from_millis(timeout_ms)
}

#[tauri::command]
pub async fn platform_adapter_call(
    platform_id: String,
    method: String,
    payload: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let platform_id = platform_id.trim().to_string();
    let method = method.trim().to_string();
    let payload = payload.unwrap_or_else(|| Value::Object(Map::new()));
    let timeout = normalize_platform_adapter_timeout(timeout_ms);

    tauri::async_runtime::spawn_blocking(move || {
        platform_adapter::call_declared_platform_value_with_timeout(
            &platform_id,
            &method,
            payload,
            timeout,
        )
    })
    .await
    .map_err(|error| format!("平台 adapter 调用任务失败: {}", error))?
}
