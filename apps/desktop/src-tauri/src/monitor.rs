//! Local system metrics: CPU / RAM / GPU / VRAM / uptime / addresses.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiService {
    pub name: String,
    pub running: bool,
    pub port: u16,
}

/// Well-known local AI service ports. Probed on 127.0.0.1 only.
const AI_SERVICES: &[(&str, u16)] = &[
    ("Ollama", 11434),
    ("Open WebUI", 3000),
    ("Open WebUI (alt)", 8080),
    ("ComfyUI", 8188),
    ("Jupyter", 8888),
    ("vLLM", 8000),
    ("LM Studio", 1234),
    ("SD WebUI", 7860),
];

fn probe_services() -> Vec<AiService> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = AI_SERVICES
            .iter()
            .map(|(name, port)| {
                scope.spawn(move || {
                    let addr: std::net::SocketAddr = ([127, 0, 0, 1], *port).into();
                    let running = std::net::TcpStream::connect_timeout(
                        &addr,
                        std::time::Duration::from_millis(150),
                    )
                    .is_ok();
                    AiService {
                        name: name.to_string(),
                        running,
                        port: *port,
                    }
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuMetrics {
    pub name: String,
    pub utilization_pct: u8,
    pub vram_used_mb: u64,
    pub vram_total_mb: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub host_name: String,
    pub os: String,
    pub cpu_pct: u8,
    pub ram_used_gb: f32,
    pub ram_total_gb: f32,
    pub uptime_secs: u64,
    pub gpu: Option<GpuMetrics>,
    pub mac: Option<String>,
    pub lan_ip: Option<String>,
    pub services: Vec<AiService>,
}

/// NVIDIA metrics via nvidia-smi (present on any NVIDIA driver install).
/// AMD/Intel GPU utilization reporting lands in a later release.
fn nvidia_gpu() -> Option<GpuMetrics> {
    let out = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout).trim().lines().next()?.to_string();
    let parts: Vec<&str> = line.split(',').map(|p| p.trim()).collect();
    if parts.len() < 4 {
        return None;
    }
    Some(GpuMetrics {
        name: parts[0].to_string(),
        utilization_pct: parts[1].parse().unwrap_or(0),
        vram_used_mb: parts[2].parse().unwrap_or(0),
        vram_total_mb: parts[3].parse().unwrap_or(0),
    })
}

pub fn collect() -> Metrics {
    let mut sys = sysinfo::System::new();
    sys.refresh_cpu_all();
    sys.refresh_memory();
    // CPU usage needs two samples; a short second read is acceptable here.
    std::thread::sleep(std::time::Duration::from_millis(120));
    sys.refresh_cpu_all();
    let cpu_pct = sys.global_cpu_usage() as u8;

    let ram_total_gb = (sys.total_memory() as f64 / 1_073_741_824.0) as f32;
    let ram_used_gb = (sys.used_memory() as f64 / 1_073_741_824.0) as f32;

    let mac = mac_address::get_mac_address()
        .ok()
        .flatten()
        .map(|m| m.to_string());

    Metrics {
        host_name: sysinfo::System::host_name().unwrap_or_else(|| "Computer".into()),
        os: std::env::consts::OS.into(),
        cpu_pct,
        ram_used_gb: (ram_used_gb * 10.0).round() / 10.0,
        ram_total_gb: ram_total_gb.round(),
        uptime_secs: sysinfo::System::uptime(),
        gpu: nvidia_gpu(),
        mac,
        lan_ip: crate::discovery::local_ip(),
        services: probe_services(),
    }
}
