#[derive(serde::Serialize)]
struct HidDeviceSummary {
    path: String,
    vendor_id: u16,
    product_id: u16,
    product: Option<String>,
    manufacturer: Option<String>,
}

#[tauri::command]
fn list_hid_devices() -> Result<Vec<HidDeviceSummary>, String> {
    let api = hidapi::HidApi::new().map_err(|e| e.to_string())?;
    Ok(api
        .device_list()
        .filter(|d| {
            d.usage_page() == 0xff60
                || d.product_string()
                    .is_some_and(|p| p.contains("CAD Mouse MK2"))
        })
        .map(|d| HidDeviceSummary {
            path: d.path().to_string_lossy().into_owned(),
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            product: d.product_string().map(str::to_owned),
            manufacturer: d.manufacturer_string().map(str::to_owned),
        })
        .collect())
}

#[tauri::command]
fn get_hid_feature(path: String) -> Result<Vec<u8>, String> {
    let api = hidapi::HidApi::new().map_err(|e| e.to_string())?;
    let path = CString::new(path).map_err(|_| "Invalid HID path".to_owned())?;
    let device = api.open_path(path.as_c_str()).map_err(|e| e.to_string())?;
    let mut report = [0u8; 65];
    report[0] = 0x10;
    let len = device
        .get_feature_report(&mut report)
        .map_err(|e| e.to_string())?;
    Ok(report[1..len.min(65)].to_vec())
}

#[tauri::command]
fn set_hid_feature(path: String, payload: Vec<u8>) -> Result<(), String> {
    if payload.len() != 64 {
        return Err("Feature payload must be exactly 64 bytes".into());
    }
    let api = hidapi::HidApi::new().map_err(|e| e.to_string())?;
    let path = CString::new(path).map_err(|_| "Invalid HID path".to_owned())?;
    let device = api.open_path(path.as_c_str()).map_err(|e| e.to_string())?;
    let mut report = [0u8; 65];
    report[0] = 0x10;
    report[1..].copy_from_slice(&payload);
    device
        .send_feature_report(&report)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            list_hid_devices,
            get_hid_feature,
            set_hid_feature
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
use std::ffi::CString;
