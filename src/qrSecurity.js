const crypto = require('crypto');
const { authenticator } = require('otplib');

// 1. Set TOTP standar industri: Durasi 30 detik & Toleransi 1 window (sebelum/sesudah)
authenticator.options = { 
  step: 30, 
  window: 1 
};

const MASTER_SECRET = process.env.QR_MASTER_SECRET || 'ganti_dengan_32_character_secret_key_bebas';

// Storage sementara di memori untuk mencatat scan per User ID (Mencegah double scan karyawan yang sama)
const userScanTracker = new Map();

/**
 * Membangkitkan Payload QR Code Dinamis
 */
function generateSecureQRPayload() {
  const timestamp = Date.now();
  const totpToken = authenticator.generate(MASTER_SECRET);

  const rawData = `${totpToken}:${timestamp}`;
  
  // Signature HMAC-SHA256 untuk otentikasi QR resmi
  const signature = crypto
    .createHmac('sha256', MASTER_SECRET)
    .update(rawData)
    .digest('hex');

  return JSON.stringify({
    token: totpToken,
    ts: timestamp,
    sig: signature
  });
}

/**
 * Memvalidasi QR Code dari HP Karyawan
 */
function verifyQRPayload(payloadString, userId) {
  try {
    const { token, ts, sig } = JSON.parse(payloadString);

    // Proteksi 1: Cek apakah Karyawan ini baru saja scan dalam 10 detik terakhir (Anti Double Click)
    const lastScanTime = userScanTracker.get(userId);
    if (lastScanTime && (Date.now() - lastScanTime < 10000)) {
      return { valid: false, message: 'Anda baru saja melakukan scan. Harap tunggu beberapa detik.' };
    }

    // Proteksi 2: Cek Umur Payload QR (Maksimal selisih 60 detik agar tidak menggunakan foto QR lama)
    if (Math.abs(Date.now() - ts) > 60000) {
      return { valid: false, message: 'QR Code di layar sudah berganti. Silakan scan QR terbaru.' };
    }

    // Proteksi 3: Verifikasi HMAC Signature (Mencegah pemalsuan QR)
    const rawData = `${token}:${ts}`;
    const expectedSig = crypto
      .createHmac('sha256', MASTER_SECRET)
      .update(rawData)
      .digest('hex');

    if (sig !== expectedSig) {
      return { valid: false, message: 'Signature QR Code tidak sah / palsu!' };
    }

    // Proteksi 4: Verifikasi TOTP Token dengan Toleransi Window
    const isTotpValid = authenticator.check(token, MASTER_SECRET);
    if (!isTotpValid) {
      return { valid: false, message: 'QR Code telah kadaluarsa. Silakan scan ulang.' };
    }

    // Catat waktu scan sukses karyawan ini
    userScanTracker.set(userId, Date.now());

    // Bersihkan tracker otomatis setelah 1 menit
    setTimeout(() => userScanTracker.delete(userId), 60000);

    return { valid: true };
  } catch (err) {
    return { valid: false, message: 'Format QR Code tidak dapat dibaca.' };
  }
}

module.exports = {
  generateSecureQRPayload,
  verifyQRPayload
};