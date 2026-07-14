use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WslNetworkingMode {
    Mirrored,
    Nat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslAccessPlan {
    pub distro: String,
    pub mode: WslNetworkingMode,
    pub client_host: String,
    pub relay_bind_host: Option<Ipv4Addr>,
}

#[cfg(target_os = "windows")]
const WSL_COMMAND_TIMEOUT: Duration = Duration::from_secs(3);

/// Return the WSL distribution name from a Windows UNC path.
///
/// Both `\\wsl.localhost\\Distro\\...` and the legacy `\\wsl$\\Distro\\...`
/// forms are accepted. The parser intentionally rejects ordinary UNC shares.
pub fn parse_wsl_distro_from_path_text(raw: &str) -> Option<String> {
    let normalized = raw.trim().replace('\\', "/");
    let without_prefix = normalized
        .strip_prefix("//")
        .or_else(|| normalized.strip_prefix("/"))?;
    let mut parts = without_prefix.split('/');
    let host = parts.next()?.trim();
    if !host.eq_ignore_ascii_case("wsl.localhost") && !host.eq_ignore_ascii_case("wsl$") {
        return None;
    }
    let distro = parts.next()?.trim();
    if distro.is_empty() {
        None
    } else {
        Some(distro.to_string())
    }
}

pub fn parse_networking_mode(raw: &str) -> Option<WslNetworkingMode> {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.contains("mirrored") {
        Some(WslNetworkingMode::Mirrored)
    } else if normalized.contains("nat") {
        Some(WslNetworkingMode::Nat)
    } else {
        None
    }
}

pub fn parse_default_gateway(raw: &str) -> Option<Ipv4Addr> {
    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        while let Some(part) = parts.next() {
            if part == "via" {
                let candidate = parts.next()?.parse::<Ipv4Addr>().ok()?;
                if !candidate.is_unspecified() && !candidate.is_loopback() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
async fn run_wsl_command(distro: &str, args: &[&str]) -> Result<String, String> {
    use std::process::Stdio;
    use tokio::process::Command;
    use tokio::time::timeout;

    let mut command = Command::new("wsl.exe");
    command
        .arg("-d")
        .arg(distro)
        .arg("--")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.kill_on_drop(true);
    command.creation_flags(0x08000000);

    let output = timeout(WSL_COMMAND_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("执行 WSL 命令超时: distro={distro}, command={args:?}"))?
        .map_err(|error| format!("执行 WSL 命令失败: distro={distro}, error={error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "WSL 命令返回失败: distro={distro}, status={}, stderr={}",
            output.status,
            if stderr.is_empty() { "-" } else { &stderr }
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(not(target_os = "windows"))]
async fn run_wsl_command(_distro: &str, _args: &[&str]) -> Result<String, String> {
    Err("WSL 自动适配仅支持 Windows 宿主".to_string())
}

pub fn configured_wsl_config_dir() -> Option<PathBuf> {
    #[cfg(not(target_os = "windows"))]
    {
        None
    }

    #[cfg(target_os = "windows")]
    {
        let config = crate::modules::config::get_user_config();
        if !config.codex_sync_wsl {
            return None;
        }
        let path = config.codex_wsl_config_dir.trim();
        if path.is_empty() || parse_wsl_distro_from_path_text(path).is_none() {
            return None;
        }
        Some(PathBuf::from(path))
    }
}

pub async fn resolve_access_plan(
    config_dir: &Path,
    use_loopback_relay: bool,
) -> Result<WslAccessPlan, String> {
    let config_text = config_dir.to_string_lossy();
    let distro = parse_wsl_distro_from_path_text(&config_text)
        .ok_or_else(|| format!("不是受支持的 WSL 配置路径: {}", config_dir.display()))?;

    let mode = match run_wsl_command(&distro, &["wslinfo", "--networking-mode"]).await {
        Ok(output) => parse_networking_mode(&output).unwrap_or(WslNetworkingMode::Nat),
        Err(_) => WslNetworkingMode::Nat,
    };
    if mode == WslNetworkingMode::Mirrored {
        return Ok(WslAccessPlan {
            distro,
            mode,
            client_host: "localhost".to_string(),
            relay_bind_host: None,
        });
    }

    let route = run_wsl_command(&distro, &["sh", "-lc", "ip route show default"]).await?;
    let gateway = parse_default_gateway(&route)
        .ok_or_else(|| format!("无法解析 WSL 默认网关: distro={distro}, output={route:?}"))?;
    Ok(WslAccessPlan {
        distro,
        mode,
        client_host: gateway.to_string(),
        relay_bind_host: use_loopback_relay.then_some(gateway),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_unc_paths() {
        assert_eq!(
            parse_wsl_distro_from_path_text(r"\\wsl.localhost\Ubuntu-24.04\home\user\.codex"),
            Some("Ubuntu-24.04".to_string())
        );
        assert_eq!(
            parse_wsl_distro_from_path_text(r"\\wsl$\Ubuntu\home\user\.codex"),
            Some("Ubuntu".to_string())
        );
        assert_eq!(
            parse_wsl_distro_from_path_text("//WSL.LOCALHOST/Debian/home/user/.codex"),
            Some("Debian".to_string())
        );
        assert_eq!(
            parse_wsl_distro_from_path_text(r"\\server\share\.codex"),
            None
        );
    }

    #[test]
    fn parses_network_mode_and_default_route() {
        assert_eq!(
            parse_networking_mode("mirrored\n"),
            Some(WslNetworkingMode::Mirrored)
        );
        assert_eq!(parse_networking_mode("NAT"), Some(WslNetworkingMode::Nat));
        assert_eq!(
            parse_default_gateway("default via 172.29.64.1 dev eth0 proto kernel\n"),
            Some(Ipv4Addr::new(172, 29, 64, 1))
        );
        assert_eq!(parse_default_gateway("default dev eth0"), None);
    }
}
