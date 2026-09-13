use super::{load_index_from_paths, sample_account, TestDir};
use crate::models::grok::GrokAccount;
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::OsRng, Rng};
use std::{fs, path::Path};

fn load_or_create_key(root: &Path) -> [u8; 32] {
    let path = root.join("secure-account-storage.key");
    if path.exists() {
        return STANDARD
            .decode(fs::read_to_string(path).unwrap().trim())
            .unwrap()
            .try_into()
            .unwrap();
    }

    let mut rng = OsRng;
    let key: [u8; 32] = rng.gen();
    fs::write(path, STANDARD.encode(key)).unwrap();
    key
}

fn seed(root: &Path, id: &str, encrypted: bool) -> GrokAccount {
    let mut account = sample_account();
    account.id = id.into();
    let details = root.join("grok_accounts");
    fs::create_dir_all(&details).unwrap();
    let plain = serde_json::to_string(&account).unwrap();
    let content = if encrypted {
        let mut rng = OsRng;
        let key = load_or_create_key(root);
        let nonce: [u8; 12] = rng.gen();
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
            .unwrap();
        serde_json::json!({
            "version": 1, "kind": "grok", "algorithm": "AES-256-GCM",
            "key_id": "local-secure-account-storage-v1", "nonce": STANDARD.encode(nonce),
            "ciphertext": STANDARD.encode(ciphertext), "encrypted_at": 1
        })
        .to_string()
    } else {
        plain
    };
    fs::write(details.join(format!("{id}.json")), content).unwrap();
    account
}

#[test]
fn missing_empty_and_corrupt_indexes_recover_plain_and_encrypted_without_writes() {
    for raw in [
        None,
        Some(""),
        Some("{invalid-json"),
        Some(r#"{"version":"1.0","accounts":[]}"#),
    ] {
        let temp = TestDir::new();
        seed(&temp.0, "real-1", true);
        seed(&temp.0, "real-2", false);
        let index_path = temp.0.join("grok_accounts.json");
        if let Some(raw) = raw {
            fs::write(&index_path, raw).unwrap();
        }
        let detail = temp.0.join("grok_accounts/real-1.json");
        let before = fs::read(&detail).unwrap();
        let index = load_index_from_paths(&index_path, &temp.0.join("grok_accounts")).unwrap();
        assert_eq!(index.accounts.len(), 2);
        assert_eq!(fs::read_to_string(&index_path).ok().as_deref(), raw);
        assert_eq!(
            fs::read(&detail).unwrap(),
            before,
            "no key rotation in recovery"
        );
    }
}

#[test]
fn unavailable_or_wrong_key_does_not_create_key_or_replace_index() {
    for missing in [true, false] {
        let temp = TestDir::new();
        seed(&temp.0, "real-1", true);
        let key = temp.0.join("secure-account-storage.key");
        if missing {
            fs::remove_file(&key).unwrap();
        } else {
            let mut wrong_key = STANDARD
                .decode(fs::read_to_string(&key).unwrap().trim())
                .unwrap();
            wrong_key[0] ^= 0xff;
            fs::write(&key, STANDARD.encode(wrong_key)).unwrap();
        }
        let index = temp.0.join("grok_accounts.json");
        fs::write(&index, "{broken").unwrap();
        assert!(load_index_from_paths(&index, &temp.0.join("grok_accounts")).is_err());
        assert_eq!(fs::read_to_string(&index).unwrap(), "{broken");
        assert_eq!(key.exists(), !missing);
    }
}

#[test]
fn partial_corruption_never_silently_drops_an_account() {
    let temp = TestDir::new();
    seed(&temp.0, "real-1", true);
    fs::write(temp.0.join("grok_accounts/real-2.json"), "{broken").unwrap();
    let index = temp.0.join("grok_accounts.json");
    assert!(load_index_from_paths(&index, &temp.0.join("grok_accounts")).is_err());
    assert!(!index.exists());
}

#[test]
fn encrypted_backup_is_read_without_overwriting_damaged_detail() {
    let temp = TestDir::new();
    seed(&temp.0, "real-1", true);
    let detail = temp.0.join("grok_accounts/real-1.json");
    fs::copy(&detail, detail.with_extension("json.bak")).unwrap();
    fs::write(&detail, "{broken").unwrap();
    let index = load_index_from_paths(
        &temp.0.join("grok_accounts.json"),
        &temp.0.join("grok_accounts"),
    )
    .unwrap();
    assert_eq!(index.accounts.len(), 1);
    assert_eq!(fs::read_to_string(&detail).unwrap(), "{broken");
}

#[test]
fn fixture_filter_preserves_real_accounts_and_never_deletes_files() {
    let temp = TestDir::new();
    seed(&temp.0, "account-1", true);
    seed(&temp.0, "real-1", true);
    let index = load_index_from_paths(
        &temp.0.join("grok_accounts.json"),
        &temp.0.join("grok_accounts"),
    )
    .unwrap();
    assert_eq!(index.accounts.len(), 1);
    assert_eq!(index.accounts[0].id, "real-1");
    assert!(temp.0.join("grok_accounts/account-1.json").exists());
}

#[test]
fn valid_index_is_not_replaced_by_a_directory_scan() {
    let temp = TestDir::new();
    let account = seed(&temp.0, "real-1", true);
    seed(&temp.0, "orphan", true);
    let path = temp.0.join("grok_accounts.json");
    let raw = serde_json::json!({"version":"1.0", "accounts":[account.summary()]}).to_string();
    fs::write(&path, &raw).unwrap();
    let index = load_index_from_paths(&path, &temp.0.join("grok_accounts")).unwrap();
    assert_eq!(index.accounts.len(), 1);
    assert_eq!(fs::read_to_string(&path).unwrap(), raw);
}
