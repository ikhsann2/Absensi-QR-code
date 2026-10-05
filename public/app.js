// 1. Registrasi Service Worker PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => console.log('Service Worker terdaftar:', reg.scope))
      .catch((err) => console.error('Gagal registrasi Service Worker:', err));
  });
}

// 2. Inisialisasi Database Lokal IndexedDB
let db;
const dbRequest = indexedDB.open('AbsensiOfflineDB', 1);

dbRequest.onupgradeneeded = (event) => {
  db = event.target.result;
  if (!db.objectStoreNames.contains('offlineScans')) {
    db.createObjectStore('offlineScans', { keyPath: 'id', autoIncrement: true });
  }
};

dbRequest.onsuccess = (event) => {
  db = event.target.result;
  if (navigator.onLine) syncDataOffline();
};

// 3. Pantau Status Internet
window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);

function updateNetworkStatus() {
  const statusBadge = document.getElementById('connectionStatus');
  if (statusBadge) {
    if (navigator.onLine) {
      statusBadge.className = 'badge online';
      statusBadge.innerText = 'Online';
      syncDataOffline();
    } else {
      statusBadge.className = 'badge offline';
      statusBadge.innerText = 'Offline Mode';
    }
  }
}

// 4. Pengelola Kamera Scanner QR
let html5QrCode = null;
let currentFacingMode = "environment"; // "environment" = Kamera Belakang
let isScanning = false;

// DIBUANG: listener DOMContentLoaded yang otomatis menyalakan kamera QR
// Kamera QR sekarang dinyalakan via tombol di index.html setelah foto lokasi diambil

function startCamera(facingMode) {
  if (html5QrCode && html5QrCode.isScanning) {
    html5QrCode.stop().then(() => {
      initScanner(facingMode);
    }).catch(err => console.error("Gagal menghentikan kamera:", err));
  } else {
    initScanner(facingMode);
  }
}

function initScanner(facingMode) {
  const readerEl = document.getElementById("reader");
  if (!readerEl) return;

  html5QrCode = new Html5Qrcode("reader");
  const config = { fps: 15, qrbox: { width: 220, height: 220 } };

  html5QrCode.start(
    { facingMode: facingMode },
    config,
    onScanSuccess
  ).then(() => {
    isScanning = true;
  }).catch((err) => {
    showAlert("Gagal membuka kamera QR. Pastikan izin kamera diberikan.", "error");
  });
}

function switchCamera() {
  const btn = document.getElementById("switchCamBtn");
  if (currentFacingMode === "environment") {
    currentFacingMode = "user";
    if (btn) btn.innerHTML = "📷 Gunakan Kamera Depan";
  } else {
    currentFacingMode = "environment";
    if (btn) btn.innerHTML = "📷 Gunakan Kamera Belakang";
  }
  startCamera(currentFacingMode);
}

// 5. Callback Saat QR Code Terdeteksi
async function onScanSuccess(decodedText) {
  if (!isScanning) return;
  isScanning = false;

  const userId = document.getElementById('userId').value.trim();
  if (!userId) {
    showAlert("Harap isi ID Guru/Karyawan terlebih dahulu!", "error");
    setTimeout(() => { isScanning = true; }, 2000);
    return;
  }

  // AMBIL FOTO BUKTI & LOKASI GPS DARI LOCALSTORAGE
  const proofPhoto = localStorage.getItem("cordova_proof_photo");
  const proofLocation = JSON.parse(localStorage.getItem("cordova_proof_location") || '{"lat":null,"lng":null}');

  // Proteksi Validasi GPS
  if (!proofLocation.lat || !proofLocation.lng) {
    showAlert("❌ Absen Ditolak! Lokasi GPS tidak ditemukan/belum diaktifkan.", "error");
    setTimeout(() => { window.location.reload(); }, 2500);
    return;
  }

  showAlert("⚡ Mengirim data absensi, lokasi GPS & foto bukti ke WhatsApp Group...", "info");

  const payload = {
    userId: userId,
    qrToken: decodedText,
    proofPhoto: proofPhoto,
    location: proofLocation,
    timestamp: Date.now()
  };

  if (navigator.onLine) {
    await sendAttendanceToBackend(payload);
  } else {
    saveToIndexedDB(payload);
  }

  setTimeout(() => {
    isScanning = true;
  }, 3000);
}

// 6. Kirim Data Absensi ke Backend / Database
async function sendAttendanceToBackend(payload) {
  try {
    const res = await fetch('/api/attendance/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await res.json();

    if (result.success) {
      showAlert(`✅ ${result.message}`, "success");
      // Hapus cache bukti sementara
      localStorage.removeItem("cordova_proof_photo");
      localStorage.removeItem("cordova_proof_location");
      
      // Matikan scanner
      if (html5QrCode) html5QrCode.stop();
      
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    } else {
      showAlert(`❌ ${result.message}`, "error");
    }
  } catch (err) {
    saveToIndexedDB(payload);
  }
}

// Simpan Lokal saat Offline
function saveToIndexedDB(payload) {
  if (!db) return;
  payload.isOfflineSync = true;

  const tx = db.transaction('offlineScans', 'readwrite');
  const store = tx.objectStore('offlineScans');
  store.add(payload);

  showAlert("⚠️ Koneksi Offline: Data tersimpan di HP dan akan masuk database server saat online.", "info");
}

// Sinkronkan Data Offline saat Online Kembali
function syncDataOffline() {
  if (!db) return;
  const tx = db.transaction('offlineScans', 'readwrite');
  const store = tx.objectStore('offlineScans');
  const getAllRequest = store.getAll();

  getAllRequest.onsuccess = async () => {
    const records = getAllRequest.result;
    if (records.length === 0) return;

    for (const record of records) {
      const { id, ...dataToSend } = record;
      await sendAttendanceToBackend(dataToSend);
    }

    const clearTx = db.transaction('offlineScans', 'readwrite');
    clearTx.objectStore('offlineScans').clear();
  };
}

// Helper Tampilan Pesan Status (Disesuaikan dengan index.html)
function showAlert(message, type) {
  const resDiv = document.getElementById('result');
  if (resDiv) {
    resDiv.className = `alert alert-${type}`;
    resDiv.innerText = message;
    resDiv.style.display = "block";
  }
}