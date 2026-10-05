const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const isSSLEnabled = process.env.DB_SSL_ENABLE === 'true';

const poolConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432', 10),
};

// Pengaturan Enkripsi SSL jika aktif
if (isSSLEnabled) {
  poolConfig.ssl = {
    rejectUnauthorized: true, // Memvalidasi sertifikat di produksi
    ca: fs.readFileSync(path.join(__dirname, '../certs/root.crt')).toString(),
  };
}

const pool = new Pool(poolConfig);

pool.on('connect', () => {
  console.log('Terhubung ke database PostgreSQL.');
});

pool.on('error', (err) => {
  console.error('Koneksi PostgreSQL Error:', err);
});

module.exports = pool;